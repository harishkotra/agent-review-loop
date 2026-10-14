import { bodyText, locateInOriginal, reanchor, normWs } from './anchoring.js'
import { computeChurn } from './diffing.js'
import {
  STALE_ANCHOR_STRING,
  CLAIM_MISMATCH_STRING,
  type AgentReport,
  type ClaimMismatch,
  type CommentVerdict,
  type MetricValue,
  type RunMetrics,
  type SdComment,
} from './types.js'

function snippet(text: string, start: number, end: number): string {
  const lo = Math.max(0, start - 40)
  const hi = Math.min(text.length, end + 40)
  return (lo > 0 ? '…' : '') + text.slice(lo, hi).replace(/\s+/g, ' ') + (hi < text.length ? '…' : '')
}

/**
 * A comment is actionable if it is open and carries a quote to anchor on.
 */
export function isActionable(c: SdComment): boolean {
  return c.status === 'open' && !!c.anchor?.quote
}

export interface VerdictInput {
  commentsBefore: SdComment[]
  v1Html: string
  v2Html: string
  /** version id the agent was given (the version it revised from) */
  agentBaseVersionId: string | null
  agentReport: AgentReport | null
}

export function computeVerdicts(input: VerdictInput): CommentVerdict[] {
  const v1 = bodyText(input.v1Html)
  const v2 = bodyText(input.v2Html)
  const claimsById = new Map<string, AgentReport['comments'][number]>()
  for (const c of input.agentReport?.comments ?? []) claimsById.set(c.comment_id, c)

  const verdicts: CommentVerdict[] = []
  for (const c of input.commentsBefore) {
    if (!isActionable(c)) continue
    const anchor = c.anchor!
    const quote = anchor.quote!
    const claim = claimsById.get(c.id)?.claim ?? null

    // stale anchor: comment predates the version the agent got AND its quote
    // is absent from that version. Must fail loudly, never silently re-anchor.
    const predates =
      !!input.agentBaseVersionId &&
      !!c.created_on_version_id &&
      c.created_on_version_id !== input.agentBaseVersionId
    const inV1 = locateInOriginal(v1, anchor)
    if (predates && (!inV1 || normWs(v1.slice(inV1.start, inV1.end)) !== normWs(quote))) {
      verdicts.push({
        comment_id: c.id,
        quote,
        human_comment: c.body,
        agent_claim: claim,
        verdict: 'stale_anchor',
        reanchor_mode: 'none',
        similarity: null,
        v1_span: null,
        v2_span: null,
        before_snippet: null,
        after_snippet: null,
        note: STALE_ANCHOR_STRING,
      })
      continue
    }

    const v1loc = inV1
    const v2loc = reanchor(v2, anchor)
    let verdict: CommentVerdict['verdict']
    let note: string | null = null
    if (!v2loc) {
      verdict = 'deleted'
      note = 'quote not found in v2 (exact or fuzzy)'
    } else {
      const v2slice = v2.slice(v2loc.start, v2loc.end)
      const v1slice = v1loc ? v1.slice(v1loc.start, v1loc.end) : quote
      if (normWs(v2slice) === normWs(v1slice)) {
        verdict = 'untouched'
      } else {
        verdict = 'edited'
        if (v2loc.mode === 'fuzzy') note = `fuzzy re-anchor, similarity ${v2loc.similarity?.toFixed(2)}`
      }
    }
    if (v1loc && normWs(v1.slice(v1loc.start, v1loc.end)) !== normWs(quote)) {
      note = (note ? note + '; ' : '') + 'v1 offsets did not match quote; located by quote search'
    }
    verdicts.push({
      comment_id: c.id,
      quote,
      human_comment: c.body,
      agent_claim: claim,
      verdict,
      reanchor_mode: v2loc?.mode ?? (v1loc ? 'exact' : 'none'),
      similarity: v2loc?.similarity ?? null,
      v1_span: v1loc ? [v1loc.start, v1loc.end] : null,
      v2_span: v2loc ? [v2loc.start, v2loc.end] : null,
      before_snippet: v1loc ? snippet(v1, v1loc.start, v1loc.end) : null,
      after_snippet: v2loc ? snippet(v2, v2loc.start, v2loc.end) : null,
      note,
    })
  }
  return verdicts
}

function claimMatchesVerdict(claim: string | null, verdict: CommentVerdict['verdict']): boolean {
  if (claim === null) return false
  if (claim === 'addressed') return verdict === 'edited'
  if (claim === 'not_addressed') return verdict === 'untouched' || verdict === 'deleted'
  if (claim === 'stale_anchor') return verdict === 'stale_anchor'
  return false
}

export function findMismatches(verdicts: CommentVerdict[]): ClaimMismatch[] {
  const out: ClaimMismatch[] = []
  for (const v of verdicts) {
    if (v.agent_claim === null) continue
    if (!claimMatchesVerdict(v.agent_claim, v.verdict)) {
      const message =
        v.agent_claim === 'addressed' && v.verdict === 'untouched'
          ? CLAIM_MISMATCH_STRING
          : `claimed ${v.agent_claim}, computed ${v.verdict}`
      out.push({ comment_id: v.comment_id, claim: v.agent_claim, computed: v.verdict, message })
    }
  }
  return out
}

function mv(key: string, label: string, value: string, detail: string, naReason: string | null): MetricValue {
  return { key, label, value, detail, na_reason: naReason }
}

export interface MetricsInput {
  verdicts: CommentVerdict[]
  v1Html: string
  v2Html: string
  totalTokens: number
  promptTokens: number
  completionTokens: number
  pushes: number
  converged: boolean
  convergenceNote: string | null
}

export function computeMetrics(i: MetricsInput): RunMetrics {
  const v1 = bodyText(i.v1Html)
  const v2 = bodyText(i.v2Html)
  const edited = i.verdicts.filter(v => v.verdict === 'edited').length
  const untouched = i.verdicts.filter(v => v.verdict === 'untouched').length
  const deleted = i.verdicts.filter(v => v.verdict === 'deleted').length
  const stale = i.verdicts.filter(v => v.verdict === 'stale_anchor').length
  const actionable = i.verdicts.length - stale

  const attribution =
    actionable === 0
      ? mv('attribution_rate', 'Attribution rate', 'N/A', '', 'no actionable comments in this run')
      : mv(
          'attribution_rate',
          'Attribution rate',
          `${(edited / actionable * 100).toFixed(1)}%`,
          `${edited} edited / ${actionable} actionable (stale anchors excluded)`,
          null,
        )

  const intervals: [number, number][] = []
  for (const v of i.verdicts) {
    if (v.v1_span) intervals.push(v.v1_span)
    if (v.v2_span) intervals.push(v.v2_span)
  }
  const churn = computeChurn(v1, v2, intervals)
  const churnMetric =
    churn.collateralChurn === null
      ? mv('collateral_churn', 'Collateral churn', 'N/A', '', 'v1 and v2 text are identical; nothing changed')
      : mv(
          'collateral_churn',
          'Collateral churn',
          `${(churn.collateralChurn * 100).toFixed(1)}%`,
          `${churn.changedOutsideAnchors} of ${churn.totalChanged} changed chars outside anchors`,
          null,
        )

  const withClaims = i.verdicts.filter(v => v.agent_claim !== null)
  const matching = withClaims.filter(v => claimMatchesVerdict(v.agent_claim, v.verdict)).length
  const claimMetric =
    withClaims.length === 0
      ? mv('claim_accuracy', 'Claim accuracy', 'N/A', '', 'agent returned no structured claims')
      : mv(
          'claim_accuracy',
          'Claim accuracy',
          `${(matching / withClaims.length * 100).toFixed(1)}%`,
          `${matching}/${withClaims.length} claims match computed verdicts`,
          null,
        )

  const costMetric =
    i.totalTokens === 0
      ? mv('cost_per_attributed_fix', 'Cost per attributed fix', 'N/A', '', 'no token usage reported by the API')
      : edited === 0
        ? mv('cost_per_attributed_fix', 'Cost per attributed fix', 'N/A', `${i.totalTokens} tokens used`, 'zero attributed fixes; division undefined')
        : mv(
            'cost_per_attributed_fix',
            'Cost per attributed fix',
            `${Math.round(i.totalTokens / edited)} tokens`,
            `${i.totalTokens} tokens total (${i.promptTokens} prompt + ${i.completionTokens} completion) / ${edited} edited`,
            null,
          )

  const roundsMetric =
    !i.converged
      ? mv('rounds_to_converge', 'Rounds to converge', `${i.pushes}+`, i.convergenceNote ?? 'not converged within the round cap', 'did not converge')
      : mv('rounds_to_converge', 'Rounds to converge', `${i.pushes}`, `${i.pushes} push(es) until no unresolved actionable comments remained`, null)

  return {
    attribution_rate: attribution,
    collateral_churn: churnMetric,
    claim_accuracy: claimMetric,
    cost_per_attributed_fix: costMetric,
    rounds_to_converge: roundsMetric,
    edited,
    untouched,
    deleted,
    stale_anchor: stale,
    actionable,
    total_tokens: i.totalTokens,
    prompt_tokens: i.promptTokens,
    completion_tokens: i.completionTokens,
    pushes: i.pushes,
    converged: i.converged,
  }
}

export { CLAIM_MISMATCH_STRING, STALE_ANCHOR_STRING }

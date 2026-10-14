/**
 * Synthetic unit checks for the scoring engine (no LLM needed).
 * Run: npx tsx scripts/score-test.ts
 */
import { computeVerdicts, computeMetrics, findMismatches } from '../server/src/scoring.js'
import { bodyText, reanchor, locateInOriginal } from '../server/src/anchoring.js'
import { STALE_ANCHOR_STRING, CLAIM_MISMATCH_STRING, type SdComment } from '../server/src/types.js'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const V1 = `<!doctype html><html><head><title>T</title></head><body>
<h1>Release Review</h1>
<p>The rollback plan relies on manual database reverts.</p>
<p>Error budget consumption is currently acceptable for this quarter.</p>
<p>Monitoring covers the primary checkout path end to end.</p>
<p>The on-call rotation is documented in the runbook.</p>
</body></html>`

const V2 = `<!doctype html><html><head><title>T</title></head><body>
<h1>Release Review</h1>
<p>The rollback plan relies on automated, tested database reverts owned by the platform team.</p>
<p>Error budget consumption is currently acceptable for this quarter.</p>
<p>Monitoring covers the primary checkout path end to end.</p>
<p>The on-call rotation is documented in the runbook and paged through Slack.</p>
</body></html>`

const v1 = bodyText(V1)
const q1 = 'The rollback plan relies on manual database reverts.'
const q2 = 'Error budget consumption is currently acceptable for this quarter.'
const q3 = 'Monitoring covers the primary checkout path end to end.'
const q4 = 'The on-call rotation is documented in the runbook.'

// offset extraction sanity
const loc = locateInOriginal(v1, { quote: q1 })
check('locateInOriginal finds q1', !!loc && v1.slice(loc!.start, loc!.end) === q1)

const mk = (id: string, quote: string, ver: string): SdComment => ({
  id,
  body: 'fix this',
  status: 'open',
  anchor: { quote },
  created_on_version_id: ver,
})

const comments: SdComment[] = [
  mk('c1', q1, 'vA'),
  mk('c2', q2, 'vA'),
  mk('c3', 'This sentence was removed entirely from the document.', 'vA'),
  mk('c4', q4, 'vA'),
]

const report = {
  comments: [
    { comment_id: 'c1', claim: 'addressed' as const, change_summary: 'rewrote', rationale: '' },
    { comment_id: 'c2', claim: 'addressed' as const, change_summary: 'kept', rationale: '' },
    { comment_id: 'c3', claim: 'not_addressed' as const, change_summary: 'gone', rationale: '' },
    { comment_id: 'c4', claim: 'addressed' as const, change_summary: 'changed', rationale: '' },
  ],
  notes: '',
}

const verdicts = computeVerdicts({
  commentsBefore: comments,
  v1Html: V1,
  v2Html: V2,
  agentBaseVersionId: 'vA',
  agentReport: report,
})
const byId = Object.fromEntries(verdicts.map(v => [v.comment_id, v.verdict]))
check('c1 edited', byId.c1 === 'edited', String(byId.c1))
check('c2 untouched', byId.c2 === 'untouched', String(byId.c2))
check('c3 deleted (quote absent from v1 too -> stale? no, same version -> deleted)', byId.c3 === 'deleted', String(byId.c3))
check('c4 edited (runbook sentence replaced)', byId.c4 === 'edited', String(byId.c4))

const mismatches = findMismatches(verdicts)
const m2 = mismatches.find(m => m.comment_id === 'c2')
check('c2 claim mismatch flagged', !!m2)
check('c2 mismatch uses exact string', m2?.message === CLAIM_MISMATCH_STRING, m2?.message ?? '')

const metrics = computeMetrics({
  verdicts,
  v1Html: V1,
  v2Html: V2,
  totalTokens: 1000,
  promptTokens: 700,
  completionTokens: 300,
  pushes: 1,
  converged: false,
  convergenceNote: 'x',
})
check('attribution 2/4 = 50%', metrics.attribution_rate.value === '50.0%', metrics.attribution_rate.value)
check('cost per fix = 500 tokens', metrics.cost_per_attributed_fix.value === '500 tokens', metrics.cost_per_attributed_fix.value)
check('claim accuracy 3/4', metrics.claim_accuracy.value === '75.0%', metrics.claim_accuracy.value)
const churn = parseFloat(metrics.collateral_churn.value)
check('churn computed and > 0', !Number.isNaN(churn), metrics.collateral_churn.value + ' ' + metrics.collateral_churn.detail)

// --- stale anchor path ---
const staleComments: SdComment[] = [
  { ...mk('s1', 'The quick brown fox sentence is gone now.', 'vOLD') },
]
const staleVerdicts = computeVerdicts({
  commentsBefore: staleComments,
  v1Html: V2, // agent was given v2 (new version id), comment predates it, quote absent
  v2Html: V2,
  agentBaseVersionId: 'vNEW',
  agentReport: null,
})
check('stale verdict', staleVerdicts[0]?.verdict === 'stale_anchor', staleVerdicts[0]?.verdict)
check('stale exact string', staleVerdicts[0]?.note === STALE_ANCHOR_STRING, staleVerdicts[0]?.note ?? '')
const staleMetrics = computeMetrics({
  verdicts: staleVerdicts,
  v1Html: V2,
  v2Html: V2,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  pushes: 0,
  converged: false,
  convergenceNote: '',
})
check('stale excluded from denominator -> N/A', staleMetrics.attribution_rate.value === 'N/A', staleMetrics.attribution_rate.value)
check('identical docs -> churn N/A', staleMetrics.collateral_churn.value === 'N/A', staleMetrics.collateral_churn.value)
check('no tokens -> cost N/A', staleMetrics.cost_per_attributed_fix.value === 'N/A', staleMetrics.cost_per_attributed_fix.value)

// --- fuzzy re-anchor: quote edited in place ---
const v2b = V1.replace('manual database reverts', 'automated database reverts')
const fz = reanchor(bodyText(v2b), { quote: q1, start_offset: loc!.start, end_offset: loc!.end })
check('fuzzy finds edited sentence', !!fz && fz.mode === 'fuzzy', fz?.mode + ' ' + (fz?.similarity?.toFixed(2) ?? ''))

console.log(failures === 0 ? '\nALL SCORE TESTS PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)

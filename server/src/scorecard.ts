import type { AgentReport, ClaimMismatch, CommentVerdict, RunMetrics, RunRecord } from './types.js'
import { STALE_ANCHOR_STRING, CLAIM_MISMATCH_STRING } from './types.js'

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const VERDICT_COLORS: Record<string, string> = {
  edited: '#3fb950',
  untouched: '#d29922',
  deleted: '#f85149',
  stale_anchor: '#8b949e',
}

export function buildScorecardHtml(
  rec: RunRecord,
  metrics: RunMetrics,
  verdicts: CommentVerdict[],
  mismatches: ClaimMismatch[],
  report: AgentReport | null,
): string {
  const mv = (m: { label: string; value: string; detail: string; na_reason: string | null }) =>
    `<div class="metric"><div class="mv" style="${m.na_reason ? 'color:#8b949e' : ''}">${esc(m.value)}</div><div class="ml">${esc(m.label)}</div><div class="md">${esc(m.na_reason ? 'N/A — ' + m.na_reason : m.detail)}</div></div>`

  const rows = verdicts
    .map(v => {
      const mismatch = mismatches.find(m => m.comment_id === v.comment_id)
      return `<tr>
  <td><span class="v" style="color:${VERDICT_COLORS[v.verdict]}">${esc(v.verdict)}</span></td>
  <td>${esc(v.quote?.slice(0, 160))}</td>
  <td>${esc(v.human_comment.slice(0, 160))}</td>
  <td>${esc(v.agent_claim ?? '—')}</td>
  <td>${esc(v.before_snippet ?? '—')}</td>
  <td>${esc(v.after_snippet ?? '—')}</td>
  <td>${mismatch ? `<span class="warn">${esc(mismatch.message)}</span>` : esc(v.note ?? '')}</td>
</tr>`
    })
    .join('\n')

  const stale = verdicts.filter(v => v.verdict === 'stale_anchor')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>agent-review-loop scorecard ${esc(rec.id)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: light-dark(#1b1f23, #e6edf3); background: light-dark(#fff, #0d1117); }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .metric { border: 1px solid light-dark(#d0d7de, #30363d); border-radius: 8px; padding: 12px; }
  .mv { font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ml { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .md { font-size: .75rem; opacity: .6; margin-top: 4px; }
  table { border-collapse: collapse; width: 100%; font-size: .8rem; }
  th, td { border: 1px solid light-dark(#d0d7de, #30363d); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: light-dark(#f6f8fa, #161b22); }
  .v { font-weight: 700; } .warn { color: #f85149; font-weight: 600; }
  .stale { border-left: 3px solid #8b949e; padding: 8px 12px; background: light-dark(#f6f8fa, #161b22); margin: 8px 0; font-family: ui-monospace, monospace; font-size: .8rem; }
  .meta { opacity: .65; font-size: .8rem; }
</style></head>
<body>
<h1>agent-review-loop — scorecard</h1>
<p class="meta">run ${esc(rec.id)} · doc <a href="${esc(rec.doc_url ?? '')}">${esc(rec.doc_id ?? '')}</a> · mode ${esc(rec.slashdocs.mode)} · model ${esc(rec.model.model)} @ ${esc(rec.model.baseUrl)} · ${esc(rec.created_at)}</p>
<h2>Metrics</h2>
<div class="metrics">
${mv(metrics.attribution_rate)}
${mv(metrics.collateral_churn)}
${mv(metrics.claim_accuracy)}
${mv(metrics.cost_per_attributed_fix)}
${mv(metrics.rounds_to_converge)}
</div>
<h2>Per-comment verdicts</h2>
<table>
<tr><th>verdict</th><th>anchor quote</th><th>human comment</th><th>agent claim</th><th>before @ anchor</th><th>after @ anchor</th><th>note</th></tr>
${rows}
</table>
${stale.length ? `<h2>Stale anchors</h2>${stale.map(v => `<div class="stale">${esc(v.comment_id)}: ${esc(STALE_ANCHOR_STRING)}</div>`).join('')}` : ''}
${mismatches.length ? `<h2>Claim mismatches</h2>${mismatches.map(m => `<div class="stale">${esc(m.comment_id)}: ${esc(m.message === CLAIM_MISMATCH_STRING ? CLAIM_MISMATCH_STRING : `${m.claim} vs ${m.computed}`)}</div>`).join('')}` : ''}
<h2>Agent report</h2>
<pre class="meta">${esc(JSON.stringify(report ?? {}, null, 2))}</pre>
<p class="meta">All verdicts and metrics are computed from the v1/v2 text diff by agent-review-loop, not from the model's claims. Token totals come from API usage fields.</p>
</body></html>`
}

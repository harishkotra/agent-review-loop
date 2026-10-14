/**
 * npm run smoke — clean case end to end against a locally served slashdocs
 * document, printing the real metrics. Drives the Hono app in-process.
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
import { JSDOM } from 'jsdom'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from '../server/src/index.js'
import * as sd from '../server/src/slashdocs.js'
import { runDir } from '../server/src/runs.js'
import type { SdComment } from '../server/src/types.js'

const CLI = process.env.SLASHDOCS_CLI || 'slashdocs'
const DOCS_DIR = process.env.SMOKE_DOCS_DIR || '/tmp/arl-smoke-docs'
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.particle.ai/v1'
const API_KEY = process.env.PARTICLE_API_KEY || process.env.OPENAI_API_KEY || ''
const MODEL = process.env.OPENAI_MODEL || 'deepseek-v4.1-flash'

async function post(path: string, body?: unknown): Promise<any> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json: any = await res.json()
  if (!res.ok || json?.error) throw new Error(`${path} -> HTTP ${res.status}: ${json?.error ?? JSON.stringify(json).slice(0, 400)}`)
  return json
}

function bodyText(html: string): string {
  return new JSDOM(html).window.document.body?.textContent ?? ''
}

/** pick up to n sentences from distinct paragraphs, long enough to anchor well */
function pickSentences(html: string, n: number): string[] {
  const text = bodyText(html).replace(/\s+/g, ' ')
  const sentences = text
    .split(/(?<=[.!?]) /)
    .map(s => s.trim())
    .filter(s => s.length >= 45 && s.length <= 220 && /[a-z]{3}/.test(s))
  const out: string[] = []
  for (const s of sentences) {
    if (!out.some(o => o.includes(s) || s.includes(o))) out.push(s)
    if (out.length >= n) break
  }
  return out
}

const COMMENT_BODIES = [
  'Name the owner of this action explicitly.',
  'Give the concrete number or threshold here instead of a vague qualifier.',
  'This is ambiguous — rewrite so it can only be read one way.',
  'State the risk if this step is skipped.',
]

async function main() {
  if (!API_KEY) throw new Error('no API key: set PARTICLE_API_KEY in .env')
  const slashdocs = { mode: 'local' as const, cliPath: CLI, documentsFolder: DOCS_DIR }
  await sd.ensureLocal(slashdocs)
  const model = { baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL }

  console.log(`[smoke] model=${MODEL} @ ${BASE_URL}`)
  console.log(`[smoke] slashdocs local, folder=${DOCS_DIR}, cli=${CLI}`)

  const brief =
    'Release readiness review for checkout-service v2.4. Sections: summary, scope of change, ' +
    'error budget status, rollback plan, open incidents, monitoring gaps, sign-off. ' +
    'Write it as a release manager briefing the on-call team. Make concrete claims a reviewer could question.'
  const rec = await post('/api/runs', {
    slashdocs,
    model,
    target: { kind: 'brief', brief },
  })
  console.log(`[smoke] run ${rec.id} created`)

  const authored = await post(`/api/runs/${rec.id}/author`)
  console.log(`[smoke] v1 published: doc=${authored.doc_id} url=${authored.doc_url}`)

  // human review: leave 4 anchored comments on different sentences
  const v1Html = readFileSync(join(runDir(rec.id), 'v1.html'), 'utf8')
  const sentences = pickSentences(v1Html, 4)
  if (sentences.length < 4) throw new Error(`only ${sentences.length} anchorable sentences found in v1`)
  const show = await sd.docsShow(slashdocs, authored.doc_id)
  const versionId = show?.current_version_id ?? null
  const created: SdComment[] = []
  for (let i = 0; i < 4; i++) {
    const c = await sd.docsCommentCreate(slashdocs, authored.doc_id, {
      quote: sentences[i],
      body: COMMENT_BODIES[i],
      version: versionId ?? undefined,
    })
    created.push(c)
    console.log(`[smoke] comment ${c.id} on: "${sentences[i].slice(0, 70)}…"`)
  }

  await post(`/api/runs/${rec.id}/comments`)
  const result = await post(`/api/runs/${rec.id}/revise`)
  const m = result.metrics
  console.log('\n===== SMOKE METRICS (computed from the v1/v2 diff) =====')
  for (const k of ['attribution_rate', 'collateral_churn', 'claim_accuracy', 'cost_per_attributed_fix', 'rounds_to_converge'] as const) {
    const mv = m[k]
    console.log(`${mv.label.padEnd(24)} ${mv.value.padEnd(14)} ${mv.na_reason ? 'N/A — ' + mv.na_reason : mv.detail}`)
  }
  console.log(`\nverdicts: ${result.verdicts.map((v: any) => `${v.comment_id.slice(0, 6)}=${v.verdict}`).join(', ')}`)
  if (result.mismatches?.length) {
    console.log('claim mismatches:')
    for (const mm of result.mismatches) console.log(`  ${mm.comment_id}: ${mm.message}`)
  }
  const sc = await post(`/api/runs/${rec.id}/scorecard`)
  console.log(`\n[smoke] scorecard published: ${sc.url}`)
  console.log(`[smoke] evidence bundle: runs/${rec.id}/`)
  if (m.stale_anchor > 0 || m.edited < 3) {
    console.log('[smoke] WARNING: attribution below expectations for a clean run')
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error('[smoke] FAILED:', err?.message ?? err)
  process.exit(1)
})

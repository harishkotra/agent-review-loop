/**
 * Test case 2 — deliberate stale-anchor failure path.
 * Comment on a v1 sentence, a human pushes a v2 that deletes that sentence,
 * then the agent runs. The harness must print the exact stale string,
 * exclude the comment from the denominator, and leave it unresolved.
 * Run: npx tsx scripts/stale-test.ts
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { JSDOM } from 'jsdom'
import { app } from '../server/src/index.js'
import * as sd from '../server/src/slashdocs.js'
import { runDir } from '../server/src/runs.js'
import { STALE_ANCHOR_STRING } from '../server/src/types.js'

const CLI = process.env.SLASHDOCS_CLI || 'slashdocs'
const DOCS_DIR = process.env.STALE_DOCS_DIR || '/tmp/arl-stale-docs'
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.particle.ai/v1'
const API_KEY = process.env.PARTICLE_API_KEY || process.env.OPENAI_API_KEY || ''
const MODEL = process.env.OPENAI_MODEL || 'deepseek-v4.1-flash'

function bodyText(html: string): string {
  return new JSDOM(html).window.document.body?.textContent ?? ''
}

/** sentences that appear verbatim in the raw HTML (no inline markup inside), so a plain string replace is guaranteed to hit */
function pickSentences(html: string, n: number): string[] {
  const text = bodyText(html).replace(/\s+/g, ' ')
  const sentences = text
    .split(/(?<=[.!?]) /)
    .map(s => s.trim())
    .filter(s => s.length >= 45 && s.length <= 220 && /[a-z]{3}/.test(s) && html.includes(s))
  const out: string[] = []
  for (const s of sentences) {
    if (!out.some(o => o.includes(s) || s.includes(o))) out.push(s)
    if (out.length >= n) break
  }
  return out
}

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

async function main() {
  if (!API_KEY) throw new Error('no API key: set PARTICLE_API_KEY in .env')
  const slashdocs = { mode: 'local' as const, cliPath: CLI, documentsFolder: DOCS_DIR }
  await sd.ensureLocal(slashdocs)
  const model = { baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL }

  const brief =
    'Release readiness review for ledger-service v0.9. Sections: summary, scope, error budget, ' +
    'rollback plan, open incidents, sign-off. Concrete claims a reviewer could question.'
  const rec = await post('/api/runs', { slashdocs, model, target: { kind: 'brief', brief } })
  const authored = await post(`/api/runs/${rec.id}/author`)
  const docId = authored.doc_id
  console.log(`[stale] run ${rec.id}, doc ${docId}`)

  const v1Html = readFileSync(join(runDir(rec.id), 'v1.html'), 'utf8')
  const sentences = pickSentences(v1Html, 2)
  if (sentences.length < 2) throw new Error('need two anchorable sentences')
  const [staleSentence, okSentence] = sentences
  const show = await sd.docsShow(slashdocs, docId)
  const versionId = show.current_version_id
  console.log(`[stale] version at comment time: ${versionId}`)

  const cStale = await sd.docsCommentCreate(slashdocs, docId, {
    quote: staleSentence, body: 'This claim needs a source. (will be invalidated by a human push)', version: versionId,
  })
  const cOk = await sd.docsCommentCreate(slashdocs, docId, {
    quote: okSentence, body: 'Name the owner of this action explicitly.', version: versionId,
  })
  console.log(`[stale] comments ${cStale.id} (doomed) and ${cOk.id}`)

  // human pushes a v2 that DELETES the doomed sentence (verbatim in raw HTML,
  // so a plain replace is guaranteed to hit)
  const pulled = join(runDir(rec.id), 'human_v2.html')
  await sd.docsPull(slashdocs, docId, pulled)
  const before = readFileSync(pulled, 'utf8')
  const humanHtml = before.replace(staleSentence, 'This paragraph was restructured by a human reviewer.')
  if (humanHtml === before) throw new Error('human push aborted: doomed sentence not found in pulled HTML')
  await writeAndPush(slashdocs, docId, humanHtml, pulled)
  const show2 = await sd.docsShow(slashdocs, docId)
  if (show2.current_version_id === versionId) throw new Error('human push did not rotate the version id')
  console.log(`[stale] human push rotated version to ${show2.current_version_id}; doomed sentence removed`)

  await post(`/api/runs/${rec.id}/comments`)
  const result = await post(`/api/runs/${rec.id}/revise`)

  const stale = result.verdicts.find((v: any) => v.comment_id === cStale.id)
  console.log('\n===== STALE-ANCHOR CASE =====')
  console.log(`doomed comment verdict: ${stale?.verdict}`)
  console.log(`on-screen string: ${stale?.note}`)
  const ok = result.verdicts.find((v: any) => v.comment_id === cOk.id)
  console.log(`other comment verdict: ${ok?.verdict}`)
  console.log(`attribution: ${result.metrics.attribution_rate.value} (${result.metrics.attribution_rate.detail})`)

  // doomed comment must remain unresolved in slashdocs
  const after = await sd.docsCommentsList(slashdocs, docId)
  const stillOpen = after.find(c => c.id === cStale.id)?.status
  console.log(`doomed comment status in slashdocs after run: ${stillOpen}`)

  let fail = 0
  if (stale?.verdict !== 'stale_anchor') { console.error('FAIL: verdict not stale_anchor'); fail++ }
  if (stale?.note !== STALE_ANCHOR_STRING) { console.error('FAIL: exact string mismatch'); fail++ }
  if (stillOpen !== 'open') { console.error('FAIL: doomed comment was resolved'); fail++ }
  if (result.metrics.attribution_rate.detail.includes(cStale.id)) { console.error('FAIL: stale counted in denominator'); fail++ }
  console.log(fail === 0 ? 'STALE TEST PASS' : `STALE TEST FAIL (${fail})`)
  process.exit(fail === 0 ? 0 : 1)
}

async function writeAndPush(slashdocs: any, docId: string, html: string, pulled: string) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(pulled, html)
  const res = await sd.docsPush(slashdocs, docId, pulled, 'human: restructured one paragraph (invalidates a comment)')
  if (!res.ok) throw new Error(`human push failed: ${res.error}`)
}

main().catch(err => {
  console.error('[stale] FAILED:', err?.message ?? err)
  process.exit(1)
})

/**
 * Test case 3 — identical document + identical comments, two models.
 * The scorecards must show two different attribution rates and two
 * different token totals. Run: npx tsx scripts/two-model-test.ts
 */
import 'dotenv/config'
import { JSDOM } from 'jsdom'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from '../server/src/index.js'
import * as sd from '../server/src/slashdocs.js'
import { runDir, createRunDir } from '../server/src/runs.js'
import type { SdComment } from '../server/src/types.js'

const CLI = process.env.SLASHDOCS_CLI || 'slashdocs'
const DOCS_DIR = process.env.TWOMODEL_DOCS_DIR || '/tmp/arl-twomodel-docs'
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.particle.ai/v1'
const API_KEY = process.env.PARTICLE_API_KEY || process.env.OPENAI_API_KEY || ''
const MODEL_A = process.env.MODEL_A || 'deepseek-v4.1-flash'
const MODEL_B = process.env.MODEL_B || 'glm5.3flash'
// an already-authored v1 to reuse (from a prior smoke run) so both models
// see byte-identical documents; falls back to authoring one fresh
const SOURCE_V1 = process.env.SOURCE_V1 || ''

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

function pickSentences(html: string, n: number): string[] {
  const dom = new JSDOM(html)
  const paras = Array.from(dom.window.document.querySelectorAll('body p')) as HTMLElement[]
  const out: string[] = []
  for (const p of paras) {
    const text = (p.textContent ?? '').replace(/\s+/g, ' ').trim()
    const s = text.split(/(?<=[.!?]) /).find(x => x.length >= 45 && x.length <= 220 && !/[“”]/.test(x))
    if (s && !out.some(o => o.includes(s) || s.includes(o))) out.push(s)
    if (out.length >= n) break
  }
  return out
}

const BODIES = [
  'Name the owner of this action explicitly.',
  'Give the concrete number or threshold here instead of a vague qualifier.',
  'This is ambiguous — rewrite so it can only be read one way.',
  'State the risk if this step is skipped.',
]

async function runOne(modelName: string, v1Html: string, sentences: string[]): Promise<any> {
  const slashdocs = { mode: 'local' as const, cliPath: CLI, documentsFolder: DOCS_DIR }
  const rec = await post('/api/runs', {
    slashdocs,
    model: { baseUrl: BASE_URL, apiKey: API_KEY, model: modelName },
    target: { kind: 'existing', docId: '' },
  })
  createRunDir(rec.id)
  writeFileSync(join(runDir(rec.id), 'v1.html'), v1Html)
  // publish this model's private copy of the identical document
  const docFile = join(runDir(rec.id), `${rec.id}.html`)
  writeFileSync(docFile, v1Html)
  const created = await sd.docsCreate(slashdocs, docFile, `two-model ${modelName}`)
  const docId = created.id
  const show = await sd.docsShow(slashdocs, docId)
  const versionId = show.current_version_id
  // update the run record to point at the fresh doc
  const { loadRecord, saveRecord } = await import('../server/src/runs.js')
  const r = loadRecord(rec.id)
  r.doc_id = docId
  r.doc_url = created.url ?? (await sd.docsLink(slashdocs, docId))
  r.v1_version_id = versionId
  r.phase = 'authored'
  saveRecord(r)

  const comments: SdComment[] = []
  for (let i = 0; i < 4; i++) {
    comments.push(await sd.docsCommentCreate(slashdocs, docId, {
      quote: sentences[i], body: BODIES[i], version: versionId,
    }))
  }
  console.log(`[${modelName}] doc=${docId} comments=${comments.map(c => c.id.slice(0, 6)).join(',')}`)
  await post(`/api/runs/${rec.id}/comments`)
  const result = await post(`/api/runs/${rec.id}/revise`)
  return { run: rec.id, docId, result }
}

async function main() {
  if (!API_KEY) throw new Error('no API key: set PARTICLE_API_KEY in .env')
  const slashdocs = { mode: 'local' as const, cliPath: CLI, documentsFolder: DOCS_DIR }
  await sd.ensureLocal(slashdocs)

  let v1Html: string
  if (SOURCE_V1) {
    v1Html = readFileSync(SOURCE_V1, 'utf8')
  } else {
    // author a shared v1 with model A, then reuse byte-identical copies
    const rec = await post('/api/runs', {
      slashdocs,
      model: { baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL_A },
      target: {
        kind: 'brief',
        brief: 'Release readiness review for payments-gateway v3.1. Sections: summary, scope, error budget, rollback plan, open incidents, monitoring, sign-off. Concrete claims a reviewer could question.',
      },
    })
    const authored = await post(`/api/runs/${rec.id}/author`)
    v1Html = readFileSync(join(runDir(rec.id), 'v1.html'), 'utf8')
    console.log(`[two-model] shared v1 authored by ${MODEL_A} (run ${rec.id}, doc ${authored.doc_id})`)
  }
  const sentences = pickSentences(v1Html, 4)
  if (sentences.length < 4) throw new Error('need 4 anchorable sentences')
  console.log('[two-model] identical comments:\n' + sentences.map((s, i) => `  ${i + 1}. "${s.slice(0, 60)}…" — ${BODIES[i]}`).join('\n'))

  const a = await runOne(MODEL_A, v1Html, sentences)
  const b = await runOne(MODEL_B, v1Html, sentences)

  console.log('\n===== TWO-MODEL SCORECARDS =====')
  for (const [name, x] of [[MODEL_A, a], [MODEL_B, b]] as const) {
    const m = x.result.metrics
    console.log(`\n${name}  (run ${x.run})`)
    for (const k of ['attribution_rate', 'collateral_churn', 'claim_accuracy', 'cost_per_attributed_fix', 'rounds_to_converge'] as const) {
      const mv = m[k]
      console.log(`  ${mv.label.padEnd(24)} ${mv.value.padEnd(14)} ${mv.na_reason ? 'N/A — ' + mv.na_reason : mv.detail}`)
    }
  }
  const same =
    a.result.metrics.attribution_rate.value === b.result.metrics.attribution_rate.value &&
    a.result.metrics.total_tokens === b.result.metrics.total_tokens
  console.log(same
    ? '\nWARNING: identical numbers to the digit — the harness is not measuring anything'
    : `\nOK: different measurements — ${a.result.metrics.total_tokens} vs ${b.result.metrics.total_tokens} tokens, ${a.result.metrics.attribution_rate.value} vs ${b.result.metrics.attribution_rate.value}`)
}

main().catch(err => {
  console.error('[two-model] FAILED:', err?.message ?? err)
  process.exit(1)
})

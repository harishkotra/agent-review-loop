import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import dotenv from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(here, '..', '..', '.env') })
dotenv.config()
import type {
  AgentReport,
  ClaimMismatch,
  CommentVerdict,
  ModelConfig,
  RunMetrics,
  RunRecord,
  SdComment,
  SlashdocsConfig,
} from './types.js'
import * as sd from './slashdocs.js'
import { chat, testConnection } from './llm.js'
import { authorV1 } from './authoring.js'
import { computeVerdicts, computeMetrics, findMismatches, isActionable } from './scoring.js'
import { reviseAgent } from './agent.js'
import { buildScorecardHtml } from './scorecard.js'
import {
  createRunDir,
  listRuns,
  loadRecord,
  logStep,
  readArtifact,
  readJsonArtifact,
  runDir,
  saveRecord,
  writeArtifact,
} from './runs.js'

const app = new Hono()
const MAX_ROUNDS = 3

app.get('/api/health', c => c.json({ ok: true }))

app.post('/api/test-connection', async c => {
  const body = await c.req.json()
  const model: ModelConfig = { baseUrl: body.baseUrl, apiKey: body.apiKey ?? '', model: body.model }
  const res = await testConnection(model)
  return c.json(res)
})

app.get('/api/runs', c => c.json({ items: listRuns() }))

app.get('/api/runs/:id', c => {
  const id = c.req.param('id')
  try {
    const rec = loadRecord(id)
    return c.json({
      record: rec,
      comments_before: readJsonArtifact<SdComment[]>(id, 'comments.before.json'),
      comments_after: readJsonArtifact<SdComment[]>(id, 'comments.after.json'),
      verdicts: readJsonArtifact<CommentVerdict[]>(id, 'verdicts.json'),
      metrics: readJsonArtifact<RunMetrics>(id, 'metrics.json'),
      claims: readJsonArtifact<AgentReport>(id, 'agent-claims.json'),
      files: ['brief.md', 'v1.html', 'v2.html', 'trace.json', 'scorecard.html'].filter(f =>
        existsSync(join(runDir(id), f)),
      ),
    })
  } catch (err: any) {
    return c.json({ error: String(err?.message ?? err) }, 404)
  }
})

app.post('/api/runs', async c => {
  const body = await c.req.json()
  const rec: RunRecord = {
    id: body.id ?? randomUUID().slice(0, 8),
    created_at: new Date().toISOString(),
    phase: 'setup',
    slashdocs: body.slashdocs as SlashdocsConfig,
    model: body.model as ModelConfig,
    target: body.target,
    doc_id: null,
    doc_url: null,
    v1_version_id: null,
    error: null,
    log: [],
  }
  createRunDir(rec.id)
  if (rec.target.kind === 'brief') writeArtifact(rec.id, 'brief.md', rec.target.brief)
  saveRecord(rec)
  logStep(rec, 'created', `mode=${rec.slashdocs.mode} target=${rec.target.kind}`)
  if (rec.slashdocs.mode === 'local') {
    try {
      await sd.ensureLocal(rec.slashdocs)
    } catch (err: any) {
      rec.error = `local start: ${err?.message ?? err}`
      saveRecord(rec)
    }
  }
  return c.json(rec)
})

/** Author v1 (from brief) or snapshot an existing doc, then publish. */
app.post('/api/runs/:id/author', async c => {
  const id = c.req.param('id')
  const rec = loadRecord(id)
  try {
    if (rec.target.kind === 'brief') {
      logStep(rec, 'author', `model=${rec.model.model} writing v1`)
      const { html, usage } = await authorV1(rec.model, (rec.target as any).brief, rec.slashdocs.cliPath)
      writeArtifact(id, 'v1.html', html)
      writeArtifact(id, 'author-usage.json', JSON.stringify(usage))
      rec.phase = 'authored'
      saveRecord(rec)
      // publish: unique filename in the documents folder for local mode
      const file = join(runDir(id), 'v1.html')
      const createName = join(runDir(id), `${id}.html`)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(createName, html)
      const created = await sd.docsCreate(rec.slashdocs, createName, `agent-review-loop ${id}`)
      rec.doc_id = created.id ?? id + '.html'
      rec.v1_version_id = created.current_version_id ?? null
      rec.doc_url = created.url ?? (await sd.docsLink(rec.slashdocs, rec.doc_id))
      logStep(rec, 'publish', `doc=${rec.doc_id} url=${rec.doc_url}`)
    } else {
      const docId = (rec.target as any).docId
      const show = await sd.docsShow(rec.slashdocs, docId)
      rec.doc_id = docId
      rec.v1_version_id = show?.current_version_id ?? null
      rec.doc_url = await sd.docsLink(rec.slashdocs, docId)
      await sd.docsPull(rec.slashdocs, docId, join(runDir(id), 'v1.html'))
      rec.phase = 'authored'
      logStep(rec, 'existing', `pulled ${docId} as v1.html`)
    }
    saveRecord(rec)
    return c.json(rec)
  } catch (err: any) {
    rec.error = String(err?.stderr ?? err?.message ?? err)
    saveRecord(rec)
    return c.json({ error: rec.error }, 500)
  }
})

/** Lightweight live count for the review badge: open actionable comments, no writes. */
app.get('/api/runs/:id/comments/count', async c => {
  const id = c.req.param('id')
  const rec = loadRecord(id)
  if (!rec.doc_id) return c.json({ error: 'no document published yet' }, 400)
  try {
    const all = await sd.docsCommentsList(rec.slashdocs, rec.doc_id, 'open')
    return c.json({ open_actionable: all.filter(isActionable).length })
  } catch (err: any) {
    return c.json({ error: String(err?.stderr ?? err?.message ?? err) }, 500)
  }
})

/** Re-check comments: pull live, save comments.before.json */
app.post('/api/runs/:id/comments', async c => {
  const id = c.req.param('id')
  const rec = loadRecord(id)
  if (!rec.doc_id) return c.json({ error: 'no document published yet' }, 400)
  try {
    const all = await sd.docsCommentsList(rec.slashdocs, rec.doc_id)
    writeArtifact(id, 'comments.all.json', JSON.stringify(all, null, 2))
    const actionable = all.filter(isActionable)
    writeArtifact(id, 'comments.before.json', JSON.stringify(actionable, null, 2))
    rec.phase = 'review'
    logStep(rec, 'comments', `${actionable.length} unresolved actionable of ${all.length}`)
    saveRecord(rec)
    return c.json({ total: all.length, actionable })
  } catch (err: any) {
    return c.json({ error: String(err?.stderr ?? err?.message ?? err) }, 500)
  }
})

/** The revision run + verify/score loop. */
app.post('/api/runs/:id/revise', async c => {
  const id = c.req.param('id')
  const rec = loadRecord(id)
  if (!rec.doc_id) return c.json({ error: 'no document published yet' }, 400)
  try {
    let promptTokens = 0
    let completionTokens = 0
    // authoring usage counts toward run cost
    const au = readJsonArtifact<{ prompt_tokens: number; completion_tokens: number }>(id, 'author-usage.json')
    if (au) {
      promptTokens += au.prompt_tokens ?? 0
      completionTokens += au.completion_tokens ?? 0
    }

    let pushes = 0
    let conflict = false
    let conflictNote: string | null = null
    let converged = false
    let round = 0
    let lastReport: AgentReport | null = null
    let baseVersionId = rec.v1_version_id

    // base snapshot = current version at revise start (the version the agent is given)
    await sd.docsPull(rec.slashdocs, rec.doc_id, join(runDir(id), 'v1.html'))
    const show = await sd.docsShow(rec.slashdocs, rec.doc_id)
    baseVersionId = show?.current_version_id ?? baseVersionId
    rec.v1_version_id = baseVersionId
    saveRecord(rec)

    let pending = (readJsonArtifact<SdComment[]>(id, 'comments.before.json') ?? []).filter(isActionable)
    if (pending.length === 0) {
      const all = await sd.docsCommentsList(rec.slashdocs, rec.doc_id)
      pending = all.filter(isActionable)
      writeArtifact(id, 'comments.before.json', JSON.stringify(pending, null, 2))
    }

    while (round < MAX_ROUNDS && pending.length > 0) {
      round += 1
      logStep(rec, `revise round ${round}`, `${pending.length} actionable comments`)
      const res = await reviseAgent({
        runId: id,
        model: rec.model,
        sd: rec.slashdocs,
        docId: rec.doc_id,
        baseVersionId,
        comments: pending,
        viewerUrl: rec.doc_url,
        onStep: line => logStep(rec, 'agent', line),
      })
      promptTokens += res.usage.prompt_tokens
      completionTokens += res.usage.completion_tokens
      pushes += res.pushes
      lastReport = res.report ?? lastReport
      if (res.conflict) {
        conflict = true
        conflictNote = res.conflict_note
        break
      }
      // convergence: re-pull comments; open actionable remaining?
      const after = await sd.docsCommentsList(rec.slashdocs, rec.doc_id)
      writeArtifact(id, 'comments.after.json', JSON.stringify(after, null, 2))
      const remaining = after.filter(isActionable)
      if (remaining.length === 0) {
        converged = true
        break
      }
      pending = remaining
      writeArtifact(id, 'comments.before.json', JSON.stringify(
        (readJsonArtifact<SdComment[]>(id, 'comments.before.json') ?? []).concat(
          remaining.filter(r => !(readJsonArtifact<SdComment[]>(id, 'comments.before.json') ?? []).some(b => b.id === r.id)),
        ), null, 2))
    }

    // final snapshots
    await sd.docsPull(rec.slashdocs, rec.doc_id, join(runDir(id), 'v2.html'))
    const after = readJsonArtifact<SdComment[]>(id, 'comments.after.json') ?? (await sd.docsCommentsList(rec.slashdocs, rec.doc_id))
    writeArtifact(id, 'comments.after.json', JSON.stringify(after, null, 2))

    const v1Html = readArtifact(id, 'v1.html') ?? ''
    const v2Html = readArtifact(id, 'v2.html') ?? ''
    const before = readJsonArtifact<SdComment[]>(id, 'comments.before.json') ?? []
    const verdicts = computeVerdicts({
      commentsBefore: before,
      v1Html,
      v2Html,
      agentBaseVersionId: baseVersionId,
      agentReport: lastReport,
    })
    writeArtifact(id, 'verdicts.json', JSON.stringify(verdicts, null, 2))
    const mismatches = findMismatches(verdicts)
    const metrics = computeMetrics({
      verdicts,
      v1Html,
      v2Html,
      totalTokens: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      pushes,
      converged,
      convergenceNote: conflict ? conflictNote : `not converged after ${round} round(s)`,
    })
    writeArtifact(id, 'metrics.json', JSON.stringify({ metrics, mismatches, conflict, conflict_note: conflictNote }, null, 2))
    rec.phase = 'scored'
    logStep(rec, 'scored', `edited=${metrics.edited} untouched=${metrics.untouched} deleted=${metrics.deleted} stale=${metrics.stale_anchor}`)
    saveRecord(rec)
    return c.json({ metrics, verdicts, mismatches, conflict, conflict_note: conflictNote })
  } catch (err: any) {
    rec.error = String(err?.stderr ?? err?.message ?? err)
    saveRecord(rec)
    return c.json({ error: rec.error }, 500)
  }
})

/** Publish the scorecard as its own slashdocs document. */
app.post('/api/runs/:id/scorecard', async c => {
  const id = c.req.param('id')
  const rec = loadRecord(id)
  const m = readJsonArtifact<{ metrics: RunMetrics }>(id, 'metrics.json')
  if (!m) return c.json({ error: 'no metrics yet; run revise first' }, 400)
  try {
    const verdicts = readJsonArtifact<CommentVerdict[]>(id, 'verdicts.json') ?? []
    const claims = readJsonArtifact<AgentReport>(id, 'agent-claims.json')
    const metricsFile = readJsonArtifact<{ mismatches: ClaimMismatch[] }>(id, 'metrics.json')
    const html = buildScorecardHtml(rec, m.metrics, verdicts, metricsFile?.mismatches ?? [], claims)
    const file = join(runDir(id), 'scorecard.html')
    writeFileSync(file, html)
    const docFile = join(runDir(id), `${id}-scorecard.html`)
    writeFileSync(docFile, html)
    const created = await sd.docsCreate(rec.slashdocs, docFile, `scorecard ${id}`)
    const url = created.url ?? (await sd.docsLink(rec.slashdocs, created.id ?? `${id}-scorecard.html`))
    logStep(rec, 'scorecard', `published ${created.id} -> ${url}`)
    saveRecord(rec)
    return c.json({ doc_id: created.id, url })
  } catch (err: any) {
    return c.json({ error: String(err?.stderr ?? err?.message ?? err) }, 500)
  }
})

const port = Number(process.env.PORT ?? 3001)
// only bind when run directly; the smoke script imports `app` in-process
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({ fetch: app.fetch, port }, info => {
    console.log(`agent-review-loop server on :${info.port}`)
  })
}

export { app }

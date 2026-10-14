import { Agent, tool, run, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled, setTraceProcessors } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentReport, ModelConfig, SlashdocsConfig, SdComment } from './types.js'
import * as sd from './slashdocs.js'
import { runDir, writeArtifact } from './runs.js'

/**
 * File-backed trace processor: one trace.json per run. Replaces the default
 * OpenAI-backend exporter so nothing leaves the machine.
 */
function makeFileTraceProcessor(onEvent: (line: string) => void) {
  const traces: any[] = []
  const spans: any[] = []
  let flush: ((path: string) => void) | null = null
  const processor = {
    async onTraceStart(t: any) { traces.push({ id: t.id, name: t.name, started_at: new Date().toISOString() }) },
    async onTraceEnd(t: any) { const rec = traces.find(x => x.id === t.id); if (rec) rec.ended_at = new Date().toISOString() },
    async onSpanStart(_s: any) {},
    async onSpanEnd(s: any) {
      spans.push({
        trace_id: s.traceId,
        span_id: s.id,
        name: s.name,
        type: s.spanData?.type ?? null,
        started_at: s.startedAt ?? null,
        ended_at: s.endedAt ?? null,
        error: s.error ?? null,
        ...(s.spanData?.type === 'generation'
          ? { usage: s.spanData.output?.usage ?? s.spanData.input?.model ?? null }
          : {}),
        ...(s.spanData?.type === 'function'
          ? { input: s.spanData.input, output: typeof s.spanData.output === 'string' ? s.spanData.output.slice(0, 4000) : s.spanData.output }
          : {}),
      })
      if (s.name) onEvent(`span: ${s.name}${s.error ? ' [error]' : ''}`)
    },
    async shutdown() {},
    async forceFlush() { flush?.('') },
  }
  return {
    processor,
    setFlusher(fn: (path: string) => void) { flush = fn },
    dump(path: string) {
      writeFileSync(path, JSON.stringify({ traces, spans }, null, 2))
    },
  }
}

// serialize agent runs because setDefaultOpenAIClient is process-global
let agentChain: Promise<any> = Promise.resolve()

export const AgentReportSchema = z.object({
  comments: z.array(
    z.object({
      comment_id: z.string(),
      claim: z.enum(['addressed', 'not_addressed', 'stale_anchor']),
      change_summary: z.string(),
      rationale: z.string(),
    }),
  ),
  notes: z.string(),
})

export interface ReviseInput {
  runId: string
  model: ModelConfig
  sd: SlashdocsConfig
  docId: string
  baseVersionId: string | null
  comments: SdComment[]
  viewerUrl: string | null
  onStep: (line: string) => void
}

export interface ReviseResult {
  report: AgentReport | null
  usage: { requests: number; inputTokens: number; prompt_tokens: number; completion_tokens: number; total_tokens: number }
  pushes: number
  conflict: boolean
  conflict_note: string | null
  v2Path: string | null
  rawResponsesCount: number
}

const SYSTEM_PROMPT = `You are a document revision agent working on one slashdocs document.

You are given a document and a list of anchored review comments. Address each comment by editing the exact span it is anchored to. Do not restyle, reformat, rename, or rewrite any text that no comment points at. Preserve the document's structure and every element that was not questioned.

Workflow:
1. Use pull_document to get the current HTML into your run directory and read it.
2. For each comment, find the anchor quote in the document text and rewrite exactly that span to address the reviewer's request.
3. Use push_version with the full revised HTML and a summary that has one line per comment in the form "<comment id>: <what changed>".
4. Use resolve_comment for each comment you genuinely addressed.
5. If a comment's quoted text does not exist in the document you were given, do not guess and do not re-anchor it to something similar. Leave it unresolved and report it with claim "stale_anchor".

Return a structured report covering every comment you were given. Do not claim a fix you did not make; the harness re-derives every verdict from the diff.`

export function reviseAgent(input: ReviseInput): Promise<ReviseResult> {
  const task = agentChain.then(() => doRevise(input))
  agentChain = task.catch(() => {})
  return task
}

async function doRevise(input: ReviseInput): Promise<ReviseResult> {
  const dir = runDir(input.runId)
  const trace = makeFileTraceProcessor(input.onStep)
  setDefaultOpenAIClient(new OpenAI({ baseURL: input.model.baseUrl, apiKey: input.model.apiKey || 'not-needed' }) as any)
  setOpenAIAPI('chat_completions')
  setTracingDisabled(false)
  setTraceProcessors([trace.processor as any])

  let pushes = 0
  let conflict = false
  let conflictNote: string | null = null
  let v2Path: string | null = null

  const listComments = tool({
    name: 'list_comments',
    description: 'List unresolved actionable review comments as JSON (anchor quote/prefix/suffix/offsets + body).',
    needsApproval: false,
    parameters: z.object({}),
    execute: async () => {
      const all = await sd.docsCommentsList(input.sd, input.docId, 'open')
      const actionable = all.filter(c => c.status === 'open' && c.anchor?.quote)
      input.onStep(`tool list_comments -> ${actionable.length} open actionable`)
      return JSON.stringify(actionable.map(c => ({ id: c.id, body: c.body, anchor: c.anchor, created_on_version_id: c.created_on_version_id })), null, 2)
    },
  })

  const pullDocument = tool({
    name: 'pull_document',
    description: 'Write the current document HTML into the run directory and return its path and text length.',
    needsApproval: false,
    parameters: z.object({}),
    execute: async () => {
      const out = join(dir, 'agent_current.html')
      await sd.docsPull(input.sd, input.docId, out)
      const html = readFileSync(out, 'utf8')
      input.onStep(`tool pull_document -> ${out} (${html.length} bytes)`)
      return JSON.stringify({ path: out, bytes: html.length, html })
    },
  })

  const resolveComment = tool({
    name: 'resolve_comment',
    description: 'Resolve one review comment by id after you have genuinely addressed it.',
    needsApproval: false,
    parameters: z.object({ comment_id: z.string() }),
    execute: async ({ comment_id }) => {
      await sd.docsCommentsResolve(input.sd, input.docId, [comment_id])
      input.onStep(`tool resolve_comment ${comment_id}`)
      return JSON.stringify({ resolved: comment_id })
    },
  })

  const pushVersion = tool({
    name: 'push_version',
    description:
      'Push a new document version. html_path is either a path to an HTML file or the full HTML content itself. summary must have one line per comment: "<comment id>: <what changed>".',
    needsApproval: false,
    parameters: z.object({ html_path: z.string(), summary: z.string() }),
    execute: async ({ html_path, summary }) => {
      let file = html_path
      if (!existsSync(html_path)) {
        file = writeArtifact(input.runId, 'agent_v2.html', html_path)
      }
      const res = await sd.docsPush(input.sd, input.docId, file, summary)
      if (res.conflict) {
        conflict = true
        conflictNote =
          'VERSION CONFLICT - another writer pushed first; run aborted without clobbering'
        input.onStep('push conflict (exit 5)')
        return JSON.stringify({ error: conflictNote })
      }
      pushes += 1
      v2Path = join(dir, 'v2.html')
      await sd.docsPull(input.sd, input.docId, v2Path)
      input.onStep(`tool push_version -> v${pushes} pushed, v2 snapshot saved`)
      return JSON.stringify({ pushed: true, version: res.json?.current_version_id ?? res.json?.id ?? null })
    },
  })

  const agent = new Agent({
    name: 'reviser',
    instructions: SYSTEM_PROMPT,
    model: input.model.model,
    tools: [listComments, pullDocument, resolveComment, pushVersion],
    outputType: AgentReportSchema,
  })

  const commentLines = input.comments
    .map(c => `- ${c.id}: "${c.anchor?.quote}" — reviewer says: ${c.body}`)
    .join('\n')
  const userMsg = `Document id: ${input.docId}
Current version id: ${input.baseVersionId ?? 'unknown'}
Viewer: ${input.viewerUrl ?? 'n/a'}

Unresolved actionable comments to address (fix exactly these anchored spans):
${commentLines}

Pull the document, edit only the anchored spans, push the new version with a one-line-per-comment summary, resolve the comments you addressed, and return the structured report.`

  const result = await run(agent, userMsg, { maxTurns: 24 })

  let requests = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const rr of result.rawResponses ?? []) {
    const u: any = (rr as any).usage ?? {}
    requests += u.requests ?? 1
    inputTokens += u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
  }
  const report = (result.finalOutput ?? null) as AgentReport | null
  trace.dump(join(dir, 'trace.json'))
  writeArtifact(input.runId, 'agent-claims.json', JSON.stringify(report ?? { comments: [], notes: 'no structured report returned' }, null, 2))

  return {
    report,
    usage: {
      requests,
      inputTokens,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
    pushes,
    conflict,
    conflict_note: conflictNote,
    v2Path,
    rawResponsesCount: (result.rawResponses ?? []).length,
  }
}

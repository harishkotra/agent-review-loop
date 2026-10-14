import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chat, extractHtml } from './llm.js'
import type { ModelConfig } from './types.js'

const execFileP = promisify(execFile)

let cachedGuidelines: string | null = null

/** `slashdocs guidelines all` output, cached. Falls back to a summary. */
export async function guidelines(cliPath = 'slashdocs'): Promise<string> {
  if (cachedGuidelines) return cachedGuidelines
  try {
    const { stdout } = await execFileP(cliPath, ['guidelines', 'all'], { timeout: 15_000 })
    cachedGuidelines = stdout
  } catch {
    cachedGuidelines = `slashdocs authoring rules (summary): one self-contained HTML file; no relative-path assets; images inline as base64 data URLs or SVG; follow reader light/dark theme; review-friendly layout.`
  }
  return cachedGuidelines
}

export async function authorV1(
  model: ModelConfig,
  brief: string,
  cliPath: string,
): Promise<{ html: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const g = await guidelines(cliPath)
  const res = await chat(
    model,
    [
      {
        role: 'system',
        content: `You author slashdocs documents. Follow these official authoring guidelines exactly:\n\n${g}\n\nOutput ONLY a single complete self-contained HTML document (starting with <!doctype html>). No commentary, no markdown fences.`,
      },
      { role: 'user', content: `Write a "release readiness review" document for this brief. It must have at least six distinct sections with real prose (2-4 sentences each), concrete claims a reviewer could question, and an inline SVG or simple HTML/CSS visual where it helps.\n\nBrief:\n${brief}` },
    ],
    { temperature: 0.6, maxTokens: 8000 },
  )
  return {
    html: extractHtml(res.text),
    usage: res.usage,
  }
}

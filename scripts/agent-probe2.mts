import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, tool, run, setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
const here = dirname(fileURLToPath(import.meta.url))
const key = readFileSync(join(here, '..', '.env'), 'utf8').match(/PARTICLE_API_KEY=(.+)/)?.[1]?.trim() ?? ''
setDefaultOpenAIClient(new OpenAI({ baseURL: 'https://api.particle.ai/v1', apiKey: key }) as any)
setOpenAIAPI('chat_completions')
const t = tool({ name: 'echo', description: 'echo text back', parameters: z.object({ text: z.string() }), execute: async ({ text }) => 'echoed: ' + text })
const out = z.object({ comments: z.array(z.object({ comment_id: z.string(), claim: z.enum(['addressed','not_addressed','stale_anchor']), change_summary: z.string(), rationale: z.string() })), notes: z.string() })
const a = new Agent({ name: 'probe', instructions: 'Use the echo tool first, then return the structured report.', model: 'deepseek-v4.1-flash', modelSettings: { providerData: { reasoning_effort: 'low' } } as any, tools: [t], outputType: out })
const t0 = Date.now()
try {
  const r = await run(a, 'echo hello and report', { maxTurns: 6 })
  console.log('ms:', Date.now() - t0)
  console.log('final:', JSON.stringify(r.finalOutput))
  console.log('items:', r.newItems.map((i: any) => i.type).join(','))
  console.log('rawResponses:', r.rawResponses.length, 'usage:', JSON.stringify(r.rawResponses.map((x: any) => x.usage)))
} catch (e: any) {
  console.error('ms:', Date.now() - t0, 'THREW:', e?.name, String(e?.message).slice(0, 400))
}

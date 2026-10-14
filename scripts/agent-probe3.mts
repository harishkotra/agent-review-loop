import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, tool, run, setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(join(here, '..', '.env'), 'utf8')
const key = env.match(/PARTICLE_API_KEY=(.+)/)?.[1]?.trim() ?? ''
setDefaultOpenAIClient(new OpenAI({ baseURL: 'https://api.particle.ai/v1', apiKey: key }) as any)
setOpenAIAPI('chat_completions')
const t = tool({ name: 'echo', description: 'echo text back', parameters: z.object({ text: z.string() }), execute: async ({ text }) => 'echoed: ' + text })
const a = new Agent({ name: 'probe', instructions: 'Use the echo tool to repeat the user message, then report what the tool returned.', model: 'deepseek-v4.1-flash', tools: [t], modelSettings: { providerData: { reasoning_effort: 'low' } } as any })
try {
  const r = await run(a, 'echo hello world', { maxTurns: 6 })
  console.log('final:', String(r.finalOutput).slice(0, 200))
  console.log('items:', r.newItems.map((i: any) => i.type).join(','))
} catch (e: any) {
  console.error('THREW:', e?.name, String(e?.message).slice(0, 500))
  console.error(String(e?.stack).slice(0, 800))
}

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
const mk = (n: string) => tool({ name: n, description: n + ' (stub for probe)', parameters: z.object({}), execute: async () => n + ' ok' })
const names = (process.env.TOOLS||'echo').split(',')
const a = new Agent({ name: 'reviser', instructions: 'You must call pull_document as your first action. Do not answer in text before tools.', model: 'deepseek-v4.1-flash', modelSettings: { providerData: { reasoning_effort: 'low' } } as any, tools: names.map(mk) })
const r = await run(a, 'fix the doc', { maxTurns: 6 })
console.log('tool calls:', r.newItems.filter((i: any) => i.type === 'tool_call_item').length, '| final:', String(r.finalOutput).slice(0, 120))

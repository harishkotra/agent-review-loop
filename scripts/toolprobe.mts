import { Agent, tool, run, setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'
setDefaultOpenAIClient(new OpenAI({ baseURL: 'http://localhost:11434/v1', apiKey: 'local' }) as any)
setOpenAIAPI('chat_completions')
const t = tool({ name: 'get_time', description: 'Get the current time', parameters: z.object({}), execute: async () => '12:34' })
const a = new Agent({ name: 'probe', instructions: 'Always use the get_time tool to answer time questions.', model: 'qwen3:4b', tools: [t] })
const r = await run(a, 'What time is it? Use the tool.')
console.log('output:', r.finalOutput)
console.log('tool calls:', r.newItems.filter((i: any) => i.type === 'tool_call').length)

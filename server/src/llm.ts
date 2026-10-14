import type { ModelConfig } from './types.js'

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatResult {
  text: string
  usage: ChatUsage
}

function url(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path
}

export async function chat(
  cfg: ModelConfig,
  messages: { role: string; content: string }[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const body: any = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.4,
  }
  if (opts.json) body.response_format = { type: 'json_object' }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  const res = await fetch(url(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url(cfg.baseUrl, '/chat/completions')}: ${text.slice(0, 2000)}`)
  }
  const json: any = await res.json()
  const text: string = json?.choices?.[0]?.message?.content ?? ''
  const usage: ChatUsage = json?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  return { text, usage }
}

/**
 * Real connectivity test: GET /models, fall back to a 1-token chat call.
 * Returns the exact error text on failure, including HTTP status.
 */
export async function testConnection(cfg: ModelConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url(cfg.baseUrl, '/models'), {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const json: any = await res.json().catch(() => null)
      const ids: string[] = Array.isArray(json?.data)
        ? json.data.map((m: any) => m.id)
        : Array.isArray(json?.models)
          ? json.models.map((m: any) => m.name ?? m.id ?? String(m))
          : []
      const has = ids.includes(cfg.model)
      return {
        ok: true,
        detail: `GET /models -> HTTP ${res.status}; ${ids.length} models listed; model "${cfg.model}" ${has ? 'present' : 'NOT in list (may still work)'}${ids.length && ids.length <= 40 ? ': ' + ids.join(', ') : ''}`,
      }
    }
    // some providers deny /models; try a real minimal chat call
    const chatRes = await fetch(url(cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (chatRes.ok) return { ok: true, detail: `GET /models -> HTTP ${res.status} (denied); fallback POST /chat/completions -> HTTP ${chatRes.status} OK` }
    const t = await chatRes.text().catch(() => '')
    return { ok: false, detail: `GET /models -> HTTP ${res.status} ${res.statusText}; fallback POST /chat/completions -> HTTP ${chatRes.status} ${chatRes.statusText}: ${t.slice(0, 1500)}` }
  } catch (err: any) {
    return { ok: false, detail: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` }
  }
}

/** Extract a single self-contained HTML document from a model reply. */
export function extractHtml(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence && /<!doctype|<html/i.test(fence[1])) t = fence[1].trim()
  const start = t.search(/<!doctype|<html/i)
  if (start > 0) t = t.slice(start)
  const end = t.lastIndexOf('</html>')
  if (end !== -1) t = t.slice(0, end + '</html>'.length)
  return t
}

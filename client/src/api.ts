async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || json?.error) {
    throw new Error(json?.error ?? `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`)
  }
  return json as T
}

export const api = {
  preflight: (slashdocs: any, model: any) => req<{ checks: any[] }>('POST', '/api/preflight', { slashdocs, model }),
  listExamples: () => req<{ items: any[] }>('GET', '/api/examples'),
  getExample: (name: string) => req<any>('GET', `/api/examples/${name}`),
  testConnection: (model: any) => req<{ ok: boolean; detail: string }>('POST', '/api/test-connection', model),
  createRun: (body: any) => req<any>('POST', '/api/runs', body),
  getRun: (id: string) => req<any>('GET', `/api/runs/${id}`),
  listRuns: () => req<{ items: any[] }>('GET', '/api/runs'),
  author: (id: string) => req<any>('POST', `/api/runs/${id}/author`),
  comments: (id: string) => req<any>('POST', `/api/runs/${id}/comments`),
  commentsCount: (id: string) => req<{ open_actionable: number; error?: string }>('GET', `/api/runs/${id}/comments/count`),
  revise: (id: string) => req<any>('POST', `/api/runs/${id}/revise`),
  scorecard: (id: string) => req<any>('POST', `/api/runs/${id}/scorecard`),
}

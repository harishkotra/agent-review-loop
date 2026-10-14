import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { loadSettings, saveSettings, PRESETS, type Settings } from './config'

type Tab = 'setup' | 'run' | 'verdicts' | 'scorecard' | 'publish'
const PHASES = ['author', 'review', 'revise', 'verify'] as const

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [tab, setTab] = useState<Tab>('setup')
  const [runId, setRunId] = useState<string | null>(null)
  const [data, setData] = useState<any>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [brief, setBrief] = useState('')
  const [existingDoc, setExistingDoc] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const poll = useRef<number | null>(null)

  useEffect(() => saveSettings(settings), [settings])

  const refresh = useCallback(async (id = runId) => {
    if (!id) return
    try {
      setData(await api.getRun(id))
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }, [runId])

  useEffect(() => {
    if (busy && runId) {
      poll.current = window.setInterval(() => refresh(), 2000)
      return () => { if (poll.current) clearInterval(poll.current) }
    }
  }, [busy, runId, refresh])

  async function guard(fn: () => Promise<void>, label: string) {
    setError(null)
    setBusy(label)
    try {
      await fn()
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  async function createRun() {
    await guard(async () => {
      const target = existingDoc.trim()
        ? { kind: 'existing', docId: existingDoc.trim() }
        : { kind: 'brief', brief }
      const rec = await api.createRun({ slashdocs: settings.slashdocs, model: settings.model, target })
      setRunId(rec.id)
      setData({ record: rec })
      setTab('run')
    }, 'create run')
  }

  async function author() {
    await guard(async () => {
      await api.author(runId!)
      setTab('run')
    }, 'author + publish v1')
  }

  async function recheck() {
    await guard(async () => {
      await api.comments(runId!)
    }, 'pull comments')
  }

  async function revise() {
    await guard(async () => {
      await api.revise(runId!)
      setTab('verdicts')
    }, 'revision run')
  }

  async function publishScorecard() {
    await guard(async () => {
      const res = await api.scorecard(runId!)
      setData((d: any) => ({ ...d, scorecard_url: res.url, scorecard_doc: res.doc_id }))
    }, 'publish scorecard')
  }

  const [runs, setRuns] = useState<any[]>([])
  const refreshRuns = useCallback(() => {
    api.listRuns().then(r => setRuns(r.items ?? [])).catch(() => {})
  }, [])
  useEffect(() => { refreshRuns() }, [refreshRuns, busy])

  async function openRun(id: string) {
    setRunId(id)
    setError(null)
    try {
      setData(await api.getRun(id))
      setTab('run')
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }

  const rec = data?.record
  const phaseIdx = rec ? (rec.phase === 'setup' ? 0 : rec.phase === 'authored' || rec.phase === 'review' ? (rec.phase === 'review' ? 1 : 0) : rec.phase === 'revised' ? 2 : 3) : 0
  const verdicts: any[] = data?.verdicts ?? []
  const metricsFile = data?.metrics
  const metrics = metricsFile?.metrics
  const mismatches: any[] = metricsFile?.mismatches ?? []
  const actionable: any[] = data?.comments_before ?? []

  return (
    <>
      <header>
        <h1>agent-review-loop</h1>
        {rec && <span className="muted">run {rec.id} · {rec.doc_id ?? 'no doc'} · {rec.model.model}</span>}
        <span className="grow" />
        <nav>
          {(['setup', 'run', 'verdicts', 'scorecard', 'publish'] as Tab[]).map(t => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <button className="btn" onClick={() => setShowSettings(true)}>settings</button>
      </header>
      <main>
        {busy && <div className="muted"><span className="spin" /> {busy}…</div>}
        {error && <div className="err">{error}</div>}
        {rec?.error && !busy && <div className="err">run error: {rec.error}</div>}

        {tab === 'setup' && (
          <div className="grid">
            <div className="panel">
              <h2>New run</h2>
              <label>Document brief (leave empty and fill the id to review an existing doc)</label>
              <textarea value={brief} onChange={e => setBrief(e.target.value)} placeholder="Release readiness review for checkout-service v2.4: include rollback plan, error budget, open incidents…" />
              <label>…or existing slashdocs document id/path</label>
              <input value={existingDoc} onChange={e => setExistingDoc(e.target.value)} placeholder="e.g. report.html" />
              <div style={{ marginTop: 10 }}>
                <button className="btn primary" disabled={!!busy} onClick={createRun}>
                  create run
                </button>
              </div>
              {runId && <p className="muted">run {runId} created — switch to Run to author v1.</p>}
              <h2 style={{ marginTop: 16 }}>Recent runs</h2>
              {runs.length === 0 && <p className="muted">none on disk yet</p>}
              {runs.length > 0 && (
                <table>
                  <tbody>
                    {runs.slice(0, 8).map(r => (
                      <tr key={r.id}>
                        <td>{r.id}</td>
                        <td>{r.phase}</td>
                        <td>{r.doc_id ?? '—'}</td>
                        <td>{r.model?.model}</td>
                        <td><button className="btn" onClick={() => openRun(r.id)}>open</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="panel">
              <h2>Active configuration</h2>
              <table>
                <tbody>
                  <tr><td>mode</td><td>{settings.slashdocs.mode}</td></tr>
                  <tr><td>model</td><td>{settings.model.model}</td></tr>
                  <tr><td>base url</td><td>{settings.model.baseUrl}</td></tr>
                  <tr><td>api key</td><td>{settings.model.apiKey ? '••••' + settings.model.apiKey.slice(-4) : 'not set'}</td></tr>
                  <tr><td>cli</td><td>{settings.slashdocs.cliPath}</td></tr>
                  <tr><td>docs folder</td><td>{settings.slashdocs.documentsFolder || 'default (~/slashdocs)'}</td></tr>
                </tbody>
              </table>
              <p className="muted">Everything above lives in your browser's localStorage. Click settings to change or test the connection.</p>
            </div>
          </div>
        )}

        {tab === 'run' && (
          !rec ? <div className="empty">no run yet — create one in Setup.</div> : (
            <>
              <div className="phase">
                {PHASES.map((p, i) => (
                  <span key={p} className={i < phaseIdx ? 'done' : i === phaseIdx ? 'now' : ''}>{p}</span>
                ))}
              </div>
              <div className="grid">
                <div className="panel">
                  <h2>Actions</h2>
                  <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <button className="btn primary" disabled={!!busy || rec.phase !== 'setup'} onClick={author}>
                      1. Author v1 from brief &amp; publish
                    </button>
                    {rec.doc_url && (
                      <div className="muted">viewer: <a href={rec.doc_url} target="_blank" rel="noreferrer">{rec.doc_url}</a></div>
                    )}
                    <button className="btn" disabled={!!busy || !rec.doc_id} onClick={recheck}>
                      2. Re-check comments ({actionable.length} unresolved actionable)
                    </button>
                    <button className="btn" disabled={!!busy || actionable.length === 0} onClick={revise}>
                      3. Run revision agent + score
                    </button>
                  </div>
                  <p className="muted" style={{ marginTop: 10 }}>
                    Open the viewer link, select the exact words you want changed, and leave anchored comments.
                    Then come back and press "Re-check comments".
                  </p>
                </div>
                <div className="panel">
                  <h2>Agent step log (live)</h2>
                  <div className="log">
                    {(rec.log ?? []).slice().reverse().map((l: any, i: number) => (
                      <div key={i}><span className="at">{l.at.slice(11, 19)}</span> [{l.step}] {l.detail}</div>
                    ))}
                    {(rec.log ?? []).length === 0 && <span className="muted">nothing yet</span>}
                  </div>
                </div>
              </div>
            </>
          )
        )}

        {tab === 'verdicts' && (
          verdicts.length === 0 ? <div className="empty">no verdicts yet — run the revision agent.</div> : (
            <>
              <div className="row" style={{ maxWidth: 500, marginBottom: 10 }}>
                {['all', 'edited', 'untouched', 'deleted', 'stale_anchor'].map(f => (
                  <button key={f} className={'pill' + (filter === f ? ' on' : '')} onClick={() => setFilter(f)}>{f}</button>
                ))}
              </div>
              <table>
                <thead>
                  <tr><th>verdict</th><th>anchor quote</th><th>human comment</th><th>agent claim</th><th>before @ anchor</th><th>after @ anchor</th></tr>
                </thead>
                <tbody>
                  {verdicts.filter(v => filter === 'all' || v.verdict === filter).map(v => (
                    <tr key={v.comment_id}>
                      <td className={`v-${v.verdict}`}>{v.verdict}</td>
                      <td>{v.quote}</td>
                      <td>{v.human_comment}</td>
                      <td>{v.agent_claim ?? '—'}</td>
                      <td>{v.before_snippet ?? '—'}</td>
                      <td>{v.after_snippet ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {verdicts.some(v => v.verdict === 'stale_anchor') && (
                <div className="err" style={{ marginTop: 10 }}>
                  {verdicts.filter(v => v.verdict === 'stale_anchor').map(v => (
                    <div key={v.comment_id}>{v.comment_id}: {v.note}</div>
                  ))}
                </div>
              )}
              {mismatches.length > 0 && (
                <div className="err" style={{ marginTop: 10 }}>
                  {mismatches.map(m => <div key={m.comment_id}>{m.comment_id}: {m.message}</div>)}
                </div>
              )}
            </>
          )
        )}

        {tab === 'scorecard' && (
          !metrics ? <div className="empty">no metrics yet — run the revision agent.</div> : (
            <>
              <div className="metrics">
                {[metrics.attribution_rate, metrics.collateral_churn, metrics.claim_accuracy, metrics.cost_per_attributed_fix, metrics.rounds_to_converge].map((m: any) => (
                  <div className="metric" key={m.key}>
                    <div className={'value' + (m.na_reason ? ' na' : '')}>{m.value}</div>
                    <div className="label">{m.label}</div>
                    <div className="detail">{m.na_reason ? 'N/A — ' + m.na_reason : m.detail}</div>
                  </div>
                ))}
              </div>
              <table>
                <thead><tr><th>comment</th><th>claim</th><th>computed</th></tr></thead>
                <tbody>
                  {verdicts.map(v => (
                    <tr key={v.comment_id}>
                      <td className="muted">{v.comment_id} — {v.quote?.slice(0, 80)}</td>
                      <td>{v.agent_claim ?? '—'}</td>
                      <td className={`v-${v.verdict}`}>{v.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mismatches.length > 0 && (
                <div className="err" style={{ marginTop: 10 }}>
                  {mismatches.map(m => <div key={m.comment_id}>{m.comment_id}: {m.message}</div>)}
                </div>
              )}
            </>
          )
        )}

        {tab === 'publish' && (
          <div className="panel" style={{ maxWidth: 640 }}>
            <h2>Publish scorecard to slashdocs</h2>
            {!metrics ? <div className="empty">no metrics yet — run the revision agent first.</div> : (
              <>
                <p className="muted">Pushes the scorecard as its own self-contained document.</p>
                <button className="btn primary" disabled={!!busy} onClick={publishScorecard}>publish scorecard</button>
                {data?.scorecard_url && (
                  <p style={{ marginTop: 10 }}>published: <a href={data.scorecard_url} target="_blank" rel="noreferrer">{data.scorecard_url}</a></p>
                )}
              </>
            )}
          </div>
        )}
      </main>

      {showSettings && <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
    </>
  )
}

function SettingsDialog({ settings, onChange, onClose }: { settings: Settings; onChange: (s: Settings) => void; onClose: () => void }) {
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; detail: string }>({ state: 'idle', detail: '' })
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })
  const setModel = (patch: Partial<Settings['model']>) => set({ model: { ...settings.model, ...patch } })
  const setSd = (patch: Partial<Settings['slashdocs']>) => set({ slashdocs: { ...settings.slashdocs, ...patch } })

  async function runTest() {
    setTest({ state: 'busy', detail: '' })
    try {
      const res = await api.testConnection(settings.model)
      setTest({ state: res.ok ? 'ok' : 'fail', detail: res.detail })
    } catch (e: any) {
      setTest({ state: 'fail', detail: String(e?.message ?? e) })
    }
  }

  return (
    <dialog open onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <div className="row">
        {PRESETS.map(p => (
          <button key={p.name} className="btn fixed" onClick={() => setModel({ baseUrl: p.baseUrl, model: p.model })}>{p.name}</button>
        ))}
      </div>
      <label>Base URL</label>
      <input value={settings.model.baseUrl} onChange={e => setModel({ baseUrl: e.target.value })} />
      <label>API key</label>
      <input type="password" value={settings.model.apiKey} onChange={e => setModel({ apiKey: e.target.value })} />
      <label>Model</label>
      <input value={settings.model.model} onChange={e => setModel({ model: e.target.value })} />
      <div style={{ marginTop: 8 }}>
        <button className="btn" onClick={runTest} disabled={test.state === 'busy'}>{test.state === 'busy' ? 'testing…' : 'Test connection'}</button>
      </div>
      {test.detail && <div className={test.state === 'ok' ? 'ok' : 'err'} style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{test.detail}</div>}
      <hr style={{ borderColor: 'var(--border)' }} />
      <label>slashdocs mode</label>
      <select value={settings.slashdocs.mode} onChange={e => setSd({ mode: e.target.value as any })}>
        <option value="local">local</option>
        <option value="server">server</option>
      </select>
      <label>CLI path</label>
      <input value={settings.slashdocs.cliPath} onChange={e => setSd({ cliPath: e.target.value })} />
      {settings.slashdocs.mode === 'local' && (
        <>
          <label>documents folder (empty = ~/slashdocs)</label>
          <input value={settings.slashdocs.documentsFolder} onChange={e => setSd({ documentsFolder: e.target.value })} />
        </>
      )}
      {settings.slashdocs.mode === 'server' && (
        <>
          <label>server URL</label>
          <input value={settings.slashdocs.serverUrl} onChange={e => setSd({ serverUrl: e.target.value })} placeholder="https://slashdocs.example.com" />
          <label>service-account token (slashdocs_sa_…)</label>
          <input type="password" value={settings.slashdocs.token} onChange={e => setSd({ token: e.target.value })} />
        </>
      )}
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <span className="grow" />
        <button className="btn" onClick={onClose}>close</button>
      </div>
    </dialog>
  )
}

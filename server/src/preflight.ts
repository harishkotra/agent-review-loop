import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ModelConfig, SlashdocsConfig } from './types.js'
import { testConnection } from './llm.js'

const execFileP = promisify(execFile)

export interface Check {
  name: string
  ok: boolean | null // null = skipped / not applicable
  detail: string
  fix?: string
}

export async function runPreflight(sd: SlashdocsConfig, model?: ModelConfig): Promise<Check[]> {
  const checks: Check[] = []

  // 1. node version
  const major = Number(process.versions.node.split('.')[0])
  checks.push({
    name: 'node',
    ok: major >= 20,
    detail: `v${process.versions.node}`,
    fix: major >= 20 ? undefined : 'Install Node 20+ (https://nodejs.org)',
  })

  // 2. slashdocs CLI
  const cli = sd.cliPath || 'slashdocs'
  let cliOk = false
  let cliDetail = ''
  try {
    const { stdout } = await execFileP(cli, ['version'], { timeout: 15_000 })
    cliOk = true
    cliDetail = stdout.trim()
  } catch (err: any) {
    cliDetail = String(err?.stderr ?? err?.message ?? err).split('\n')[0]
  }
  checks.push({
    name: 'slashdocs CLI',
    ok: cliOk,
    detail: cliDetail || cli,
    fix: cliOk
      ? undefined
      : 'Install the slashdocs CLI and make sure it is on PATH (or set its path in Settings). See https://github.com/razorpay/slashdocs — e.g. `git clone … && make build-cli && cp bin/slashdocs ~/.local/bin/`',
  })

  // 3. slashdocs reachability (local server / folder, or server mode auth)
  if (sd.mode === 'local') {
    try {
      const { stdout } = await execFileP(cli, ['local', 'status'], { timeout: 15_000 })
      const serving = stdout.match(/serving ([^,\)]+)/)?.[1]?.trim()
      const want = sd.documentsFolder ? resolve(process.cwd(), sd.documentsFolder) : join(homedir(), 'slashdocs')
      const match = serving && existsSync(serving) && resolve(serving) === want
      checks.push({
        name: 'slashdocs local',
        ok: !!serving,
        detail: stdout.trim().split('\n')[0],
        fix: match
          ? undefined
          : serving
            ? `local server is serving "${serving}" but Settings ask for "${want}" — align them or run \`slashdocs local stop\``
            : 'run `slashdocs local start` (the app tries this automatically on first run)',
      })
    } catch (err: any) {
      checks.push({ name: 'slashdocs local', ok: false, detail: String(err?.message ?? err).split('\n')[0], fix: 'run `slashdocs local start`' })
    }
  } else {
    const ok = !!sd.serverUrl && !!sd.token
    checks.push({
      name: 'slashdocs server',
      ok,
      detail: ok ? `${sd.serverUrl} (token set)` : 'server URL and service-account token required',
      fix: ok ? undefined : 'set the server URL and a slashdocs_sa_… token in Settings (SLASHDOCS_SERVER / SLASHDOCS_TOKEN)',
    })
  }

  // 4. model connectivity (only when a key or local endpoint is configured)
  if (model?.baseUrl) {
    const res = await testConnection(model)
    checks.push({
      name: `model (${model.model})`,
      ok: res.ok,
      detail: res.detail.slice(0, 300),
      fix: res.ok ? undefined : 'check base URL / API key in Settings, then Test connection again',
    })
  } else {
    checks.push({ name: 'model', ok: null, detail: 'not configured', fix: 'open Settings and configure a base URL + model' })
  }

  return checks
}

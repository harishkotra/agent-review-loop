import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import type { SdComment, SlashdocsConfig } from './types.js'

const execFileP = promisify(execFile)

export class CliError extends Error {
  exitCode: number
  stderr: string
  constructor(message: string, exitCode: number, stderr: string) {
    super(message)
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** Exit code 5 = version conflict (server mode). */
export const EXIT_VERSION_CONFLICT = 5

interface CliResult {
  stdout: string
  json: any
}

/**
 * Spawn the slashdocs CLI with an argument ARRAY (never a shell string),
 * always with --json, 60s timeout.
 */
export async function runCli(
  cfg: SlashdocsConfig,
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<CliResult> {
  const global: string[] = cfg.mode === 'local' ? ['--local'] : []
  const full = [...global, ...args.filter(a => a !== ''), '--json']
  try {
    const { stdout } = await execFileP(cfg.cliPath || 'slashdocs', full, {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...(cfg.mode === 'server' && cfg.serverUrl ? { SLASHDOCS_SERVER: cfg.serverUrl } : {}),
        ...(cfg.mode === 'server' && cfg.token ? { SLASHDOCS_TOKEN: cfg.token } : {}),
      },
    })
    let json: any = null
    const trimmed = stdout.trim()
    if (trimmed) {
      try {
        json = JSON.parse(trimmed)
      } catch {
        json = null
      }
    }
    return { stdout, json }
  } catch (err: any) {
    const code = typeof err.code === 'number' ? err.code : 1
    const stderr = String(err.stderr ?? err.message ?? '').trim()
    const msg = stderr || err.message || `slashdocs exited ${code}`
    if (opts.allowFail) throw new CliError(msg, code, stderr)
    throw new CliError(msg, code, stderr)
  }
}

/** Make sure the local server is running and serving the configured folder. */
export async function ensureLocal(cfg: SlashdocsConfig): Promise<string> {
  const args = ['local', 'start']
  if (cfg.documentsFolder) args.push('--dir', cfg.documentsFolder)
  try {
    const { stdout } = await runCli({ ...cfg, mode: 'local' }, args)
    return stdout
  } catch (err) {
    // already running with same dir is fine; anything else surfaces
    const msg = err instanceof CliError ? err.stderr || err.message : String(err)
    if (/already running|is running/.test(msg)) return msg
    throw err
  }
}

export async function docsList(cfg: SlashdocsConfig): Promise<any> {
  const { json } = await runCli(cfg, ['docs', 'list'])
  return json
}

export async function docsShow(cfg: SlashdocsConfig, docId: string): Promise<any> {
  const { json } = await runCli(cfg, ['docs', 'show', docId])
  return json
}

export async function docsPull(cfg: SlashdocsConfig, docId: string, outPath: string): Promise<string> {
  await runCli(cfg, ['docs', 'pull', docId, '--out', outPath])
  return outPath
}

export async function docsCreate(
  cfg: SlashdocsConfig,
  filePath: string,
  title: string,
): Promise<{ id: string; current_version_id: string | null; url: string | null }> {
  const { json } = await runCli(cfg, ['docs', 'create', filePath, '--title', title])
  return json
}

export interface PushResult {
  ok: boolean
  conflict: boolean
  json: any
  error?: string
}

/**
 * Push a new version. On server mode exit code 5 (version conflict) the
 * caller decides the re-pull/re-apply/retry-once policy. Never blind-retry.
 */
export async function docsPush(
  cfg: SlashdocsConfig,
  docId: string,
  filePath: string,
  summary: string,
): Promise<PushResult> {
  try {
    const { json } = await runCli(cfg, ['docs', 'push', docId, filePath, '--summary', summary])
    return { ok: true, conflict: false, json }
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT_VERSION_CONFLICT) {
      return { ok: false, conflict: true, json: null, error: err.stderr || err.message }
    }
    throw err
  }
}

export async function docsCommentsList(
  cfg: SlashdocsConfig,
  docId: string,
  status?: 'open' | 'resolved',
): Promise<SdComment[]> {
  const args = ['docs', 'comments', 'list', docId]
  if (status) args.push('--status', status)
  const { json } = await runCli(cfg, args)
  const items = Array.isArray(json) ? json : (json?.items ?? [])
  return items as SdComment[]
}

export async function docsCommentsResolve(cfg: SlashdocsConfig, docId: string, ids: string[]): Promise<any> {
  if (ids.length === 0) return null
  const { json } = await runCli(cfg, ['docs', 'comments', 'resolve', docId, ...ids])
  return json
}

export async function docsLink(cfg: SlashdocsConfig, docId: string): Promise<string | null> {
  try {
    const { json } = await runCli(cfg, ['docs', 'link', docId])
    return json?.url ?? null
  } catch {
    return null
  }
}

/** Create a comment through the CLI (used by the smoke script). */
export async function docsCommentCreate(
  cfg: SlashdocsConfig,
  docId: string,
  opts: { quote: string; body: string; prefix?: string; suffix?: string; version?: string },
): Promise<SdComment> {
  const args = ['docs', 'comments', 'create', docId, '--quote', opts.quote, '--body', opts.body]
  if (opts.prefix) args.push('--prefix', opts.prefix)
  if (opts.suffix) args.push('--suffix', opts.suffix)
  if (opts.version) args.push('--version', opts.version)
  const { json } = await runCli(cfg, args)
  return json as SdComment
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text, 'utf8')
}

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunRecord } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
export const RUNS_DIR = process.env.ARL_RUNS_DIR || join(here, '..', '..', 'runs')

export function runDir(id: string): string {
  return join(RUNS_DIR, id)
}

export function createRunDir(id: string): string {
  const dir = runDir(id)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function saveRecord(rec: RunRecord): void {
  writeFileSync(join(runDir(rec.id), 'run.json'), JSON.stringify(rec, null, 2))
}

export function loadRecord(id: string): RunRecord {
  return JSON.parse(readFileSync(join(runDir(id), 'run.json'), 'utf8'))
}

export function writeArtifact(id: string, name: string, content: string): string {
  const p = join(runDir(id), name)
  writeFileSync(p, content)
  return p
}

export function readArtifact(id: string, name: string): string | null {
  const p = join(runDir(id), name)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

export function readJsonArtifact<T>(id: string, name: string): T | null {
  const raw = readArtifact(id, name)
  return raw ? (JSON.parse(raw) as T) : null
}

export function listRuns(): RunRecord[] {
  if (!existsSync(RUNS_DIR)) return []
  return readdirSync(RUNS_DIR)
    .filter(d => existsSync(join(RUNS_DIR, d, 'run.json')))
    .map(d => loadRecord(d))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export function logStep(rec: RunRecord, step: string, detail: string): void {
  rec.log.push({ at: new Date().toISOString(), step, detail })
  saveRecord(rec)
}

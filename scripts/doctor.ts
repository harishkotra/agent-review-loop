/**
 * npm run doctor — environment preflight with actionable output.
 * Reads defaults from the repo-root .env; the UI runs the same checks live.
 */
import dotenv from 'dotenv'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPreflight } from '../server/src/preflight.js'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const checks = await runPreflight(
  {
    mode: (process.env.SLASHDOCS_MODE as any) || 'local',
    cliPath: process.env.SLASHDOCS_CLI || 'slashdocs',
    documentsFolder: process.env.SLASHDOCS_DIR || '',
    serverUrl: process.env.SLASHDOCS_SERVER || '',
    token: process.env.SLASHDOCS_TOKEN || '',
  },
  {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.particle.ai/v1',
    apiKey: process.env.PARTICLE_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'deepseek-v4.1-flash',
  },
)

const icon = (ok: boolean | null) => (ok === null ? '–  ' : ok ? '✓  ' : '✗  ')
console.log('\nagent-review-loop doctor\n' + '─'.repeat(48))
for (const c of checks) {
  console.log(`${icon(c.ok)} ${c.name.padEnd(28)} ${c.detail}`)
  if (!c.ok && c.fix) console.log(`   ↳ fix: ${c.fix}`)
}
const failed = checks.filter(c => c.ok === false).length
console.log(failed === 0 ? '\nAll checks passed — run `npm run dev` and open http://localhost:5173\n' : `\n${failed} check(s) need attention (see fixes above)\n`)
process.exit(failed === 0 ? 0 : 1)

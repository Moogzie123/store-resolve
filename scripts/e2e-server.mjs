import { Miniflare } from 'miniflare'
import { readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const persistence = resolve(root, 'work/e2e-d1')
await rm(persistence, { recursive: true, force: true })
const mf = new Miniflare({
  modules: true,
  scriptPath: resolve(root, 'work/worker/worker.js'),
  host: '127.0.0.1',
  port: 8787,
  d1Databases: ['DB'],
  d1Persist: persistence,
  bindings: { DEV_AUTH_USER_ID: 'father' },
})
const db = await mf.getD1Database('DB')
await db.exec(await readFile(resolve(root, 'drizzle/0001_initial.sql'), 'utf8'))
await db.exec(await readFile(resolve(root, 'drizzle/0002_persistence_and_auth.sql'), 'utf8'))
await mf.ready
const vite = spawn(
  resolve(root, 'node_modules/.bin/vite.cmd'),
  ['preview', '--host', '127.0.0.1', '--configLoader', 'runner'],
  { cwd: root, stdio: 'inherit', shell: true },
)
const stop = async () => {
  vite.kill()
  await mf.dispose()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
vite.on('exit', async (code) => {
  await mf.dispose()
  process.exit(code ?? 0)
})

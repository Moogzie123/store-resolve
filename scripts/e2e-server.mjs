import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const persistence = resolve(root, 'work/e2e-d1')
const wrangler = resolve(root, 'node_modules/.bin/wrangler.cmd')
const vite = resolve(root, 'node_modules/.bin/vite.cmd')
await rm(persistence, { recursive: true, force: true })

const run = (command, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: true })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)),
    )
  })

await run(wrangler, [
  'd1',
  'migrations',
  'apply',
  'store-resolve',
  '--local',
  '--persist-to',
  persistence,
])

const worker = spawn(
  wrangler,
  [
    'dev',
    '--local',
    '--port',
    '8787',
    '--persist-to',
    persistence,
    '--var',
    'DEV_AUTH_USER_ID:father',
  ],
  { cwd: root, stdio: 'inherit', shell: true },
)
const client = spawn(vite, ['preview', '--host', '127.0.0.1', '--configLoader', 'runner'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
})

const stop = () => {
  worker.kill()
  client.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
worker.on('exit', (code) => {
  client.kill()
  process.exit(code ?? 0)
})
client.on('exit', (code) => {
  worker.kill()
  process.exit(code ?? 0)
})

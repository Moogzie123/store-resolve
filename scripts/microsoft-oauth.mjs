import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'

export const authority = 'https://login.microsoftonline.com/consumers'
export const scopes =
  'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send'

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' }
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const safeJson = async (response) => {
  const value = await response.json().catch(() => null)
  return value && typeof value === 'object' ? value : {}
}

export async function requestDeviceCode(clientId, fetchImpl = fetch) {
  const response = await fetchImpl(`${authority}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: formHeaders,
    body: new URLSearchParams({ client_id: clientId, scope: scopes }),
  })
  const body = await safeJson(response)
  if (
    !response.ok ||
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    typeof body.verification_uri !== 'string'
  ) {
    throw new Error(
      'Microsoft device authorization failed. Confirm Authentication > Allow public client flows is Yes.',
    )
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 900,
    interval: typeof body.interval === 'number' ? Math.max(body.interval, 1) : 5,
  }
}

export async function pollForRefreshToken(clientId, device, fetchImpl = fetch, wait = sleep) {
  const deadline = Date.now() + device.expiresIn * 1000
  let intervalSeconds = device.interval
  while (Date.now() < deadline) {
    await wait(intervalSeconds * 1000)
    const response = await fetchImpl(`${authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.deviceCode,
      }),
    })
    const body = await safeJson(response)
    if (response.ok && typeof body.refresh_token === 'string') return body.refresh_token
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      intervalSeconds += 5
      continue
    }
    if (body.error === 'authorization_declined')
      throw new Error('Microsoft authorization was declined.')
    if (body.error === 'expired_token') throw new Error('The Microsoft device code expired.')
    throw new Error('Microsoft device authorization failed during token polling.')
  }
  throw new Error('The Microsoft device code expired.')
}

export async function storeRefreshToken(refreshToken, cwd = process.cwd()) {
  const wranglerPath = resolve(cwd, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  await new Promise((resolveStore, reject) => {
    const child = spawn(process.execPath, [wranglerPath, 'secret', 'put', 'MS_REFRESH_TOKEN'], {
      cwd,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false,
    })
    child.stdin.end(`${refreshToken}\n`)
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolveStore() : reject(new Error('Wrangler could not store MS_REFRESH_TOKEN.')),
    )
  })
}

export async function main() {
  let clientId = process.env.MS_CLIENT_ID?.trim()
  if (!clientId) {
    const input = createInterface({ input: process.stdin, output: process.stdout })
    clientId = (await input.question('Microsoft Application client ID: ')).trim()
    input.close()
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
    throw new Error('MS_CLIENT_ID must be the Application (client) ID GUID.')

  const device = await requestDeviceCode(clientId)
  console.log(`MICROSOFT_DEVICE_LOGIN_URL=${device.verificationUri}`)
  console.log(`MICROSOFT_DEVICE_CODE=${device.userCode}`)
  const refreshToken = await pollForRefreshToken(clientId, device)
  await storeRefreshToken(refreshToken)
  console.log('MS_REFRESH_TOKEN was written directly to Cloudflare and was not displayed.')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Microsoft device authorization failed.')
    process.exitCode = 1
  })
}

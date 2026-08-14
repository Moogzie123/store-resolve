import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const clientId = process.env.MS_CLIENT_ID?.trim()
if (!clientId) throw new Error('Set MS_CLIENT_ID in this terminal before running this helper.')

const redirectUri = 'http://localhost:8789'
const authority = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const scopes =
  'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send'
const verifier = randomBytes(48).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = randomBytes(24).toString('base64url')

const authorize = new URL(`${authority}/authorize`)
authorize.search = new URLSearchParams({
  client_id: clientId,
  response_type: 'code',
  redirect_uri: redirectUri,
  response_mode: 'query',
  scope: scopes,
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
}).toString()

const wrangler = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', redirectUri)
  if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    response.writeHead(400, { 'content-type': 'text/plain' })
    response.end('OAuth validation failed. Return to the terminal.')
    server.close()
    return
  }
  try {
    const tokenResponse = await fetch(`${authority}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        code: url.searchParams.get('code'),
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: scopes,
        code_verifier: verifier,
      }),
    })
    const token = await tokenResponse.json()
    if (!tokenResponse.ok || typeof token.refresh_token !== 'string')
      throw new Error(`Token exchange failed (${tokenResponse.status}).`)
    await new Promise((resolve, reject) => {
      const child = spawn(wrangler, ['secret', 'put', 'MS_REFRESH_TOKEN'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'inherit', 'inherit'],
        shell: false,
      })
      child.stdin.end(`${token.refresh_token}\n`)
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Wrangler failed.'))))
    })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('StoreResolve authorization saved securely. You may close this tab.')
    console.log('MS_REFRESH_TOKEN was written directly to Cloudflare and was not displayed.')
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('Authorization failed. Return to the terminal for the error.')
    console.error(error instanceof Error ? error.message : String(error))
  } finally {
    server.close()
  }
})

server.listen(8789, '127.0.0.1', () => {
  console.log('Open this Microsoft authorization URL in your browser:')
  console.log(authorize.toString())
  console.log('Waiting on http://localhost:8789 ...')
})

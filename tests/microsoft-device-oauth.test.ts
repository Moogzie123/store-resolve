import { describe, expect, it, vi } from 'vitest'
import {
  authority,
  pollForRefreshToken,
  requestDeviceCode,
  scopes,
} from '../scripts/microsoft-oauth.mjs'

const clientId = '00000000-0000-4000-8000-000000000001'

describe('Microsoft device-code OAuth bootstrap', () => {
  it('requests the consumer device endpoint with the exact delegated scopes', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'opaque-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200 },
      ),
    )
    const result = await requestDeviceCode(clientId, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${authority}/oauth2/v2.0/devicecode`)
    const body = new URLSearchParams(String(init.body))
    expect(body.get('client_id')).toBe(clientId)
    expect(body.get('scope')).toBe(scopes)
    expect(String(init.body)).not.toContain('client_secret')
    expect(result).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://microsoft.com/devicelogin',
    })
  })

  it('handles pending and slow-down responses without logging tokens', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'never-log-access', refresh_token: 'refresh-secret' }),
          { status: 200 },
        ),
      )
    const wait = vi.fn().mockResolvedValue(undefined)
    const token = await pollForRefreshToken(
      clientId,
      {
        deviceCode: 'opaque',
        userCode: 'ABCD',
        verificationUri: 'https://example.invalid',
        expiresIn: 900,
        interval: 1,
      },
      fetch,
      wait,
    )
    expect(token).toBe('refresh-secret')
    expect(wait).toHaveBeenNthCalledWith(1, 1000)
    expect(wait).toHaveBeenNthCalledWith(2, 1000)
    expect(wait).toHaveBeenNthCalledWith(3, 6000)
  })

  it('reports the public-client Azure setting when device authorization is rejected', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'unauthorized_client' }), { status: 400 }),
      )
    await expect(requestDeviceCode(clientId, fetch)).rejects.toThrow('Allow public client flows')
  })
})

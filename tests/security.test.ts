import { describe, expect, it, vi, afterEach } from 'vitest'
import { authenticate, canAdmin, canViewComplaint, maskEmail, maskPhone } from '../worker/auth'
import { TwilioSmsProvider, validateTwilioSignature } from '../worker/providers'
import type { D1Database } from '../worker/d1'
import type { Notification, User } from '../src/lib/types'
import { applyTwilioCallback } from '../worker/callbacks'

const owner: User = {
  id: 'father',
  name: 'Father',
  email: 'father@example.invalid',
  phone: '',
  role: 'OWNER',
  active: true,
  smsEnabled: false,
  timezone: 'America/New_York',
}
describe('authentication and authorization', () => {
  it('rejects requests without a verified Access identity or explicit local bypass', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database
    expect(await authenticate(new Request('https://app.test/api'), db, {})).toBeNull()
    expect(db.prepare).not.toHaveBeenCalled()
  })
  it('enforces owner, view-only, and manager store boundaries', () => {
    expect(canAdmin(owner)).toBe(true)
    expect(canAdmin({ ...owner, role: 'VIEW_ONLY' })).toBe(false)
    expect(
      canViewComplaint(
        { ...owner, id: 'manager-1', role: 'STORE_MANAGER' },
        'store-1',
        'manager-2',
      ),
    ).toBe(false)
    expect(
      canViewComplaint(
        { ...owner, id: 'manager-1', role: 'STORE_MANAGER' },
        'store-1',
        'manager-1',
      ),
    ).toBe(true)
  })
  it('masks complete contact information', () => {
    expect(maskPhone('+15551234821')).toBe('(***) ***-4821')
    expect(maskEmail('father@example.com')).toBe('f***@example.com')
  })
  it('updates a notification once and treats a repeated callback as a duplicate', async () => {
    let inserted = true
    let updates = 0
    const statement = {
      bind: vi.fn(function (this: unknown) {
        return this
      }),
      first: vi.fn().mockResolvedValue({ id: 'n-1', status: 'SENT' }),
      run: vi.fn(async () => ({
        success: true,
        results: [],
        meta: { changes: inserted ? ((inserted = false), 1) : 0 },
      })),
    }
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith('UPDATE')) updates++
        return statement
      }),
    } as unknown as D1Database
    expect(await applyTwilioCallback(db, { messageSid: 'SM123', messageStatus: 'delivered' })).toBe(
      'UPDATED',
    )
    expect(await applyTwilioCallback(db, { messageSid: 'SM123', messageStatus: 'delivered' })).toBe(
      'DUPLICATE',
    )
    expect(updates).toBe(1)
  })
})
describe('Twilio boundary', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('does not call Twilio without complete credentials', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const provider = new TwilioSmsProvider({})
    await expect(provider.send({} as Notification, '+15551234567')).rejects.toThrow(
      'not configured',
    )
    expect(fetch).not.toHaveBeenCalled()
  })
  it('captures the provider message ID without claiming delivery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ sid: 'SM123' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    const provider = new TwilioSmsProvider({
      accountSid: 'AC123',
      authToken: 'secret',
      from: '+15550000000',
    })
    const result = await provider.send({ message: 'test' } as Notification, '+15551234567')
    expect(result).toEqual({ providerMessageId: 'SM123', status: 'SENT' })
  })
  it('validates callback signatures and rejects altered payloads', async () => {
    const token = 'secret'
    const url = 'https://app.test/api/twilio/status'
    const params = { MessageSid: 'SM123', MessageStatus: 'delivered' }
    const payload = url + 'MessageSidSM123MessageStatusdelivered'
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(token),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    )
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const signature = btoa(String.fromCharCode(...Array.from(new Uint8Array(digest))))
    expect(await validateTwilioSignature(token, signature, url, params)).toBe(true)
    expect(
      await validateTwilioSignature(token, signature, url, { ...params, MessageStatus: 'failed' }),
    ).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticate, canAdmin, canViewComplaint, maskEmail, maskPhone } from '../worker/auth'
import { SignalWireSmsProvider, type SignalWireMessage } from '../worker/providers'
import type { D1Database, D1PreparedStatement } from '../worker/d1'
import type { Notification, User } from '../src/lib/types'
import { applySignalWireCallback } from '../worker/callbacks'

const projectId = '11111111-2222-4333-8444-555555555555'
const messageSid = 'b155a7c4-17d9-4ba0-a51a-d2d7d36652df'
const sender = '+15550000000'
const recipient = '+15551234567'
const config = {
  projectId,
  apiToken: 'test-api-token',
  spaceUrl: 'example.signalwire.com',
  from: sender,
  publicBaseUrl: 'https://store-resolve.example.com',
}
const providerMessage = (status: string): SignalWireMessage => ({
  sid: messageSid,
  accountSid: projectId,
  status,
  from: sender,
  to: recipient,
})
const notification = { message: 'test' } as Notification

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

function callbackDb(
  options: {
    currentStatus?: string
    phone?: string
    duplicate?: boolean
    missing?: boolean
  } = {},
) {
  let updates = 0
  const prepared: Array<{ sql: string; values: unknown[] }> = []
  const db = {
    prepare: vi.fn((sql: string) => {
      const record = { sql, values: [] as unknown[] }
      prepared.push(record)
      const statement = {
        bind: vi.fn((...values: unknown[]) => {
          record.values = values
          return statement
        }),
        all: vi.fn(),
        first: vi.fn(async () =>
          options.missing
            ? null
            : {
                id: 'n-1',
                status: options.currentStatus ?? 'SENT',
                recipient_user_id: 'father',
                recipient_phone: options.phone ?? recipient,
              },
        ),
        run: vi.fn(async () => {
          if (sql.startsWith('UPDATE')) updates++
          return {
            success: true,
            results: [],
            meta: { changes: sql.startsWith('INSERT') && options.duplicate ? 0 : 1 },
          }
        }),
      } as unknown as D1PreparedStatement
      return statement
    }),
  } as unknown as D1Database
  return { db, prepared, updates: () => updates }
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
})

describe('SignalWire callback persistence', () => {
  it.each([
    ['queued', 'SENT'],
    ['sent', 'SENT'],
    ['delivered', 'DELIVERED'],
    ['failed', 'FAILED'],
    ['undelivered', 'UNDELIVERED'],
  ])('maps authenticated provider status %s to %s', async (providerStatus, storedStatus) => {
    const { db, prepared, updates } = callbackDb()
    expect(await applySignalWireCallback(db, providerMessage(providerStatus), sender)).toBe(
      'UPDATED',
    )
    expect(updates()).toBe(1)
    const update = prepared.find((entry) => entry.sql.startsWith('UPDATE'))
    expect(update?.values[0]).toBe(storedStatus)
  })
  it('treats a repeated callback as a duplicate', async () => {
    const { db, updates } = callbackDb({ duplicate: true })
    expect(await applySignalWireCallback(db, providerMessage('delivered'), sender)).toBe(
      'DUPLICATE',
    )
    expect(updates()).toBe(0)
  })
  it('rejects unknown message IDs and mismatched sender or recipient identity', async () => {
    expect(
      await applySignalWireCallback(
        callbackDb({ missing: true }).db,
        providerMessage('sent'),
        sender,
      ),
    ).toBe('NOT_FOUND')
    expect(
      await applySignalWireCallback(
        callbackDb().db,
        { ...providerMessage('sent'), from: '+15559999999' },
        sender,
      ),
    ).toBe('AUTHENTICITY_FAILED')
    expect(
      await applySignalWireCallback(
        callbackDb({ phone: '+15558888888' }).db,
        providerMessage('sent'),
        sender,
      ),
    ).toBe('AUTHENTICITY_FAILED')
  })
  it('does not regress a terminal state', async () => {
    const { db, updates } = callbackDb({ currentStatus: 'DELIVERED' })
    expect(await applySignalWireCallback(db, providerMessage('sent'), sender)).toBe('IGNORED')
    expect(updates()).toBe(0)
  })
})

describe('SignalWire boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not call SignalWire without structurally valid configuration', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const invalid of [
      {},
      { ...config, projectId: 'not-a-uuid' },
      { ...config, spaceUrl: 'http://example.signalwire.com' },
      { ...config, spaceUrl: 'https://example.com' },
      { ...config, from: '5551234567' },
      { ...config, publicBaseUrl: 'http://store-resolve.example.com' },
    ]) {
      const provider = new SignalWireSmsProvider(invalid)
      expect(provider.ready).toBe(false)
      await expect(provider.send(notification, recipient)).rejects.toThrow('not configured')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends the exact message with a status callback and records acceptance only', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sid: messageSid,
          account_sid: projectId,
          status: 'queued',
          from: sender,
          to: recipient,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const provider = new SignalWireSmsProvider(config)
    expect(provider.ready).toBe(true)
    expect(await provider.send(notification, recipient)).toEqual({
      providerMessageId: messageSid,
      status: 'SENT',
    })
    const [url, request] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `https://example.signalwire.com/api/laml/2010-04-01/Accounts/${projectId}/Messages`,
    )
    const form = request.body as URLSearchParams
    expect(Object.fromEntries(form)).toEqual({
      To: recipient,
      From: sender,
      Body: 'test',
      StatusCallback: 'https://store-resolve.example.com/api/signalwire/status',
    })
  })

  it('retrieves the authoritative provider record before callback mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sid: messageSid,
          account_sid: projectId,
          status: 'delivered',
          from: sender,
          to: recipient,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await new SignalWireSmsProvider(config).retrieveMessage(messageSid)
    expect(result).toMatchObject({
      sid: messageSid,
      status: 'delivered',
      from: sender,
      to: recipient,
    })
    expect(fetch).toHaveBeenCalledWith(
      `https://example.signalwire.com/api/laml/2010-04-01/Accounts/${projectId}/Messages/${messageSid}.json`,
      expect.objectContaining({ headers: { authorization: expect.stringMatching(/^Basic /) } }),
    )
  })

  it('returns safe provider errors without leaking credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: `denied ${config.apiToken}` }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    await expect(new SignalWireSmsProvider(config).send(notification, recipient)).rejects.toThrow(
      'denied [redacted]',
    )
  })
})

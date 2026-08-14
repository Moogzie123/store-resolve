import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftGraphProvider, normalizeGraphMessage } from '../worker/microsoft-graph'
import { pollEmail } from '../worker/ingestion'
import type { D1Database } from '../worker/d1'

const config = {
  clientId: '00000000-0000-0000-0000-000000000001',
  refreshToken: 'refresh-token',
  mailboxAddress: 'complaints@example.invalid',
  tenant: 'consumers',
}

const tokenResponse = () =>
  new Response(JSON.stringify({ access_token: 'access-token' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('Microsoft Graph delegated mail provider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('refreshes against the consumer authority with only the required delegated scopes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mail: config.mailboxAddress }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetch)
    await new MicrosoftGraphProvider(config).verifyConnection()
    const [url, request] = fetch.mock.calls[0] as [string, RequestInit]
    const form = new URLSearchParams(String(request.body))
    expect(url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token')
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('scope')?.split(' ')).toEqual([
      'offline_access',
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.Send',
    ])
    expect(form.has('client_secret')).toBe(false)
  })

  it('retrieves immutable message, conversation, addressing, headers and body metadata', async () => {
    const graphMessage = {
      id: 'immutable-message-id',
      conversationId: 'conversation-id',
      internetMessageId: '<internet-id@example.invalid>',
      receivedDateTime: '2026-08-14T12:00:00Z',
      subject: 'Complaint reference DD-1001',
      from: { emailAddress: { name: 'Guest Care', address: 'guest@example.invalid' } },
      toRecipients: [{ emailAddress: { address: config.mailboxAddress } }],
      body: { contentType: 'html', content: '<p>Complaint: slow service</p>' },
      internetMessageHeaders: [{ name: 'References', value: '<prior@example.invalid>' }],
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify(graphMessage), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const message = await new MicrosoftGraphProvider(config).getMessage(graphMessage.id)
    expect(message).toMatchObject({
      id: graphMessage.id,
      threadId: graphMessage.conversationId,
      sender: 'Guest Care <guest@example.invalid>',
      recipients: config.mailboxAddress,
      textBody: 'Complaint: slow service',
      references: '<prior@example.invalid>',
    })
    const [, request] = fetch.mock.calls[1] as [string, RequestInit]
    expect(new Headers(request.headers).get('Prefer')).toContain('IdType="ImmutableId"')
    expect(fetch.mock.calls[1][0]).toContain('internetMessageHeaders')
  })

  it('replies in the original message context and never retries a send', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetch)
    const message = normalizeGraphMessage({
      id: 'immutable-message-id',
      conversationId: 'conversation-id',
      receivedDateTime: '2026-08-14T12:00:00Z',
      from: { emailAddress: { address: 'guest@example.invalid' } },
      body: { contentType: 'text', content: 'Complaint: slow service' },
    })
    await expect(
      new MicrosoftGraphProvider(config).sendAcknowledgment(message, 'Neutral acknowledgment'),
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    const [url, request] = fetch.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages/immutable-message-id/reply')
    expect(request.method).toBe('POST')
    expect(JSON.parse(String(request.body))).toEqual({ comment: 'Neutral acknowledgment' })
  })

  it('does not touch Microsoft Graph while email ingestion is off', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      pollEmail({} as D1Database, new MicrosoftGraphProvider(config), {
        mode: 'FAMILY_PILOT',
        externalNotificationsEnabled: false,
        emailIngestionEnabled: false,
        emailAckEnabled: false,
      }),
    ).resolves.toEqual({ processed: 0, failures: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })
})

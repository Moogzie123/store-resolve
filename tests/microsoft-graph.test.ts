import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftGraphProvider, normalizeGraphMessage } from '../worker/microsoft-graph'
import { ingestSinglePilotComplaint, pollEmail } from '../worker/ingestion'
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

  it('checks Inbox metadata using only the required delegated mail scopes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'inbox-folder-id',
            displayName: 'Inbox',
            totalItemCount: 10,
            unreadItemCount: 2,
          }),
          { status: 200 },
        ),
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
    const readinessUrl = new URL(String(fetch.mock.calls[1][0]))
    expect(readinessUrl.pathname).toBe('/v1.0/me/mailFolders/inbox')
    expect(readinessUrl.searchParams.get('$select')).toBe(
      'id,displayName,totalItemCount,unreadItemCount',
    )
    expect(readinessUrl.pathname).not.toBe('/v1.0/me')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    [401, 'MS_GRAPH_API_401'],
    [403, 'MS_GRAPH_API_403_SCOPE'],
  ])(
    'surfaces a %i metadata-readiness failure without starting ingestion',
    async (status, code) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(null, { status }))
      vi.stubGlobal('fetch', fetch)
      await expect(new MicrosoftGraphProvider(config).verifyConnection()).rejects.toMatchObject({
        code,
        status,
      })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(String(fetch.mock.calls[1][0])).toContain('/me/mailFolders/inbox?')
      expect(String(fetch.mock.calls[1][0])).not.toContain('/messages')
    },
  )

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

  it('selects at most one recent Inbox message with the fixed pilot search', async () => {
    const now = Date.parse('2026-08-24T06:00:00Z')
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: 'pilot-message-id', receivedDateTime: '2026-08-24T05:00:00Z' }],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new MicrosoftGraphProvider(config).findLatestPilotComplaintMessage(7, now),
    ).resolves.toEqual({
      id: 'pilot-message-id',
      receivedDateTime: '2026-08-24T05:00:00Z',
    })
    const url = new URL(String(fetch.mock.calls[1][0]))
    expect(url.pathname).toBe('/v1.0/me/mailFolders/inbox/messages')
    expect(url.searchParams.get('$search')).toBe('"Dunkin AND complaint"')
    expect(url.searchParams.get('$select')).toBe('id,receivedDateTime')
    expect(url.searchParams.get('$top')).toBe('1')
  })

  it('rejects a pilot selector outside the recent window', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: 'old-message-id', receivedDateTime: '2026-08-01T05:00:00Z' }],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new MicrosoftGraphProvider(config).findLatestPilotComplaintMessage(
        7,
        Date.parse('2026-08-24T06:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'MS_GRAPH_PILOT_MESSAGE_OUTSIDE_WINDOW' })
  })

  it('refuses the one-shot pilot path unless all outbound controls stay off', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      ingestSinglePilotComplaint({} as D1Database, new MicrosoftGraphProvider(config), {
        mode: 'FAMILY_PILOT',
        externalNotificationsEnabled: true,
        emailIngestionEnabled: false,
        emailAckEnabled: false,
      }),
    ).rejects.toMatchObject({ code: 'MS_GRAPH_PILOT_SMS_MUST_BE_OFF' })
    await expect(
      ingestSinglePilotComplaint({} as D1Database, new MicrosoftGraphProvider(config), {
        mode: 'FAMILY_PILOT',
        externalNotificationsEnabled: false,
        emailIngestionEnabled: false,
        emailAckEnabled: true,
      }),
    ).rejects.toMatchObject({ code: 'MS_GRAPH_PILOT_ACK_MUST_BE_OFF' })
    await expect(
      ingestSinglePilotComplaint({} as D1Database, new MicrosoftGraphProvider(config), {
        mode: 'FAMILY_PILOT',
        externalNotificationsEnabled: false,
        emailIngestionEnabled: true,
        emailAckEnabled: false,
      }),
    ).rejects.toMatchObject({ code: 'MS_GRAPH_BROAD_INGESTION_MUST_BE_OFF' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

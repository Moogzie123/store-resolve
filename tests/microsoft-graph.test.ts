import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  maskGraphIdentifier,
  MicrosoftGraphProvider,
  mailboxIdentityDiagnosticWindows,
  normalizeGraphMessage,
  pilotMessageSelector,
} from '../worker/microsoft-graph'
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

  it('uses an all-mailbox sender/time metadata query and validates subject locally', async () => {
    const subject = 'DBI Case # (CCC11122413) - Guest Contact: Slow Service - Store 350909-DD'
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'pilot-message-id',
                conversationId: 'pilot-conversation-id',
                parentFolderId: 'archive-folder-id',
                receivedDateTime: '2026-08-01T18:27:00Z',
                subject,
                from: { emailAddress: { address: pilotMessageSelector.senderAddress } },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new MicrosoftGraphProvider(config).findPilotComplaintCandidates(),
    ).resolves.toEqual({
      candidates: [
        {
          id: 'pilot-message-id',
          conversationId: 'pilot-conversation-id',
          parentFolderId: 'archive-folder-id',
          receivedDateTime: '2026-08-01T18:27:00Z',
          subject,
          senderAddress: pilotMessageSelector.senderAddress,
          senderMatched: true,
          receivedWindowMatched: true,
          caseIdMatched: true,
          subjectPhraseMatched: true,
          storeTokenMatched: true,
          previousSubjectPrefixMatched: true,
          previousWindowMatched: true,
        },
      ],
      inspectedCandidates: [
        {
          id: 'pilot-message-id',
          conversationId: 'pilot-conversation-id',
          parentFolderId: 'archive-folder-id',
          receivedDateTime: '2026-08-01T18:27:00Z',
          subject,
          senderAddress: pilotMessageSelector.senderAddress,
          senderMatched: true,
          receivedWindowMatched: true,
          caseIdMatched: true,
          subjectPhraseMatched: true,
          storeTokenMatched: true,
          previousSubjectPrefixMatched: true,
          previousWindowMatched: true,
        },
      ],
      hasMore: false,
    })
    const url = new URL(String(fetch.mock.calls[1][0]))
    expect(url.pathname).toBe('/v1.0/me/messages')
    const filter = url.searchParams.get('$filter') ?? ''
    expect(filter).toContain(`from/emailAddress/address eq '${pilotMessageSelector.senderAddress}'`)
    expect(filter).not.toContain('subject')
    expect(filter).toContain(`receivedDateTime ge ${pilotMessageSelector.receivedStart}`)
    expect(filter).toContain(`receivedDateTime le ${pilotMessageSelector.receivedEnd}`)
    expect(url.searchParams.get('$select')).toBe(
      'id,conversationId,parentFolderId,subject,receivedDateTime,from',
    )
    expect(url.searchParams.get('$top')).toBe('3')
    expect(url.searchParams.has('$search')).toBe(false)
  })

  it('resolves only display metadata for the unique candidate folder', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'folder/id', displayName: 'Archive' }), {
          status: 200,
        }),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new MicrosoftGraphProvider(config).getMailFolderMetadata('folder/id'),
    ).resolves.toEqual({ id: 'folder/id', displayName: 'Archive' })
    const url = new URL(String(fetch.mock.calls[1][0]))
    expect(url.pathname).toBe('/v1.0/me/mailFolders/folder%2Fid')
    expect(url.searchParams.get('$select')).toBe('id,displayName')
    expect(String(fetch.mock.calls[1][0])).not.toMatch(/messages|body|recipients|attachments/i)
  })

  it('requires the approved PC/store token before metadata can become a pilot candidate', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'pilot-message-id',
                conversationId: 'pilot-conversation-id',
                parentFolderId: 'archive-folder-id',
                receivedDateTime: '2026-08-01T18:27:00Z',
                subject: `${pilotMessageSelector.caseId} ${pilotMessageSelector.subjectPhrase}`,
                from: { emailAddress: { address: pilotMessageSelector.senderAddress } },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const result = await new MicrosoftGraphProvider(config).findPilotComplaintCandidates()
    expect(result.candidates).toHaveLength(0)
    expect(result.inspectedCandidates).toHaveLength(1)
    expect(result.inspectedCandidates[0]).toMatchObject({
      senderMatched: true,
      receivedWindowMatched: true,
      caseIdMatched: true,
      subjectPhraseMatched: true,
      storeTokenMatched: false,
    })
  })

  it('runs a date-only all-mailbox diagnostic with no sender or content fields', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'date-message-id',
                receivedDateTime: '2026-08-01T12:00:00Z',
                from: { emailAddress: { address: 'sender@example.invalid' } },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new MicrosoftGraphProvider(config).runDateOnlyIdentityDiagnostic(),
    ).resolves.toEqual({
      records: [
        {
          id: 'date-message-id',
          receivedDateTime: '2026-08-01T12:00:00Z',
          senderAddress: 'sender@example.invalid',
        },
      ],
      hasMore: false,
    })
    const url = new URL(String(fetch.mock.calls[1][0]))
    expect(url.pathname).toBe('/v1.0/me/messages')
    expect(url.searchParams.get('$filter')).toBe(
      `receivedDateTime ge ${mailboxIdentityDiagnosticWindows.dateOnly.receivedStart} and receivedDateTime lt ${mailboxIdentityDiagnosticWindows.dateOnly.receivedEnd}`,
    )
    expect(url.searchParams.get('$select')).toBe('id,receivedDateTime,from')
    expect(url.searchParams.get('$top')).toBe('3')
    expect(url.searchParams.has('$search')).toBe(false)
    expect(String(fetch.mock.calls[1][0])).not.toMatch(
      /subject|body|recipients|attachments|from%2FemailAddress/i,
    )
  })

  it('runs a bounded sender-only all-mailbox diagnostic with no content fields', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(
      new MicrosoftGraphProvider(config).runSenderOnlyIdentityDiagnostic(),
    ).resolves.toEqual({ records: [], hasMore: false })
    const url = new URL(String(fetch.mock.calls[1][0]))
    expect(url.pathname).toBe('/v1.0/me/messages')
    expect(url.searchParams.get('$filter')).toBe(
      `receivedDateTime ge ${mailboxIdentityDiagnosticWindows.senderOnly.receivedStart} and receivedDateTime lt ${mailboxIdentityDiagnosticWindows.senderOnly.receivedEnd} and from/emailAddress/address eq '${mailboxIdentityDiagnosticWindows.senderOnly.senderAddress}'`,
    )
    expect(url.searchParams.get('$select')).toBe('id,receivedDateTime,from')
    expect(url.searchParams.get('$top')).toBe('3')
    expect(url.searchParams.has('$search')).toBe(false)
    expect(String(fetch.mock.calls[1][0])).not.toMatch(/subject|body|recipients|attachments/i)
  })

  it('keeps non-matching subjects as inspected metadata but excludes them as candidates', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'other-message-id',
                conversationId: 'other-conversation-id',
                parentFolderId: 'other-folder-id',
                receivedDateTime: '2026-08-01T18:27:00Z',
                subject: 'Unrelated metadata subject',
                from: { emailAddress: { address: pilotMessageSelector.senderAddress } },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const result = await new MicrosoftGraphProvider(config).findPilotComplaintCandidates()
    expect(result.candidates).toHaveLength(0)
    expect(result.inspectedCandidates).toHaveLength(1)
    expect(result.inspectedCandidates[0]).toMatchObject({
      senderMatched: true,
      receivedWindowMatched: true,
      caseIdMatched: false,
      subjectPhraseMatched: false,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('masks Graph identifiers in diagnostic output', () => {
    expect(maskGraphIdentifier('0123456789abcdef')).toBe('0123…cdef')
    expect(maskGraphIdentifier('short')).toBe('••••')
  })

  it.each([
    [[], 0],
    [
      [
        {
          id: 'pilot-message-1',
          conversationId: 'conversation-1',
          parentFolderId: 'archive-folder-id',
          receivedDateTime: '2026-08-01T18:26:00Z',
          subject: `${pilotMessageSelector.caseId} ${pilotMessageSelector.subjectPhrase} ${pilotMessageSelector.storeToken}`,
          from: { emailAddress: { address: pilotMessageSelector.senderAddress } },
        },
        {
          id: 'pilot-message-2',
          conversationId: 'conversation-2',
          parentFolderId: 'archive-folder-id',
          receivedDateTime: '2026-08-01T18:27:00Z',
          subject: `${pilotMessageSelector.caseId} ${pilotMessageSelector.subjectPhrase} ${pilotMessageSelector.storeToken}`,
          from: { emailAddress: { address: pilotMessageSelector.senderAddress } },
        },
      ],
      '2+',
    ],
  ])(
    'does not fetch content or touch D1 when metadata match count is %s',
    async (value, matchCount) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'inbox-folder-id', displayName: 'Inbox' }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(JSON.stringify({ value }), { status: 200 }))
      vi.stubGlobal('fetch', fetch)
      await expect(
        ingestSinglePilotComplaint({} as D1Database, new MicrosoftGraphProvider(config), {
          mode: 'FAMILY_PILOT',
          externalNotificationsEnabled: false,
          emailIngestionEnabled: false,
          emailAckEnabled: false,
        }),
      ).resolves.toEqual({ accessed: false, matchCount, inspectedCount: value.length })
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls.map(([url]) => String(url))).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\/me\/messages\//)]),
      )
    },
  )

  it('resets only the previous one-shot lock after exactly one metadata match', async () => {
    const metadata = {
      id: 'pilot-message-id',
      conversationId: 'pilot-conversation-id',
      parentFolderId: 'archive-folder-id',
      receivedDateTime: '2026-08-01T18:27:00Z',
      subject: `${pilotMessageSelector.caseId} ${pilotMessageSelector.subjectPhrase} ${pilotMessageSelector.storeToken}`,
      from: { emailAddress: { address: pilotMessageSelector.senderAddress } },
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'inbox-folder-id', displayName: 'Inbox' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [metadata] }), { status: 200 }))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...metadata,
            toRecipients: [{ emailAddress: { address: config.mailboxAddress } }],
            body: { contentType: 'text', content: 'This is ordinary correspondence.' },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const statements: string[] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        const statement = {
          bind: () => statement,
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
    } as unknown as D1Database
    await expect(
      ingestSinglePilotComplaint(db, new MicrosoftGraphProvider(config), {
        mode: 'FAMILY_PILOT',
        externalNotificationsEnabled: false,
        emailIngestionEnabled: false,
        emailAckEnabled: false,
      }),
    ).rejects.toMatchObject({ code: 'MS_GRAPH_PILOT_NOT_COMPLAINT' })
    const lockStatements = statements.filter((sql) => sql.includes('background_job_locks'))
    expect(lockStatements).toHaveLength(1)
    expect(lockStatements[0]).toContain("locked_until='9999-12-30T23:59:59.999Z'")
    expect(lockStatements[0]).toContain("locked_until='9999-12-31T23:59:59.999Z'")
    expect(
      statements.some((sql) => sql.includes('INSERT OR IGNORE INTO background_job_locks')),
    ).toBe(false)
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

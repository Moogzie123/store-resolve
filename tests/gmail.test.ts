import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import {
  GmailProvider,
  GmailProviderError,
  normalizeGmailMessage,
  type GmailApiMessage,
  type NormalizedGmailMessage,
} from '../worker/gmail'
import { acknowledgeComplaint, extractComplaint, ingestGmailMessage } from '../worker/ingestion'
import { loadState } from '../worker/d1'
import { buildReport } from '../worker/reporting'
import { runScheduledOperations } from '../worker/operations'
import type { SignalWireSmsProvider } from '../worker/providers'

const base64url = (value: string) =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

const gmailMessage = (overrides: Partial<GmailApiMessage> = {}): GmailApiMessage => ({
  id: 'gmail-1',
  threadId: 'thread-1',
  internalDate: String(Date.parse('2026-08-14T12:00:00Z')),
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Dunkin Guest Care <guestcare@example.invalid>' },
      { name: 'To', value: 'operations@example.invalid' },
      { name: 'Subject', value: 'Complaint reference DD-1001' },
      { name: 'Message-ID', value: '<gmail-1@example.invalid>' },
    ],
    parts: [
      {
        mimeType: 'text/plain',
        body: {
          data: base64url(
            'Complaint Reference ID: DD-1001\nStore Number: 41001\nCustomer Name: Test Guest\nCustomer Email: guest@example.invalid\nComplaint: slow service',
          ),
        },
      },
    ],
  },
  ...overrides,
})

const normalized = (overrides: Partial<NormalizedGmailMessage> = {}): NormalizedGmailMessage => ({
  id: 'gmail-1',
  threadId: 'thread-1',
  internalDate: '2026-08-14T12:00:00.000Z',
  sender: 'Dunkin Guest Care <guestcare@example.invalid>',
  recipients: 'operations@example.invalid',
  subject: 'Complaint reference DD-1001',
  messageIdHeader: '<gmail-1@example.invalid>',
  textBody: 'Complaint Reference ID: DD-1001\nStore Number: 41001\nComplaint: slow service',
  ...overrides,
})

describe('Gmail MIME normalization and deterministic extraction', () => {
  it('extracts plain text, thread metadata, reference, store, category and severity', () => {
    const message = normalizeGmailMessage(gmailMessage())
    expect(message).toMatchObject({ id: 'gmail-1', threadId: 'thread-1' })
    const extracted = extractComplaint(message)
    expect(extracted).toMatchObject({
      isComplaint: true,
      externalCaseId: 'DD-1001',
      storeNumber: '41001',
      category: 'Service',
      severity: 'LOW',
    })
  })

  it('uses sanitized HTML as a fallback and ignores unrelated mail', () => {
    const message = normalizeGmailMessage(
      gmailMessage({
        payload: {
          mimeType: 'text/html',
          headers: [{ name: 'Subject', value: 'Weekly newsletter' }],
          body: { data: base64url('<p>Hello &amp; welcome</p><script>bad()</script>') },
        },
      }),
    )
    expect(message.textBody).toBe('Hello & welcome')
    expect(extractComplaint(message).isComplaint).toBe(false)
  })

  it('never guesses a missing store and recognizes safety severity deterministically', () => {
    const extracted = extractComplaint(
      normalized({ textBody: 'Customer complaint reports a possible allergy incident.' }),
    )
    expect(extracted.storeNumber).toBeUndefined()
    expect(extracted.severity).toBe('CRITICAL')
  })
})

describe('Gmail provider boundary', () => {
  afterEach(() => vi.unstubAllGlobals())
  const config = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    mailboxAddress: 'operations@example.invalid',
  }

  it('refreshes server-side credentials and constructs a reply in the original thread', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'reply-1', threadId: 'thread-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetch)
    const provider = new GmailProvider(config)
    await expect(provider.sendAcknowledgment(normalized(), 'Neutral acknowledgment')).resolves.toBe(
      'reply-1',
    )
    const [, request] = fetch.mock.calls[1] as [string, RequestInit]
    const requestBody = JSON.parse(String(request.body)) as { raw: string; threadId: string }
    const raw = Buffer.from(
      requestBody.raw.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString()
    expect(requestBody.threadId).toBe('thread-1')
    expect(raw).toContain('In-Reply-To: <gmail-1@example.invalid>')
    expect(raw).toContain('References: <gmail-1@example.invalid>')
    expect(raw).toContain('Neutral acknowledgment')
    expect(JSON.stringify(request)).not.toContain(config.clientSecret)
    expect(JSON.stringify(request)).not.toContain(config.refreshToken)
  })

  it('classifies scope errors without exposing provider response content', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token' })))
        .mockResolvedValueOnce(new Response('sensitive provider detail', { status: 403 })),
    )
    await expect(new GmailProvider(config).verifyConnection()).rejects.toMatchObject({
      code: 'GMAIL_API_403_SCOPE',
    } satisfies Partial<GmailProviderError>)
  })
})

describe('durable Gmail ingestion and acknowledgment idempotency', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  class SqliteStatement implements D1PreparedStatement {
    private values: SQLInputValue[] = []
    constructor(private readonly statement: StatementSync) {}
    bind(...values: unknown[]) {
      const normalized: SQLInputValue[] = []
      for (const value of values) {
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'bigint'
        ) {
          normalized.push(value)
          continue
        }
        if (value instanceof Uint8Array) {
          normalized.push(value)
          continue
        }
        throw new TypeError('Unsupported SQLite test binding')
      }
      this.values = normalized
      return this
    }
    async all<T>(): Promise<D1Result<T>> {
      return { success: true, results: this.statement.all(...this.values) as T[] }
    }
    async first<T>(): Promise<T | null> {
      return (this.statement.get(...this.values) as T | undefined) ?? null
    }
    async run(): Promise<D1Result> {
      const result = this.statement.run(...this.values)
      return { success: true, results: [], meta: { changes: Number(result.changes) } }
    }
  }

  class SqliteD1 implements D1Database {
    constructor(private readonly database: DatabaseSync) {}
    prepare(sql: string) {
      return new SqliteStatement(this.database.prepare(sql))
    }
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      this.database.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push((await statement.run()) as D1Result<T>)
        this.database.exec('COMMIT')
        return results
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    }
    async exec(sql: string): Promise<D1Result> {
      this.database.exec(sql)
      return { success: true, results: [] }
    }
  }

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    db = new SqliteD1(sqlite)
    for (const name of [
      '0001_initial.sql',
      '0002_persistence_and_auth.sql',
      '0003_pilot_admin_recipient.sql',
      '0004_v1_operations.sql',
    ]) {
      const path = fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url))
      await db.exec(await readFile(path, 'utf8'))
    }
  })

  afterEach(() => sqlite.close())

  it('deduplicates the same Gmail ID and attaches thread/reference follow-ups to one complaint', async () => {
    const first = await ingestGmailMessage(db, normalized())
    expect(first.status).toBe('PROCESSED')
    expect((await ingestGmailMessage(db, normalized())).status).toBe('DUPLICATE')
    expect(
      (
        await ingestGmailMessage(
          db,
          normalized({ id: 'gmail-2', textBody: 'Complaint follow-up with more details.' }),
        )
      ).status,
    ).toBe('FOLLOW_UP')
    expect(
      (await ingestGmailMessage(db, normalized({ id: 'gmail-3', threadId: 'thread-2' }))).status,
    ).toBe('FOLLOW_UP')
    const state = await loadState(db)
    expect(state.complaints).toHaveLength(1)
    expect(state.complaints[0].followUps).toHaveLength(2)
  })

  it('persists routing review and ignored states without inventing a store', async () => {
    const review = await ingestGmailMessage(
      db,
      normalized({
        id: 'unknown-1',
        threadId: 'unknown-thread',
        textBody: 'Customer complaint with no location.',
      }),
    )
    expect(review.status).toBe('ROUTING_REVIEW')
    const ignored = await ingestGmailMessage(
      db,
      normalized({
        id: 'news-1',
        threadId: 'news-thread',
        subject: 'Newsletter',
        textBody: 'Hello.',
      }),
    )
    expect(ignored.status).toBe('IGNORED')
    const state = await loadState(db)
    expect(
      state.complaints.find((complaint) => complaint.id === review.complaintId)?.storeId,
    ).toBeUndefined()
  })

  it('keeps acknowledgment disabled and sends at most once after explicit enablement', async () => {
    const result = await ingestGmailMessage(db, normalized())
    const state = await loadState(db)
    const sendAcknowledgment = vi.fn().mockResolvedValue('gmail-reply-1')
    const gmail = { ready: true, sendAcknowledgment } as unknown as GmailProvider
    expect(
      await acknowledgeComplaint(db, gmail, result.complaintId!, {
        ...state.config,
        gmailAckEnabled: false,
      }),
    ).toBe('DISABLED')
    expect(sendAcknowledgment).not.toHaveBeenCalled()
    const enabled = { ...state.config, gmailAckEnabled: true }
    expect(await acknowledgeComplaint(db, gmail, result.complaintId!, enabled)).toBe('SENT')
    expect(await acknowledgeComplaint(db, gmail, result.complaintId!, enabled)).toBe(
      'ALREADY_HANDLED',
    )
    expect(sendAcknowledgment).toHaveBeenCalledTimes(1)
  })

  it('computes reporting metrics from persisted complaint fixtures', async () => {
    await ingestGmailMessage(db, normalized())
    const report = buildReport(await loadState(db))
    expect(report.totals.complaints).toBe(1)
    expect(report.byStore['store-1']).toBe(1)
    expect(report.byStatus.MANAGER_NOTIFIED).toBe(1)
  })

  it('leases scheduled operations so overlapping cron invocations do not duplicate work', async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve))
    const releasePromise = new Promise<void>((resolve) => (releaseFirst = resolve))
    const dispatch = vi.fn(async () => {
      firstStarted()
      await releasePromise
    })
    const gmail = { ready: false } as GmailProvider
    const signalWire = { ready: false } as SignalWireSmsProvider
    const env = { DB: db }

    const first = runScheduledOperations(env, gmail, signalWire, dispatch)
    await firstStartedPromise
    await runScheduledOperations(env, gmail, signalWire, dispatch)
    releaseFirst()
    await first

    expect(dispatch).toHaveBeenCalledTimes(1)
    const runs = await db
      .prepare(`SELECT COUNT(*) AS count FROM background_job_runs WHERE job_name='OPERATIONS'`)
      .first<{ count: number }>()
    expect(runs?.count).toBe(1)
  })
})

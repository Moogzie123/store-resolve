import { readFile } from 'node:fs/promises'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import type { NormalizedEmailMessage } from '../worker/email-provider'
import { ingestEmailMessage } from '../worker/ingestion'

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

const message = (overrides: Partial<NormalizedEmailMessage> = {}): NormalizedEmailMessage => ({
  id: 'graph-1',
  threadId: 'thread-1',
  internalDate: '2026-08-14T12:00:00.000Z',
  sender: 'Dunkin Guest Care <guestcare@example.invalid>',
  recipients: 'operations@example.invalid',
  subject: 'Complaint reference DD-1001',
  messageIdHeader: '<graph-1@example.invalid>',
  textBody: 'Complaint Reference ID: DD-1001\nStore Number: 41001\nComplaint: slow service',
  ...overrides,
})

describe('Milestone 1 intake seam', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    db = new SqliteD1(sqlite)
    for (const name of [
      '0001_initial.sql',
      '0002_persistence_and_auth.sql',
      '0003_pilot_admin_recipient.sql',
      '0004_v1_operations.sql',
      '0005_microsoft_graph_provider.sql',
      '0006_intelligent_mail_foundation.sql',
    ]) {
      const path = fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url))
      await db.exec(await readFile(path, 'utf8'))
    }
  })

  afterEach(() => sqlite.close())

  it('sends a message with no extractable case ID to human review without creating a complaint', async () => {
    const result = await ingestEmailMessage(
      db,
      message({
        id: 'noid-1',
        threadId: 'noid-thread',
        subject: 'Guest concern at an unknown store',
        textBody: 'Customer complaint with no location and no reference number.',
      }),
    )
    expect(result.status).toBe('REVIEW_REQUIRED')
    expect(result.complaintId).toBeUndefined()

    const complaints = await db
      .prepare('SELECT id,external_case_id FROM complaints')
      .all<{ id: string; external_case_id: string }>()
    expect(complaints.results).toHaveLength(0)

    const reviews = await db
      .prepare('SELECT status,reason_code,complaint_id,source_message_id FROM mail_review_items')
      .all<{
        status: string
        reason_code: string
        complaint_id: string | null
        source_message_id: string
      }>()
    expect(reviews.results).toEqual([
      {
        status: 'OPEN',
        reason_code: 'IDENTITY_UNRESOLVED',
        complaint_id: null,
        source_message_id: 'noid-1',
      },
    ])

    const events = await db
      .prepare('SELECT event_type,external_case_id FROM canonical_mail_events')
      .all<{ event_type: string; external_case_id: string | null }>()
    expect(events.results).toEqual([{ event_type: 'REVIEW_REQUIRED', external_case_id: null }])

    // No synthetic business identity anywhere on the intake artifacts.
    for (const table of ['complaints', 'canonical_mail_events']) {
      const fabricated = await db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE external_case_id LIKE 'MSGRAPH-%'`)
        .first<{ count: number }>()
      expect(fabricated?.count).toBe(0)
    }
    const source = await db
      .prepare('SELECT processing_state FROM mail_source_messages WHERE id=?')
      .bind('noid-1')
      .first<{ processing_state: string }>()
    expect(source?.processing_state).toBe('REVIEW_REQUIRED')
  })

  it('creates a complaint with the real extracted case ID when identity resolves', async () => {
    const result = await ingestEmailMessage(db, message())
    expect(result.status).toBe('PROCESSED')
    expect(result.complaintId).toBeDefined()
    const complaints = await db
      .prepare('SELECT id,external_case_id FROM complaints')
      .all<{ id: string; external_case_id: string }>()
    expect(complaints.results).toEqual([{ id: result.complaintId, external_case_id: 'DD-1001' }])
    const sources = await db
      .prepare(
        `SELECT source_role,linkage_basis FROM complaint_sources WHERE source_message_id='graph-1'`,
      )
      .all<{ source_role: string; linkage_basis: string }>()
    expect(sources.results).toEqual([{ source_role: 'INITIAL', linkage_basis: 'NEW_CASE_ID' }])
  })

  it('routes a corporate email to the store named by its PC number', async () => {
    // Seed migration 0002 already carries store-2 with dunkin_store_number 41002.
    const result = await ingestEmailMessage(
      db,
      message({
        id: 'graph-pc-1',
        threadId: 'thread-pc-1',
        subject: 'DBI Case # (CCC99901) - Guest Contact: Cold Coffee',
        messageIdHeader: '<graph-pc-1@example.invalid>',
        textBody:
          'DBI Case # (CCC99901)\nGuest Contact: Cold Coffee\nPC: 41002\nComplaint: coffee served cold twice this week',
      }),
    )
    expect(result.status).toBe('PROCESSED')
    const complaint = await db
      .prepare('SELECT id,store_id,external_case_id FROM complaints WHERE external_case_id=?')
      .bind('CCC99901')
      .first<{ id: string; store_id: string | null; external_case_id: string }>()
    expect(complaint?.store_id).toBe('store-2')
  })

  it('is idempotent across duplicate deliveries of the same provider message', async () => {
    const first = await ingestEmailMessage(db, message())
    expect(first.status).toBe('PROCESSED')
    const second = await ingestEmailMessage(db, message())
    expect(second).toEqual({ status: 'DUPLICATE', complaintId: first.complaintId })

    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM mail_source_messages) AS sources,
           (SELECT COUNT(*) FROM complaints) AS complaints,
           (SELECT COUNT(*) FROM canonical_mail_events) AS events`,
      )
      .first<{ sources: number; complaints: number; events: number }>()
    expect(counts).toMatchObject({ sources: 1, complaints: 1, events: 1 })
  })

  it('resumes processing when a previous attempt left an expired lease', async () => {
    await db.exec(`
      INSERT INTO mail_source_messages(
        id,provider,mailbox_key,provider_message_id,conversation_id,direction,
        received_at,discovered_at,subject,sender_address,recipients_json,
        ingestion_mode,processing_state,lease_owner,lease_expires_at,attempt_count,
        created_at,updated_at
      ) VALUES(
        'crashed-1','MICROSOFT_GRAPH','production','crashed-1','thread-c','INBOUND',
        '2026-08-14T12:00:00.000Z','2026-08-14T12:00:00.000Z','Complaint reference DD-1001',
        'Dunkin Guest Care <guestcare@example.invalid>','["operations@example.invalid"]',
        'LIVE','PROCESSING','dead-worker','2020-01-01T00:00:00.000Z',1,
        '2026-08-14T12:00:00.000Z','2026-08-14T12:00:00.000Z'
      );
      INSERT INTO gmail_messages(
        gmail_message_id,gmail_thread_id,internal_date,sender,recipients,subject,
        processing_status,first_seen_at,updated_at
      ) VALUES(
        'crashed-1','thread-c','2026-08-14T12:00:00.000Z',
        'Dunkin Guest Care <guestcare@example.invalid>','operations@example.invalid',
        'Complaint reference DD-1001','PROCESSING','2026-08-14T12:00:00.000Z',
        '2026-08-14T12:00:00.000Z'
      );
    `)
    const result = await ingestEmailMessage(db, message({ id: 'crashed-1', threadId: 'thread-c' }))
    expect(result.status).toBe('PROCESSED')
    expect(result.complaintId).toBeDefined()
    const source = await db
      .prepare('SELECT processing_state,attempt_count FROM mail_source_messages WHERE id=?')
      .bind('crashed-1')
      .first<{ processing_state: string; attempt_count: number }>()
    expect(source).toMatchObject({ processing_state: 'COMPLETED', attempt_count: 2 })
  })
})

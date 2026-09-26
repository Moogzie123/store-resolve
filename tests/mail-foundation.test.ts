import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import { D1MailFoundationRepository } from '../worker/mail-foundation'

type SourceState = {
  attemptCount: number
  processingState: string
  leaseExpiresAt: string | null
  leaseOwner: string | null
}

class Statement implements D1PreparedStatement {
  values: unknown[] = []
  constructor(
    readonly sql: string,
    private readonly database: FakeDatabase,
  ) {}
  bind(...values: unknown[]) {
    this.values = values
    return this
  }
  async all<T>(): Promise<D1Result<T>> {
    return { results: [] as T[], success: true }
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('SELECT attempt_count FROM mail_source_messages'))
      return { attempt_count: this.database.source.attemptCount } as T
    if (this.sql.includes('SELECT id FROM complaints'))
      return (
        this.database.exactComplaint ? { id: this.database.exactComplaint } : null
      ) as T | null
    if (this.sql.includes('SELECT cs.complaint_id')) {
      this.database.conversationLookups += 1
      return (
        this.database.conversationComplaint
          ? { complaint_id: this.database.conversationComplaint }
          : null
      ) as T | null
    }
    return null
  }
  async run(): Promise<D1Result> {
    this.database.statements.push(this)
    if (this.sql.includes("SET processing_state='PROCESSING'")) {
      const now = String(this.values.at(-1))
      const resumable =
        ['DISCOVERED', 'RETRY_WAIT'].includes(this.database.source.processingState) ||
        (this.database.source.processingState === 'PROCESSING' &&
          (!this.database.source.leaseExpiresAt || this.database.source.leaseExpiresAt <= now))
      if (!resumable) return { results: [], success: true, meta: { changes: 0 } }
      this.database.source.processingState = 'PROCESSING'
      this.database.source.leaseOwner = String(this.values[0])
      this.database.source.leaseExpiresAt = String(this.values[1])
      this.database.source.attemptCount = Number(this.values[2])
    }
    return { results: [], success: true, meta: { changes: 1 } }
  }
}

class FakeDatabase implements D1Database {
  statements: Statement[] = []
  batches: Statement[][] = []
  conversationLookups = 0
  exactComplaint?: string
  conversationComplaint?: string
  source: SourceState = {
    attemptCount: 1,
    processingState: 'PROCESSING',
    leaseExpiresAt: '2026-08-01T00:00:00.000Z',
    leaseOwner: 'abandoned-worker',
  }
  prepare(sql: string) {
    return new Statement(sql, this)
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches.push(statements as Statement[])
    return statements.map(() => ({ results: [], success: true, meta: { changes: 1 } }))
  }
  async exec() {}
}

describe('Intelligent Mail Intake foundation repositories', () => {
  it('migrates the approved historical complaint sources without changing complaint content', () => {
    const sqlite = new DatabaseSync(':memory:')
    for (const name of [
      '0001_initial.sql',
      '0002_persistence_and_auth.sql',
      '0003_pilot_admin_recipient.sql',
      '0004_v1_operations.sql',
      '0005_microsoft_graph_provider.sql',
    ]) {
      const path = fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url))
      sqlite.exec(readFileSync(path, 'utf8'))
    }
    sqlite.exec(`
      INSERT INTO complaints(
        id,external_case_id,subject,complaint_text,category,severity,status,
        routing_reason,routing_confidence,received_at,ack_deadline,created_at,updated_at
      ) VALUES(
        'SR-2026-0001','CCC11122413','Sanitized subject','Sanitized complaint',
        'Service','LOW','ROUTING_REVIEW','NO_DETERMINISTIC_STORE_MATCH','REVIEW',
        '2026-08-01T18:26:14.000Z','2026-08-01T19:26:14.000Z',
        '2026-08-01T18:26:14.000Z','2026-08-01T18:27:50.000Z'
      );
      INSERT INTO gmail_messages(
        gmail_message_id,gmail_thread_id,complaint_id,internal_date,sender,recipients,
        subject,processing_status,is_follow_up,acknowledgment_status,first_seen_at,
        processed_at,updated_at
      ) VALUES
        ('graph-initial','conversation-a','SR-2026-0001','2026-08-01T18:26:14.000Z',
         'sender@example.invalid','mailbox@example.invalid','Sanitized subject',
         'ROUTING_REVIEW',0,'DISABLED','2026-08-01T18:26:14.000Z',
         '2026-08-01T18:27:00.000Z','2026-08-01T18:27:00.000Z'),
        ('graph-follow-up','conversation-b','SR-2026-0001','2026-08-01T18:27:50.000Z',
         'sender@example.invalid','mailbox@example.invalid','Sanitized subject',
         'FOLLOW_UP',1,'NOT_APPLICABLE','2026-08-01T18:27:50.000Z',
         '2026-08-01T18:28:00.000Z','2026-08-01T18:28:00.000Z');
    `)
    const migrationPath = fileURLToPath(
      new URL('../drizzle/0006_intelligent_mail_foundation.sql', import.meta.url),
    )
    sqlite.exec(readFileSync(migrationPath, 'utf8'))

    expect(
      sqlite
        .prepare(
          `SELECT subject,complaint_text,status,ingestion_mode,operational_started_at
           FROM complaints WHERE id='SR-2026-0001'`,
        )
        .get(),
    ).toMatchObject({
      subject: 'Sanitized subject',
      complaint_text: 'Sanitized complaint',
      status: 'ROUTING_REVIEW',
      ingestion_mode: 'BACKFILL',
      operational_started_at: null,
    })
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM mail_source_messages').get(),
    ).toMatchObject({ count: 2 })
    expect(sqlite.prepare('SELECT count(*) AS count FROM complaint_sources').get()).toMatchObject({
      count: 2,
    })
    expect(
      sqlite
        .prepare('SELECT source_role FROM complaint_sources ORDER BY linked_at')
        .all()
        .map((row) => row.source_role),
    ).toEqual(['INITIAL', 'FOLLOW_UP'])
    expect(sqlite.prepare('SELECT count(*) AS count FROM mail_review_items').get()).toMatchObject({
      count: 1,
    })
    expect(
      sqlite
        .prepare(
          `SELECT key,value FROM settings
           WHERE key IN ('email_ingestion_enabled','email_ack_enabled') ORDER BY key`,
        )
        .all()
        .every((row) => row.value === 'false'),
    ).toBe(true)
    sqlite.close()
  })

  it('resumes an expired PROCESSING lease as a new versioned run', async () => {
    const db = new FakeDatabase()
    const repository = new D1MailFoundationRepository(db)
    const lease = await repository.acquireProcessingLease(
      'source-1',
      'scheduled-run-2',
      '2026-08-02T00:00:00.000Z',
      240_000,
      { normalizationVersion: 'normalization.v1' },
    )
    expect(lease).toMatchObject({ sourceId: 'source-1', runNumber: 2, owner: 'scheduled-run-2' })
    expect(db.source.attemptCount).toBe(2)
    expect(db.statements.some((statement) => statement.sql.includes('mail_processing_runs'))).toBe(
      true,
    )
  })

  it('does not steal an active processing lease', async () => {
    const db = new FakeDatabase()
    db.source.leaseExpiresAt = '2026-08-03T00:00:00.000Z'
    const repository = new D1MailFoundationRepository(db)
    const lease = await repository.acquireProcessingLease(
      'source-1',
      'competing-run',
      '2026-08-02T00:00:00.000Z',
      240_000,
      { normalizationVersion: 'normalization.v1' },
    )
    expect(lease).toBeNull()
  })

  it('gives an exact business case ID precedence over Graph conversation identity', async () => {
    const db = new FakeDatabase()
    db.exactComplaint = 'SR-CASE-ID'
    db.conversationComplaint = 'SR-CONVERSATION'
    const repository = new D1MailFoundationRepository(db)
    await expect(
      repository.resolveComplaintIdentity(
        'CCC11122413',
        'MICROSOFT_GRAPH',
        'production',
        'graph-conversation',
      ),
    ).resolves.toEqual({ complaintId: 'SR-CASE-ID', basis: 'EXACT_CASE_ID' })
    expect(db.conversationLookups).toBe(0)
  })

  it('does not let a conversation override a new explicit case ID', async () => {
    const db = new FakeDatabase()
    db.conversationComplaint = 'SR-CONVERSATION'
    const repository = new D1MailFoundationRepository(db)
    await expect(
      repository.resolveComplaintIdentity(
        'CCC-NEW',
        'MICROSOFT_GRAPH',
        'production',
        'graph-conversation',
      ),
    ).resolves.toEqual({ basis: 'NEW_CASE_ID' })
    expect(db.conversationLookups).toBe(0)
  })

  it('commits event, complaint source and review in one bounded D1 batch', async () => {
    const db = new FakeDatabase()
    const repository = new D1MailFoundationRepository(db)
    await repository.commitCanonicalEvent({
      eventId: 'event-1',
      sourceId: 'source-1',
      processingRunId: 'run-1',
      complaintId: 'SR-2026-0001',
      eventVersion: 'mail-event.v1',
      eventType: 'REVIEW_REQUIRED',
      externalCaseId: 'CCC11122413',
      ingestionMode: 'BACKFILL',
      payload: { reason: 'STORE_NOT_CONFIGURED' },
      validatedAt: '2026-08-01T18:27:50.000Z',
      complaintSource: {
        id: 'link-1',
        role: 'FOLLOW_UP',
        linkageBasis: 'EXACT_CASE_ID',
        materialUpdate: true,
      },
      review: {
        id: 'review-1',
        reasonCode: 'STORE_NOT_CONFIGURED',
        disagreementFlags: [],
      },
    })
    expect(db.batches).toHaveLength(1)
    expect(db.batches[0]).toHaveLength(3)
  })
})

// Phase C: critical-escalation notification hook inside ingestEmailMessage.
// Uses the real SQLite schema (migrations 0001-0006); no live calls.
import { readFile } from 'node:fs/promises'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import type { NormalizedEmailMessage } from '../worker/email-provider'
import { ingestEmailMessage } from '../worker/ingestion'
import {
  NotificationService,
  type NotificationEvent,
  type NotificationReceipt,
  type NotificationTransport,
} from '../worker/notifications'

class SqliteStatement implements D1PreparedStatement {
  private values: SQLInputValue[] = []
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]) {
    const normalized: SQLInputValue[] = []
    for (const value of values) {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
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

class RecordingTransport implements NotificationTransport {
  readonly name = 'log' as const
  events: NotificationEvent[] = []
  async send(event: NotificationEvent): Promise<NotificationReceipt> {
    this.events.push(event)
    return {
      eventId: event.id,
      transport: this.name,
      channel: 'log',
      target: 'test',
      delivered: true,
      at: new Date().toISOString(),
    }
  }
}

const criticalMessage = (): NormalizedEmailMessage => ({
  id: 'crit-1',
  threadId: 'crit-thread',
  internalDate: '2026-09-28T12:00:00.000Z',
  sender: 'Dunkin Guest Care <guestcare@example.invalid>',
  recipients: 'operations@example.invalid',
  subject: 'Complaint reference DD-9001',
  messageIdHeader: '<crit-1@example.invalid>',
  textBody:
    'Complaint Reference ID: DD-9001\nStore Number: 41001\nCustomer reports an injury after a slip near the counter. Requires urgent follow-up.',
})

describe('critical-escalation notification hook', () => {
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

  it('emits a critical_escalation event when a CRITICAL complaint is created', async () => {
    const transport = new RecordingTransport()
    const service = new NotificationService(
      { enabled: true, targets: [{ channel: 'log', address: 'test' }] },
      [transport],
    )
    const result = await ingestEmailMessage(db, criticalMessage(), {
      notificationService: service,
      skipNotificationConfigLoad: true,
    })
    expect(result.complaintId).toBeDefined()
    expect(transport.events).toHaveLength(1)
    expect(transport.events[0]?.type).toBe('complaint.critical_escalation')
    expect(transport.events[0]?.complaintId).toBe(result.complaintId)
    expect(transport.events[0]?.severity).toBe('CRITICAL')
  })

  it('does not notify for non-critical complaints', async () => {
    const transport = new RecordingTransport()
    const service = new NotificationService(
      { enabled: true, targets: [{ channel: 'log', address: 'test' }] },
      [transport],
    )
    const result = await ingestEmailMessage(
      db,
      {
        ...criticalMessage(),
        id: 'low-1',
        threadId: 'low-thread',
        subject: 'Complaint reference DD-9002',
        textBody: 'Complaint Reference ID: DD-9002\nSlow service at the drive thru.',
      },
      { notificationService: service, skipNotificationConfigLoad: true },
    )
    expect(result.complaintId).toBeDefined()
    expect(transport.events).toHaveLength(0)
  })

  it('is inert by default: no injected service and flag off means no transport, no failure', async () => {
    // No notificationService injected; settings table has no
    // external_notifications_enabled row -> loadNotificationConfig defaults off.
    const result = await ingestEmailMessage(db, criticalMessage())
    expect(result.complaintId).toBeDefined()
    const complaints = await db
      .prepare('SELECT id FROM complaints')
      .all<{ id: string }>()
    expect(complaints.results).toHaveLength(1)
  })
})

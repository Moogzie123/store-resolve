// Phase C: discovery -> intake integration. Wires runMailboxDiscovery to the
// REAL ingestEmailMessage over the real SQLite schema (migrations 0001-0006).
// This is the regression test for the double-persistence bug: discovery must
// NOT pre-persist sources, otherwise the intake path reads every discovered
// message as DUPLICATE and never processes it.
import { readFile } from 'node:fs/promises'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import {
  FakeDeltaDiscoveryClient,
  runMailboxDiscovery,
} from '../worker/mail-discovery'
import type { GraphMessage } from '../worker/microsoft-graph'

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

const graphMessage = (id: string, subject: string, body: string): GraphMessage => ({
  id,
  conversationId: `thread-${id}`,
  receivedDateTime: '2026-09-28T10:00:00.000Z',
  subject,
  from: { emailAddress: { address: 'guestcare@example.invalid' } },
  body: { contentType: 'text', content: body },
})

describe('discovery -> intake integration', () => {
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

  it('processes discovered messages through the real intake (not DUPLICATE)', async () => {
    const client = new FakeDeltaDiscoveryClient([
      {
        messages: [
          graphMessage(
            'disc-1',
            'Complaint reference DD-7001',
            'Complaint Reference ID: DD-7001\nStore Number: 41001\nComplaint: slow service',
          ),
        ],
        deltaLink: 'delta-int-1',
      },
    ])
    const result = await runMailboxDiscovery(db, {
      provider: 'MICROSOFT_GRAPH',
      mailboxKey: 'production',
      ingestionEnabled: true,
      client,
      // No ingest override: uses the real ingestEmailMessage.
    })
    expect(result.ran).toBe(true)
    expect(result.discovered).toBe(1)
    expect(result.ingested).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.failures).toBe(0)

    const complaints = await db
      .prepare('SELECT id,external_case_id FROM complaints')
      .all<{ id: string; external_case_id: string }>()
    expect(complaints.results).toEqual([{ id: complaints.results[0]?.id, external_case_id: 'DD-7001' }])

    const sources = await db
      .prepare('SELECT COUNT(*) AS count FROM mail_source_messages')
      .first<{ count: number }>()
    expect(sources?.count).toBe(1)

    // A second run over the same delta page is idempotent: the intake reports
    // DUPLICATE and discovery counts it as skipped.
    const client2 = new FakeDeltaDiscoveryClient([
      {
        messages: [
          graphMessage(
            'disc-1',
            'Complaint reference DD-7001',
            'Complaint Reference ID: DD-7001\nStore Number: 41001\nComplaint: slow service',
          ),
        ],
        deltaLink: 'delta-int-2',
      },
    ])
    const rerun = await runMailboxDiscovery(db, {
      provider: 'MICROSOFT_GRAPH',
      mailboxKey: 'production',
      ingestionEnabled: true,
      client: client2,
    })
    expect(rerun.discovered).toBe(0)
    expect(rerun.skipped).toBe(1)
    const complaintsAfter = await db
      .prepare('SELECT COUNT(*) AS count FROM complaints')
      .first<{ count: number }>()
    expect(complaintsAfter?.count).toBe(1)
  })
})

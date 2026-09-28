// Review-queue API regression test. The list/detail queries in
// worker/review-queue.ts must run against the REAL migration schema — a
// previous version referenced interpretation_* columns that do not exist on
// mail_processing_runs (Phase B persists into model_name / prompt_version /
// ai_structured_output_json / disagreement_flags_json), which would have 500'd
// the family review queue in production.
import { readFile } from 'node:fs/promises'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import { REVIEW_QUEUE_DETAIL_QUERY, REVIEW_QUEUE_LIST_QUERY } from '../worker/review-queue'

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
  async batch<T>(): Promise<D1Result<T>[]> {
    return []
  }
  async exec(sql: string): Promise<D1Result> {
    this.database.exec(sql)
    return { success: true, results: [] }
  }
}

const NOW = '2026-09-28T15:00:00.000Z'

describe('review-queue queries against the real schema', () => {
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
    // One source message with a processing run that has model output, plus an OPEN review item.
    await db
      .prepare(
        `INSERT INTO mail_source_messages(id,provider,mailbox_key,provider_message_id,internet_message_id,
          conversation_id,direction,received_at,discovered_at,subject,sender_address,recipients_json,
          ingestion_mode,processing_state,created_at,updated_at)
         VALUES('src-1','MICROSOFT_GRAPH','inbox','pm-1','im-1','conv-1','INBOUND',?,?,?,
          'guest@example.invalid','[]','TEST','REVIEW_REQUIRED',?,?)`,
      )
      .bind(NOW, NOW, 'DEMO: cold coffee complaint', NOW, NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO mail_processing_runs(id,source_message_id,run_number,status,normalization_version,
          model_name,prompt_version,schema_version,ai_structured_output_json,disagreement_flags_json,
          started_at,created_at,updated_at)
         VALUES('run-1','src-1',1,'REVIEW_REQUIRED','norm.v1','gpt-4o-mini','mail-interpret.v1',
          'mail-interpret.output.v1',?,'["STORE_UNVERIFIED"]',?,?,?)`,
      )
      .bind(
        JSON.stringify({
          schemaVersion: 'mail-interpret.output.v1',
          externalCaseId: null,
          storeNumber: '41002',
          storeConfidence: null,
          issueCategory: 'Product quality',
          urgency: 'HIGH',
          confidence: 0.82,
          summary: 'DEMO: guest reports cold coffee.',
          evidenceQuotes: [],
        }),
        NOW,
        NOW,
        NOW,
      )
      .run()
    await db
      .prepare(
        `INSERT INTO mail_review_items(id,source_message_id,processing_run_id,status,reason_code,
          disagreement_flags_json,created_at,updated_at)
         VALUES('ri-1','src-1','run-1','OPEN','STORE_UNVERIFIED','["STORE_UNVERIFIED"]',?,?)`,
      )
      .bind(NOW, NOW)
      .run()
  })

  afterEach(() => sqlite.close())

  it('list query runs and returns the frontend-facing aliases', async () => {
    const rows = await db.prepare(REVIEW_QUEUE_LIST_QUERY).all<Record<string, unknown>>()
    expect(rows.results).toHaveLength(1)
    const item = rows.results[0]
    expect(item.subject).toBe('DEMO: cold coffee complaint')
    expect(item.interpretation_model).toBe('gpt-4o-mini')
    expect(item.interpretation_prompt_version).toBe('mail-interpret.v1')
    expect(item.interpretation_confidence).toBe(0.82)
    expect(item.interpretation_disagreements_json).toBe('["STORE_UNVERIFIED"]')
  })

  it('detail query runs and exposes interpretation_json for the frontend', async () => {
    const row = await db.prepare(REVIEW_QUEUE_DETAIL_QUERY).bind('ri-1').first<Record<string, unknown>>()
    expect(row).not.toBeNull()
    expect(row!.interpretation_model).toBe('gpt-4o-mini')
    const parsed = JSON.parse(String(row!.interpretation_json))
    expect(parsed.storeNumber).toBe('41002')
    expect(parsed.confidence).toBe(0.82)
    expect(row!.interpretation_confidence).toBe(0.82)
    expect(row!.run_status).toBe('REVIEW_REQUIRED')
  })

  it('detail query tolerates a review item with no processing run', async () => {
    await db
      .prepare(
        `INSERT INTO mail_source_messages(id,provider,mailbox_key,provider_message_id,direction,
          received_at,discovered_at,subject,sender_address,ingestion_mode,processing_state,created_at,updated_at)
         VALUES('src-2','MICROSOFT_GRAPH','inbox','pm-2','INBOUND',?,?,?,
          'guest2@example.invalid','TEST','REVIEW_REQUIRED',?,?)`,
      )
      .bind(NOW, NOW, 'DEMO: no run yet', NOW, NOW)
      .run()
    await db
      .prepare(
        `INSERT INTO mail_review_items(id,source_message_id,status,reason_code,created_at,updated_at)
         VALUES('ri-2','src-2','OPEN','NEEDS_RUN',?,?)`,
      )
      .bind(NOW, NOW)
      .run()
    const row = await db.prepare(REVIEW_QUEUE_DETAIL_QUERY).bind('ri-2').first<Record<string, unknown>>()
    expect(row).not.toBeNull()
    expect(row!.interpretation_model).toBeNull()
    expect(row!.interpretation_json).toBeNull()
  })
})

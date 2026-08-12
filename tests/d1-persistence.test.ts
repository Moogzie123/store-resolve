import { describe, expect, it } from 'vitest'
import {
  persistState,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from '../worker/d1'
import { createComplaint, updateComplaint } from '../src/lib/workflow'
import { initialState } from '../src/lib/seed'

class Statement implements D1PreparedStatement {
  values: unknown[] = []
  constructor(readonly sql: string) {}
  bind(...values: unknown[]) {
    this.values = values
    return this
  }
  async all<T>(): Promise<D1Result<T>> {
    return { success: true, results: [] }
  }
  async first<T>(): Promise<T | null> {
    return null
  }
  async run(): Promise<D1Result> {
    return { success: true, results: [] }
  }
}
class RecordingD1 implements D1Database {
  prepared: Statement[] = []
  batched: Statement[][] = []
  prepare(sql: string) {
    const statement = new Statement(sql)
    this.prepared.push(statement)
    return statement
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batched.push(statements as Statement[])
    return statements.map(() => ({ success: true, results: [] }))
  }
  async exec(): Promise<D1Result> {
    return { success: true, results: [] }
  }
}

describe('D1 persistence adapter', () => {
  it('persists a complaint, chronological events, independent notifications, and manager fields', async () => {
    const input = {
      externalCaseId: 'D1-1',
      storeNumber: '41001',
      subject: 'Persistent concern',
      complaintText: 'Fictional persistence test.',
      category: 'Customer Service',
      severity: 'MEDIUM' as const,
    }
    let state = createComplaint(structuredClone(initialState), input, '2026-08-12T00:00:00Z').state
    const complaint = state.complaints[0]
    state = updateComplaint(
      state,
      complaint.id,
      'ACKNOWLEDGE',
      'manager-1',
      {},
      '2026-08-12T00:05:00Z',
    )
    const db = new RecordingD1()
    await persistState(db, state)
    const sql = db.batched.flat().map((s) => s.sql)
    expect(sql.some((s) => s.startsWith('INSERT INTO complaints'))).toBe(true)
    expect(
      sql.filter((s) => s.startsWith('INSERT OR IGNORE INTO complaint_events')).length,
    ).toBeGreaterThanOrEqual(5)
    expect(sql.filter((s) => s.startsWith('INSERT INTO notifications')).length).toBe(4)
    const complaintStatement = db.batched
      .flat()
      .find((s) => s.sql.startsWith('INSERT INTO complaints'))!
    expect(complaintStatement.values).toContain('2026-08-12T00:05:00Z')
  })
})

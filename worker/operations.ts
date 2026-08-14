import { processDeadlines } from '../src/lib/workflow'
import { reconcileStaleSignalWireNotification } from './callbacks'
import type { D1Database } from './d1'
import { loadState, persistState } from './d1'
import type { EmailProvider } from './email-provider'
import { pollEmail } from './ingestion'
import type { SignalWireSmsProvider } from './providers'

export interface OperationsBindings {
  DB: D1Database
  SIGNALWIRE_PROJECT_ID?: string
  SIGNALWIRE_PHONE_NUMBER?: string
}

export async function reconcileStaleSignalWire(
  env: OperationsBindings,
  provider: SignalWireSmsProvider,
  thresholdMinutes: number,
): Promise<number> {
  if (!provider.ready || !env.SIGNALWIRE_PROJECT_ID || !env.SIGNALWIRE_PHONE_NUMBER) return 0
  const cutoff = new Date(Date.now() - thresholdMinutes * 60_000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT provider_message_id FROM notifications WHERE provider='SIGNALWIRE' AND status='SENT' AND provider_message_id IS NOT NULL AND sent_at<=? ORDER BY sent_at LIMIT 25`,
  )
    .bind(cutoff)
    .all<{ provider_message_id: string }>()
  let updated = 0
  for (const row of rows.results) {
    try {
      const message = await provider.retrieveMessage(row.provider_message_id)
      const result = await reconcileStaleSignalWireNotification(
        env.DB,
        message,
        env.SIGNALWIRE_PROJECT_ID,
        env.SIGNALWIRE_PHONE_NUMBER,
      )
      if (result === 'UPDATED') updated += 1
    } catch (error) {
      await env.DB.prepare(
        `INSERT INTO integration_events(id,integration,event_type,entity_id,outcome,detail_code,metadata,created_at) VALUES(?,'SIGNALWIRE','RECONCILIATION_FAILED',?,'FAILED',?,NULL,?)`,
      )
        .bind(
          crypto.randomUUID(),
          row.provider_message_id,
          error instanceof Error ? error.name : 'UNKNOWN',
          new Date().toISOString(),
        )
        .run()
    }
  }
  return updated
}

async function recordEscalations(
  db: D1Database,
  before: Awaited<ReturnType<typeof loadState>>,
  after: Awaited<ReturnType<typeof loadState>>,
) {
  const statements = []
  for (const complaint of after.complaints) {
    const previous = before.complaints.find((item) => item.id === complaint.id)
    if (!previous?.isAckOverdue && complaint.isAckOverdue)
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO escalation_events(id,complaint_id,escalation_type,escalation_sequence,created_at) VALUES(?,?,'ACK_OVERDUE',1,?)`,
          )
          .bind(crypto.randomUUID(), complaint.id, new Date().toISOString()),
      )
    if (!previous?.isResolutionOverdue && complaint.isResolutionOverdue)
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO escalation_events(id,complaint_id,escalation_type,escalation_sequence,created_at) VALUES(?,?,'RESOLUTION_OVERDUE',1,?)`,
          )
          .bind(crypto.randomUUID(), complaint.id, new Date().toISOString()),
      )
  }
  if (statements.length) await db.batch(statements)
}

export async function runScheduledOperations<T extends OperationsBindings>(
  env: T,
  emailProvider: EmailProvider,
  signalWire: SignalWireSmsProvider,
  dispatchEligible: (env: T, state: Awaited<ReturnType<typeof loadState>>) => Promise<void>,
): Promise<void> {
  const runId = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const lockedUntil = new Date(Date.now() + 4 * 60_000).toISOString()
  await env.DB.prepare(
    `INSERT OR IGNORE INTO background_job_locks(job_name,locked_until,owner_run_id,updated_at) VALUES('OPERATIONS','1970-01-01T00:00:00.000Z','',?)`,
  )
    .bind(startedAt)
    .run()
  const lock = await env.DB.prepare(
    `UPDATE background_job_locks SET locked_until=?,owner_run_id=?,updated_at=? WHERE job_name='OPERATIONS' AND locked_until<=?`,
  )
    .bind(lockedUntil, runId, startedAt, startedAt)
    .run()
  if (Number(lock.meta?.changes ?? 0) !== 1) return
  await env.DB.prepare(
    `INSERT INTO background_job_runs(id,job_name,started_at,outcome,processed_count) VALUES(?,'OPERATIONS',?,'RUNNING',0)`,
  )
    .bind(runId, startedAt)
    .run()
  try {
    const before = await loadState(env.DB)
    const deadlines = processDeadlines(before)
    await persistState(env.DB, deadlines)
    await recordEscalations(env.DB, before, deadlines)
    await dispatchEligible(env, deadlines)
    const reconciled = await reconcileStaleSignalWire(
      env,
      signalWire,
      deadlines.config.signalWireReconcileAfterMinutes ?? 10,
    )
    const emailResult = await pollEmail(env.DB, emailProvider, deadlines.config)
    const completedAt = new Date().toISOString()
    await env.DB.prepare(
      `UPDATE background_job_runs SET completed_at=?,outcome=?,processed_count=?,error_code=NULL WHERE id=?`,
    )
      .bind(
        completedAt,
        emailResult.failures ? 'PARTIAL' : 'SUCCESS',
        emailResult.processed + reconciled,
        runId,
      )
      .run()
  } catch (error) {
    await env.DB.prepare(
      `UPDATE background_job_runs SET completed_at=?,outcome='FAILED',error_code=? WHERE id=?`,
    )
      .bind(new Date().toISOString(), error instanceof Error ? error.name : 'UNKNOWN', runId)
      .run()
    throw error
  } finally {
    await env.DB.prepare(
      `UPDATE background_job_locks SET locked_until=?,updated_at=? WHERE job_name='OPERATIONS' AND owner_run_id=?`,
    )
      .bind(new Date(0).toISOString(), new Date().toISOString(), runId)
      .run()
  }
}

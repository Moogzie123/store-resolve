import type { SignalWireMessage } from './providers'
import type { D1Database } from './d1'

export type CallbackResult =
  'UPDATED' | 'DUPLICATE' | 'IGNORED' | 'NOT_FOUND' | 'AUTHENTICITY_FAILED'
export type ReconciliationResult =
  'UPDATED' | 'UNCHANGED' | 'NON_TERMINAL' | 'NOT_FOUND' | 'AUTHENTICITY_FAILED'

const terminal = new Set(['DELIVERED', 'FAILED', 'UNDELIVERED'])
const map: Record<string, string> = {
  queued: 'SENT',
  sending: 'SENT',
  sent: 'SENT',
  delivered: 'DELIVERED',
  failed: 'FAILED',
  undelivered: 'UNDELIVERED',
}

export async function applySignalWireCallback(
  db: D1Database,
  message: SignalWireMessage,
  expectedProjectId: string,
  expectedFrom: string,
  now = new Date().toISOString(),
): Promise<CallbackResult> {
  const notification = await db
    .prepare(
      `SELECT n.id,n.status,n.recipient_user_id,u.phone AS recipient_phone FROM notifications n JOIN users u ON u.id=n.recipient_user_id WHERE n.provider_message_id=? AND n.provider='SIGNALWIRE'`,
    )
    .bind(message.sid)
    .first<{ id: string; status: string; recipient_user_id: string; recipient_phone: string }>()
  if (!notification) return 'NOT_FOUND'
  if (
    message.accountSid !== expectedProjectId ||
    message.from !== expectedFrom ||
    message.to !== notification.recipient_phone
  )
    return 'AUTHENTICITY_FAILED'
  const status = map[message.status.toLowerCase()]
  if (!status) return 'IGNORED'
  const callbackId = `${message.sid}:${message.status.toLowerCase()}:${message.errorCode ?? ''}`
  const audit = {
    messageSid: message.sid,
    status,
    errorCode: message.errorCode,
  }
  const inserted = await db
    .prepare(
      'INSERT OR IGNORE INTO notification_callbacks(id,provider_message_id,status,received_at,payload) VALUES(?,?,?,?,?)',
    )
    .bind(callbackId, message.sid, status, now, JSON.stringify(audit))
    .run()
  if (Number(inserted.meta?.changes ?? 0) === 0) return 'DUPLICATE'
  if (terminal.has(notification.status) && notification.status !== status) return 'IGNORED'
  const failureReason =
    status === 'FAILED' || status === 'UNDELIVERED'
      ? (message.errorMessage ?? message.errorCode ?? null)
      : null
  await db
    .prepare(
      `UPDATE notifications SET status=?,sent_at=CASE WHEN ?='SENT' THEN COALESCE(sent_at,?) ELSE sent_at END,delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE delivered_at END,failed_at=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failed_at END,failure_reason=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failure_reason END WHERE id=?`,
    )
    .bind(status, status, now, status, now, status, now, status, failureReason, notification.id)
    .run()
  return 'UPDATED'
}

export async function reconcileSignalWireMessage(
  db: D1Database,
  message: SignalWireMessage,
  expectedProjectId: string,
  expectedFrom: string,
  expectedRecipientUserId: string,
  now = new Date().toISOString(),
): Promise<ReconciliationResult> {
  const notification = await db
    .prepare(
      `SELECT n.id,n.status,n.recipient_user_id,u.phone AS recipient_phone,u.recipient_kind FROM notifications n JOIN users u ON u.id=n.recipient_user_id WHERE n.provider_message_id=? AND n.provider='SIGNALWIRE'`,
    )
    .bind(message.sid)
    .first<{
      id: string
      status: string
      recipient_user_id: string
      recipient_phone: string
      recipient_kind: string
    }>()
  if (!notification) return 'NOT_FOUND'
  if (
    message.accountSid !== expectedProjectId ||
    message.from !== expectedFrom ||
    message.to !== notification.recipient_phone ||
    notification.recipient_user_id !== expectedRecipientUserId ||
    notification.recipient_kind !== 'PILOT_ADMIN'
  )
    return 'AUTHENTICITY_FAILED'
  const status = map[message.status.toLowerCase()]
  if (!status || !terminal.has(status)) return 'NON_TERMINAL'
  if (notification.status === status) return 'UNCHANGED'
  if (terminal.has(notification.status)) return 'AUTHENTICITY_FAILED'
  const failureReason =
    status === 'FAILED' || status === 'UNDELIVERED'
      ? (message.errorMessage ?? message.errorCode ?? null)
      : null
  await db
    .prepare(
      `UPDATE notifications SET status=?,delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE delivered_at END,failed_at=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failed_at END,failure_reason=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failure_reason END WHERE id=?`,
    )
    .bind(status, status, now, status, now, status, failureReason, notification.id)
    .run()
  return 'UPDATED'
}

export async function reconcileStaleSignalWireNotification(
  db: D1Database,
  message: SignalWireMessage,
  expectedProjectId: string,
  expectedFrom: string,
  now = new Date().toISOString(),
): Promise<ReconciliationResult> {
  const notification = await db
    .prepare(
      `SELECT n.id,n.status,u.phone AS recipient_phone FROM notifications n JOIN users u ON u.id=n.recipient_user_id WHERE n.provider_message_id=? AND n.provider='SIGNALWIRE'`,
    )
    .bind(message.sid)
    .first<{ id: string; status: string; recipient_phone: string }>()
  if (!notification) return 'NOT_FOUND'
  if (
    message.accountSid !== expectedProjectId ||
    message.from !== expectedFrom ||
    message.to !== notification.recipient_phone
  )
    return 'AUTHENTICITY_FAILED'
  const status = map[message.status.toLowerCase()]
  if (!status || !terminal.has(status)) return 'NON_TERMINAL'
  if (notification.status === status) return 'UNCHANGED'
  if (terminal.has(notification.status)) return 'AUTHENTICITY_FAILED'
  const failureReason =
    status === 'FAILED' || status === 'UNDELIVERED'
      ? (message.errorMessage ?? message.errorCode ?? null)
      : null
  await db.batch([
    db
      .prepare(
        `UPDATE notifications SET status=?,delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE delivered_at END,failed_at=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failed_at END,failure_reason=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failure_reason END WHERE id=? AND status='SENT'`,
      )
      .bind(status, status, now, status, now, status, failureReason, notification.id),
    db
      .prepare(
        `INSERT INTO signalwire_reconciliations(id,notification_id,provider_message_id,previous_status,authoritative_status,outcome,reconciled_at) VALUES(?,?,?,?,?,'UPDATED',?)`,
      )
      .bind(crypto.randomUUID(), notification.id, message.sid, notification.status, status, now),
  ])
  return 'UPDATED'
}

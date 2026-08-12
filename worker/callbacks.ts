import type { D1Database } from './d1'

export async function applyTwilioCallback(
  db: D1Database,
  input: { messageSid: string; messageStatus: string; errorCode?: string },
  now = new Date().toISOString(),
): Promise<'UPDATED' | 'DUPLICATE' | 'IGNORED' | 'NOT_FOUND'> {
  const notification = await db
    .prepare('SELECT id,status FROM notifications WHERE provider_message_id=?')
    .bind(input.messageSid)
    .first<{ id: string; status: string }>()
  if (!notification) return 'NOT_FOUND'
  const map: Record<string, string> = {
    delivered: 'DELIVERED',
    failed: 'FAILED',
    undelivered: 'UNDELIVERED',
    sent: 'SENT',
    queued: 'SENT',
  }
  const status = map[input.messageStatus.toLowerCase()]
  if (!status) return 'IGNORED'
  const callbackId = `${input.messageSid}:${input.messageStatus}:${input.errorCode ?? ''}`
  const inserted = await db
    .prepare(
      'INSERT OR IGNORE INTO notification_callbacks(id,provider_message_id,status,received_at,payload) VALUES(?,?,?,?,?)',
    )
    .bind(callbackId, input.messageSid, status, now, JSON.stringify(input))
    .run()
  if (Number(inserted.meta?.changes ?? 0) === 0) return 'DUPLICATE'
  await db
    .prepare(
      `UPDATE notifications SET status=?,delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE delivered_at END,failed_at=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failed_at END,failure_reason=CASE WHEN ? IN ('FAILED','UNDELIVERED') THEN ? ELSE failure_reason END WHERE id=?`,
    )
    .bind(status, status, now, status, now, status, input.errorCode ?? null, notification.id)
    .run()
  return 'UPDATED'
}

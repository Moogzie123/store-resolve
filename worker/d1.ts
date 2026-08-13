import type { AppState, Complaint, Notification, Store, User } from '../src/lib/types'

export interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
  meta?: Record<string, unknown>
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<D1Result>
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(query: string): Promise<D1Result>
}

const bool = (value: unknown) => Boolean(value)
export async function loadState(db: D1Database): Promise<AppState> {
  const [userRows, storeRows, complaintRows, eventRows, notificationRows, settingRows] =
    await Promise.all([
      db.prepare('SELECT * FROM users ORDER BY id').all<Record<string, unknown>>(),
      db.prepare('SELECT * FROM stores ORDER BY id').all<Record<string, unknown>>(),
      db
        .prepare('SELECT * FROM complaints ORDER BY received_at DESC')
        .all<Record<string, unknown>>(),
      db
        .prepare('SELECT * FROM complaint_events ORDER BY timestamp')
        .all<Record<string, unknown>>(),
      db.prepare('SELECT * FROM notifications ORDER BY created_at').all<Record<string, unknown>>(),
      db.prepare('SELECT * FROM settings').all<{ key: string; value: string }>(),
    ])
  const users: User[] = userRows.results.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    email: String(r.email ?? ''),
    phone: String(r.phone ?? ''),
    role: r.role as User['role'],
    active: bool(r.active),
    smsEnabled: bool(r.sms_enabled),
    timezone: String(r.timezone),
  }))
  const stores: Store[] = storeRows.results.map((r) => ({
    id: String(r.id),
    number: String(r.dunkin_store_number),
    name: String(r.name),
    address: String(r.address),
    city: String(r.city),
    state: String(r.state),
    postalCode: String(r.postal_code),
    phone: String(r.phone),
    active: bool(r.active),
    managerId: String(r.manager_id),
  }))
  const eventMap = new Map<string, Complaint['events']>()
  for (const r of eventRows.results) {
    const list = eventMap.get(String(r.complaint_id)) ?? []
    list.push({
      id: String(r.id),
      complaintId: String(r.complaint_id),
      type: r.event_type as Complaint['events'][number]['type'],
      actor: String(r.actor),
      timestamp: String(r.timestamp),
      metadata: r.metadata ? JSON.parse(String(r.metadata)) : undefined,
    })
    eventMap.set(String(r.complaint_id), list)
  }
  const notificationMap = new Map<string, Notification[]>()
  for (const r of notificationRows.results) {
    const n: Notification = {
      id: String(r.id),
      complaintId: String(r.complaint_id ?? ''),
      eventType: r.event_type as Notification['eventType'],
      recipientUserId: String(r.recipient_user_id),
      channel: r.channel as Notification['channel'],
      message: String(r.message),
      status: r.status as Notification['status'],
      provider: r.provider as Notification['provider'],
      providerMessageId: r.provider_message_id ? String(r.provider_message_id) : undefined,
      createdAt: String(r.created_at),
      sentAt: r.sent_at ? String(r.sent_at) : undefined,
      deliveredAt: r.delivered_at ? String(r.delivered_at) : undefined,
      failedAt: r.failed_at ? String(r.failed_at) : undefined,
      failureReason: r.failure_reason ? String(r.failure_reason) : undefined,
    }
    const list = notificationMap.get(n.complaintId) ?? []
    list.push(n)
    notificationMap.set(n.complaintId, list)
  }
  const complaints: Complaint[] = complaintRows.results.map((r) => ({
    id: String(r.id),
    externalCaseId: String(r.external_case_id),
    storeId: r.store_id ? String(r.store_id) : undefined,
    assignedManagerId: r.assigned_manager_id ? String(r.assigned_manager_id) : undefined,
    subject: String(r.subject),
    complaintText: String(r.complaint_text),
    category: String(r.category),
    severity: r.severity as Complaint['severity'],
    status: r.status as Complaint['status'],
    isAckOverdue: bool(r.is_ack_overdue),
    isResolutionOverdue: bool(r.is_resolution_overdue),
    routingReason: String(r.routing_reason),
    routingConfidence: r.routing_confidence as Complaint['routingConfidence'],
    receivedAt: String(r.received_at),
    dunkinAcknowledgedAt: String(r.dunkin_acknowledged_at),
    acknowledgementBody: String(r.acknowledgment_body),
    managerNotifiedAt: r.manager_notified_at ? String(r.manager_notified_at) : undefined,
    managerAcknowledgedAt: r.manager_acknowledged_at
      ? String(r.manager_acknowledged_at)
      : undefined,
    investigationStartedAt: r.investigation_started_at
      ? String(r.investigation_started_at)
      : undefined,
    resolutionSubmittedAt: r.resolution_submitted_at
      ? String(r.resolution_submitted_at)
      : undefined,
    closedAt: r.closed_at ? String(r.closed_at) : undefined,
    closedBy: r.closed_by ? String(r.closed_by) : undefined,
    ackDeadline: String(r.ack_deadline),
    resolutionDeadline: r.resolution_deadline ? String(r.resolution_deadline) : undefined,
    managerFindings: r.manager_findings ? String(r.manager_findings) : undefined,
    customerContacted: r.customer_contacted == null ? undefined : bool(r.customer_contacted),
    customerContactOutcome: r.customer_contact_outcome
      ? String(r.customer_contact_outcome)
      : undefined,
    correctiveAction: r.corrective_action ? String(r.corrective_action) : undefined,
    resolutionNotes: r.resolution_notes ? String(r.resolution_notes) : undefined,
    events: eventMap.get(String(r.id)) ?? [],
    notifications: notificationMap.get(String(r.id)) ?? [],
    followUps: r.follow_ups ? JSON.parse(String(r.follow_ups)) : [],
  }))
  const settings = Object.fromEntries(settingRows.results.map((r) => [r.key, r.value]))
  return {
    users,
    stores,
    complaints,
    activeUserId: '',
    testNotifications: notificationMap.get('') ?? [],
    config: {
      mode: (settings.notification_mode ?? 'FAMILY_PILOT') as AppState['config']['mode'],
      externalNotificationsEnabled: settings.external_notifications_enabled === 'true',
      pilotStoreId: settings.pilot_store_id || undefined,
    },
  }
}

export async function persistState(db: D1Database, state: AppState): Promise<void> {
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  for (const u of state.users)
    statements.push(
      db
        .prepare(
          `UPDATE users SET name=?,email=?,phone=?,active=?,sms_enabled=?,updated_at=? WHERE id=?`,
        )
        .bind(u.name, u.email, u.phone, u.active ? 1 : 0, u.smsEnabled ? 1 : 0, now, u.id),
    )
  for (const c of state.complaints) {
    statements.push(
      db
        .prepare(
          `INSERT INTO complaints (id,external_case_id,store_id,assigned_manager_id,subject,complaint_text,category,severity,status,is_ack_overdue,is_resolution_overdue,routing_reason,routing_confidence,received_at,dunkin_acknowledged_at,acknowledgment_body,manager_notified_at,manager_acknowledged_at,investigation_started_at,resolution_submitted_at,closed_at,closed_by,ack_deadline,resolution_deadline,manager_findings,customer_contacted,customer_contact_outcome,corrective_action,resolution_notes,follow_ups,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET store_id=excluded.store_id,assigned_manager_id=excluded.assigned_manager_id,status=excluded.status,is_ack_overdue=excluded.is_ack_overdue,is_resolution_overdue=excluded.is_resolution_overdue,manager_acknowledged_at=excluded.manager_acknowledged_at,investigation_started_at=excluded.investigation_started_at,resolution_submitted_at=excluded.resolution_submitted_at,closed_at=excluded.closed_at,closed_by=excluded.closed_by,manager_findings=excluded.manager_findings,customer_contacted=excluded.customer_contacted,customer_contact_outcome=excluded.customer_contact_outcome,corrective_action=excluded.corrective_action,resolution_notes=excluded.resolution_notes,follow_ups=excluded.follow_ups,updated_at=excluded.updated_at`,
        )
        .bind(
          c.id,
          c.externalCaseId,
          c.storeId ?? null,
          c.assignedManagerId ?? null,
          c.subject,
          c.complaintText,
          c.category,
          c.severity,
          c.status,
          c.isAckOverdue ? 1 : 0,
          c.isResolutionOverdue ? 1 : 0,
          c.routingReason,
          c.routingConfidence,
          c.receivedAt,
          c.dunkinAcknowledgedAt,
          c.acknowledgementBody,
          c.managerNotifiedAt ?? null,
          c.managerAcknowledgedAt ?? null,
          c.investigationStartedAt ?? null,
          c.resolutionSubmittedAt ?? null,
          c.closedAt ?? null,
          c.closedBy ?? null,
          c.ackDeadline,
          c.resolutionDeadline ?? null,
          c.managerFindings ?? null,
          c.customerContacted == null ? null : c.customerContacted ? 1 : 0,
          c.customerContactOutcome ?? null,
          c.correctiveAction ?? null,
          c.resolutionNotes ?? null,
          JSON.stringify(c.followUps),
          c.receivedAt,
          now,
        ),
    )
    for (const e of c.events)
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO complaint_events (id,complaint_id,event_type,actor,timestamp,metadata) VALUES (?,?,?,?,?,?)`,
          )
          .bind(
            e.id,
            c.id,
            e.type,
            e.actor,
            e.timestamp,
            e.metadata ? JSON.stringify(e.metadata) : null,
          ),
      )
    for (const n of c.notifications)
      statements.push(
        db
          .prepare(
            `INSERT INTO notifications (id,complaint_id,event_type,recipient_user_id,channel,message,status,provider,provider_message_id,created_at,sent_at,delivered_at,failed_at,failure_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,provider_message_id=COALESCE(excluded.provider_message_id,notifications.provider_message_id),sent_at=COALESCE(excluded.sent_at,notifications.sent_at),delivered_at=COALESCE(excluded.delivered_at,notifications.delivered_at),failed_at=COALESCE(excluded.failed_at,notifications.failed_at),failure_reason=excluded.failure_reason`,
          )
          .bind(
            n.id,
            n.complaintId,
            n.eventType,
            n.recipientUserId,
            n.channel,
            n.message,
            n.status,
            n.provider,
            (n as Notification & { providerMessageId?: string }).providerMessageId ?? null,
            n.createdAt,
            n.sentAt ?? null,
            n.deliveredAt ?? null,
            n.failedAt ?? null,
            n.failureReason ?? null,
          ),
      )
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO settings(key,value,updated_at) VALUES('notification_mode',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .bind(state.config.mode, now),
    db
      .prepare(
        `INSERT INTO settings(key,value,updated_at) VALUES('external_notifications_enabled',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .bind(String(state.config.externalNotificationsEnabled), now),
  )
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50))
}

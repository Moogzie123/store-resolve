import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ...timestamps,
})
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').references(() => organizations.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  role: text('role').notNull(),
  recipientKind: text('recipient_kind').notNull().default('STANDARD'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  smsEnabled: integer('sms_enabled', { mode: 'boolean' }).notNull().default(false),
  timezone: text('timezone').notNull(),
  ...timestamps,
})
export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  dunkinStoreNumber: text('dunkin_store_number').notNull().unique(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  city: text('city').notNull(),
  state: text('state').notNull(),
  postalCode: text('postal_code').notNull(),
  phone: text('phone').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  managerId: text('manager_id').references(() => users.id),
  backupManagerId: text('backup_manager_id').references(() => users.id),
  ...timestamps,
})
export const complaints = sqliteTable('complaints', {
  id: text('id').primaryKey(),
  externalCaseId: text('external_case_id').notNull().unique(),
  storeId: text('store_id').references(() => stores.id),
  assignedManagerId: text('assigned_manager_id').references(() => users.id),
  subject: text('subject').notNull(),
  complaintText: text('complaint_text').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  isAckOverdue: integer('is_ack_overdue', { mode: 'boolean' }).notNull().default(false),
  isResolutionOverdue: integer('is_resolution_overdue', { mode: 'boolean' })
    .notNull()
    .default(false),
  routingReason: text('routing_reason').notNull(),
  routingConfidence: text('routing_confidence').notNull(),
  receivedAt: text('received_at').notNull(),
  dunkinAcknowledgedAt: text('dunkin_acknowledged_at'),
  acknowledgmentBody: text('acknowledgment_body'),
  managerNotifiedAt: text('manager_notified_at'),
  managerAcknowledgedAt: text('manager_acknowledged_at'),
  investigationStartedAt: text('investigation_started_at'),
  resolutionSubmittedAt: text('resolution_submitted_at'),
  closedAt: text('closed_at'),
  closedBy: text('closed_by'),
  ackDeadline: text('ack_deadline').notNull(),
  resolutionDeadline: text('resolution_deadline'),
  managerFindings: text('manager_findings'),
  customerContacted: integer('customer_contacted', { mode: 'boolean' }),
  customerContactOutcome: text('customer_contact_outcome'),
  correctiveAction: text('corrective_action'),
  resolutionNotes: text('resolution_notes'),
  followUps: text('follow_ups', { mode: 'json' }).notNull().default([]),
  ...timestamps,
})
export const complaintEvents = sqliteTable('complaint_events', {
  id: text('id').primaryKey(),
  complaintId: text('complaint_id')
    .notNull()
    .references(() => complaints.id),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull(),
  timestamp: text('timestamp').notNull(),
  metadata: text('metadata', { mode: 'json' }),
})
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  complaintId: text('complaint_id').references(() => complaints.id),
  eventType: text('event_type').notNull(),
  recipientUserId: text('recipient_user_id')
    .notNull()
    .references(() => users.id),
  channel: text('channel').notNull(),
  message: text('message').notNull(),
  status: text('status').notNull(),
  provider: text('provider').notNull(),
  providerMessageId: text('provider_message_id'),
  createdAt: text('created_at').notNull(),
  sentAt: text('sent_at'),
  deliveredAt: text('delivered_at'),
  failedAt: text('failed_at'),
  failureReason: text('failure_reason'),
})
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const notificationCallbacks = sqliteTable('notification_callbacks', {
  id: text('id').primaryKey(),
  providerMessageId: text('provider_message_id').notNull(),
  status: text('status').notNull(),
  receivedAt: text('received_at').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
})
export const testNotificationRateLimits = sqliteTable('test_notification_rate_limits', {
  recipientUserId: text('recipient_user_id')
    .primaryKey()
    .references(() => users.id),
  lastSentAt: text('last_sent_at').notNull(),
})

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
  complaintNotificationsEnabled: integer('complaint_notifications_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
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
  source: text('source').notNull().default('MANUAL'),
  gmailMessageId: text('gmail_message_id').unique(),
  gmailThreadId: text('gmail_thread_id'),
  sourceSender: text('source_sender'),
  customerName: text('customer_name'),
  customerEmail: text('customer_email'),
  customerPhone: text('customer_phone'),
  occurrenceAt: text('occurrence_at'),
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
  acknowledgementStatus: text('acknowledgement_status').notNull().default('DISABLED'),
  managerNotifiedAt: text('manager_notified_at'),
  managerAcknowledgedAt: text('manager_acknowledged_at'),
  investigationStartedAt: text('investigation_started_at'),
  resolutionSubmittedAt: text('resolution_submitted_at'),
  closedAt: text('closed_at'),
  closedBy: text('closed_by'),
  ownerReviewedAt: text('owner_reviewed_at'),
  reopenedAt: text('reopened_at'),
  reopenReason: text('reopen_reason'),
  ownerNotes: text('owner_notes'),
  ackDeadline: text('ack_deadline').notNull(),
  resolutionDeadline: text('resolution_deadline'),
  managerFindings: text('manager_findings'),
  customerContacted: integer('customer_contacted', { mode: 'boolean' }),
  customerContactedAt: text('customer_contacted_at'),
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
export const storeAliases = sqliteTable('store_aliases', {
  id: text('id').primaryKey(),
  storeId: text('store_id')
    .notNull()
    .references(() => stores.id),
  aliasNormalized: text('alias_normalized').notNull().unique(),
  createdAt: text('created_at').notNull(),
})
export const userStoreAssignments = sqliteTable('user_store_assignments', {
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  storeId: text('store_id')
    .notNull()
    .references(() => stores.id),
  createdAt: text('created_at').notNull(),
})
export const gmailMessages = sqliteTable('gmail_messages', {
  gmailMessageId: text('gmail_message_id').primaryKey(),
  gmailThreadId: text('gmail_thread_id').notNull(),
  complaintId: text('complaint_id').references(() => complaints.id),
  internalDate: text('internal_date').notNull(),
  sender: text('sender').notNull(),
  recipients: text('recipients').notNull(),
  subject: text('subject').notNull(),
  messageIdHeader: text('message_id_header'),
  inReplyTo: text('in_reply_to'),
  referencesHeader: text('references_header'),
  processingStatus: text('processing_status').notNull(),
  processingDetail: text('processing_detail'),
  isFollowUp: integer('is_follow_up', { mode: 'boolean' }).notNull().default(false),
  acknowledgmentStatus: text('acknowledgment_status').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  processedAt: text('processed_at'),
  updatedAt: text('updated_at').notNull(),
})
export const emailAcknowledgments = sqliteTable('email_acknowledgments', {
  id: text('id').primaryKey(),
  complaintId: text('complaint_id')
    .notNull()
    .unique()
    .references(() => complaints.id),
  gmailThreadId: text('gmail_thread_id').notNull(),
  sourceGmailMessageId: text('source_gmail_message_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status').notNull(),
  providerMessageId: text('provider_message_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  sentAt: text('sent_at'),
})
export const integrationEvents = sqliteTable('integration_events', {
  id: text('id').primaryKey(),
  integration: text('integration').notNull(),
  eventType: text('event_type').notNull(),
  entityId: text('entity_id'),
  outcome: text('outcome').notNull(),
  detailCode: text('detail_code'),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
})
export const backgroundJobRuns = sqliteTable('background_job_runs', {
  id: text('id').primaryKey(),
  jobName: text('job_name').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  outcome: text('outcome').notNull(),
  processedCount: integer('processed_count').notNull().default(0),
  errorCode: text('error_code'),
})

export const backgroundJobLocks = sqliteTable('background_job_locks', {
  jobName: text('job_name').primaryKey(),
  lockedUntil: text('locked_until').notNull(),
  ownerRunId: text('owner_run_id').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const signalwireReconciliations = sqliteTable('signalwire_reconciliations', {
  id: text('id').primaryKey(),
  notificationId: text('notification_id')
    .notNull()
    .references(() => notifications.id),
  providerMessageId: text('provider_message_id').notNull(),
  previousStatus: text('previous_status').notNull(),
  authoritativeStatus: text('authoritative_status').notNull(),
  outcome: text('outcome').notNull(),
  reconciledAt: text('reconciled_at').notNull(),
})
export const escalationEvents = sqliteTable('escalation_events', {
  id: text('id').primaryKey(),
  complaintId: text('complaint_id')
    .notNull()
    .references(() => complaints.id),
  escalationType: text('escalation_type').notNull(),
  escalationSequence: integer('escalation_sequence').notNull(),
  createdAt: text('created_at').notNull(),
})

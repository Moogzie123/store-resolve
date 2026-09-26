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
  ingestionMode: text('ingestion_mode').notNull().default('LIVE'),
  operationalStartedAt: text('operational_started_at'),
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

export const mailSourceMessages = sqliteTable('mail_source_messages', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  mailboxKey: text('mailbox_key').notNull(),
  providerMessageId: text('provider_message_id').notNull(),
  internetMessageId: text('internet_message_id'),
  conversationId: text('conversation_id'),
  parentFolderId: text('parent_folder_id'),
  direction: text('direction').notNull(),
  receivedAt: text('received_at').notNull(),
  discoveredAt: text('discovered_at').notNull(),
  subject: text('subject').notNull(),
  senderAddress: text('sender_address').notNull(),
  recipientsJson: text('recipients_json', { mode: 'json' }).notNull().default([]),
  rawContentRef: text('raw_content_ref'),
  rawContentSha256: text('raw_content_sha256'),
  transportMetadataSha256: text('transport_metadata_sha256'),
  ingestionMode: text('ingestion_mode').notNull(),
  processingState: text('processing_state').notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  ...timestamps,
})

export const mailDiscoveryCursors = sqliteTable('mail_discovery_cursors', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  mailboxKey: text('mailbox_key').notNull(),
  scope: text('scope').notNull(),
  cursorValue: text('cursor_value'),
  highWaterReceivedAt: text('high_water_received_at'),
  lastStartedAt: text('last_started_at'),
  lastSucceededAt: text('last_succeeded_at'),
  lastErrorCode: text('last_error_code'),
  ...timestamps,
})

export const mailProcessingRuns = sqliteTable('mail_processing_runs', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id')
    .notNull()
    .references(() => mailSourceMessages.id),
  runNumber: integer('run_number').notNull(),
  status: text('status').notNull(),
  normalizationVersion: text('normalization_version').notNull(),
  normalizedOutputJson: text('normalized_output_json', { mode: 'json' }),
  deterministicEvidenceJson: text('deterministic_evidence_json', { mode: 'json' }),
  aiStructuredOutputJson: text('ai_structured_output_json', { mode: 'json' }),
  validationResultJson: text('validation_result_json', { mode: 'json' }),
  modelName: text('model_name'),
  modelSnapshot: text('model_snapshot'),
  promptVersion: text('prompt_version'),
  schemaVersion: text('schema_version'),
  sourceContentSha256: text('source_content_sha256'),
  modelInputSha256: text('model_input_sha256'),
  modelOutputSha256: text('model_output_sha256'),
  latencyMs: integer('latency_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),
  disagreementFlagsJson: text('disagreement_flags_json', { mode: 'json' }).notNull().default([]),
  errorCode: text('error_code'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  ...timestamps,
})

export const canonicalMailEvents = sqliteTable('canonical_mail_events', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id')
    .notNull()
    .references(() => mailSourceMessages.id),
  processingRunId: text('processing_run_id').references(() => mailProcessingRuns.id),
  complaintId: text('complaint_id').references(() => complaints.id),
  eventVersion: text('event_version').notNull(),
  eventType: text('event_type').notNull(),
  externalCaseId: text('external_case_id'),
  canonicalStoreNumber: text('canonical_store_number'),
  ingestionMode: text('ingestion_mode').notNull(),
  payloadJson: text('payload_json', { mode: 'json' }).notNull(),
  occurredAt: text('occurred_at'),
  validatedAt: text('validated_at').notNull(),
  createdAt: text('created_at').notNull(),
})

export const complaintSources = sqliteTable('complaint_sources', {
  id: text('id').primaryKey(),
  complaintId: text('complaint_id')
    .notNull()
    .references(() => complaints.id),
  sourceMessageId: text('source_message_id')
    .notNull()
    .unique()
    .references(() => mailSourceMessages.id),
  canonicalMailEventId: text('canonical_mail_event_id').references(() => canonicalMailEvents.id),
  sourceRole: text('source_role').notNull(),
  linkageBasis: text('linkage_basis').notNull(),
  materialUpdate: integer('material_update', { mode: 'boolean' }).notNull().default(false),
  linkedAt: text('linked_at').notNull(),
})

export const mailReviewItems = sqliteTable('mail_review_items', {
  id: text('id').primaryKey(),
  sourceMessageId: text('source_message_id')
    .notNull()
    .references(() => mailSourceMessages.id),
  processingRunId: text('processing_run_id').references(() => mailProcessingRuns.id),
  canonicalMailEventId: text('canonical_mail_event_id').references(() => canonicalMailEvents.id),
  complaintId: text('complaint_id').references(() => complaints.id),
  status: text('status').notNull(),
  reasonCode: text('reason_code').notNull(),
  disagreementFlagsJson: text('disagreement_flags_json', { mode: 'json' }).notNull().default([]),
  resolutionJson: text('resolution_json', { mode: 'json' }),
  reviewedBy: text('reviewed_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  updatedAt: text('updated_at').notNull(),
})

export const responseActions = sqliteTable('response_actions', {
  id: text('id').primaryKey(),
  complaintId: text('complaint_id')
    .notNull()
    .references(() => complaints.id),
  sourceMessageId: text('source_message_id').references(() => mailSourceMessages.id),
  responseKind: text('response_kind').notNull(),
  policyVersion: text('policy_version').notNull(),
  policyState: text('policy_state').notNull(),
  contentKind: text('content_kind'),
  contentRef: text('content_ref'),
  templateVersion: text('template_version'),
  modelName: text('model_name'),
  modelSnapshot: text('model_snapshot'),
  promptVersion: text('prompt_version'),
  approvedBy: text('approved_by').references(() => users.id),
  approvedAt: text('approved_at'),
  ...timestamps,
})

export const outboundDeliveries = sqliteTable('outbound_deliveries', {
  id: text('id').primaryKey(),
  responseActionId: text('response_action_id').references(() => responseActions.id),
  notificationId: text('notification_id').references(() => notifications.id),
  channel: text('channel').notNull(),
  provider: text('provider').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  status: text('status').notNull(),
  providerMessageId: text('provider_message_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  lastErrorCode: text('last_error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  sentAt: text('sent_at'),
  deliveredAt: text('delivered_at'),
})

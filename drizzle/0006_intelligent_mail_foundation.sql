-- Intelligent Mail Intake v1 foundation. This migration is additive and does not enable I/O.

ALTER TABLE complaints ADD COLUMN ingestion_mode TEXT NOT NULL DEFAULT 'LIVE'
  CHECK(ingestion_mode IN ('LIVE','BACKFILL','TEST'));
ALTER TABLE complaints ADD COLUMN operational_started_at TEXT;

-- Existing operational complaints retain their current SLA basis. The approved historical
-- production complaint remains auditable but no longer participates in future live SLA runs.
UPDATE complaints SET operational_started_at=received_at WHERE id <> 'SR-2026-0001';
UPDATE complaints SET ingestion_mode='BACKFILL',operational_started_at=NULL
WHERE id='SR-2026-0001';

CREATE TABLE mail_source_messages (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('MICROSOFT_GRAPH','GMAIL')),
  mailbox_key TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  internet_message_id TEXT,
  conversation_id TEXT,
  parent_folder_id TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND','UNKNOWN')),
  received_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  raw_content_ref TEXT,
  raw_content_sha256 TEXT,
  transport_metadata_sha256 TEXT,
  ingestion_mode TEXT NOT NULL CHECK(ingestion_mode IN ('LIVE','BACKFILL','TEST')),
  processing_state TEXT NOT NULL CHECK(processing_state IN (
    'DISCOVERED','PROCESSING','RETRY_WAIT','REVIEW_REQUIRED','NON_ACTIONABLE','COMPLETED','FAILED_PERMANENT'
  )),
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,mailbox_key,provider_message_id)
);
CREATE INDEX mail_source_processing_idx
  ON mail_source_messages(processing_state,lease_expires_at,received_at);
CREATE INDEX mail_source_conversation_idx
  ON mail_source_messages(provider,mailbox_key,conversation_id);

CREATE TABLE mail_discovery_cursors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  mailbox_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  cursor_value TEXT,
  high_water_received_at TEXT,
  last_started_at TEXT,
  last_succeeded_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,mailbox_key,scope)
);

CREATE TABLE mail_processing_runs (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL REFERENCES mail_source_messages(id),
  run_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'PROCESSING','RETRY_WAIT','REVIEW_REQUIRED','NON_ACTIONABLE','COMPLETED','FAILED_PERMANENT'
  )),
  normalization_version TEXT NOT NULL,
  normalized_output_json TEXT,
  deterministic_evidence_json TEXT,
  ai_structured_output_json TEXT,
  validation_result_json TEXT,
  model_name TEXT,
  model_snapshot TEXT,
  prompt_version TEXT,
  schema_version TEXT,
  source_content_sha256 TEXT,
  model_input_sha256 TEXT,
  model_output_sha256 TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  disagreement_flags_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_message_id,run_number)
);
CREATE INDEX mail_processing_source_idx
  ON mail_processing_runs(source_message_id,run_number DESC);

CREATE TABLE canonical_mail_events (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL REFERENCES mail_source_messages(id),
  processing_run_id TEXT REFERENCES mail_processing_runs(id),
  complaint_id TEXT REFERENCES complaints(id),
  event_version TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'NEW_CASE','FOLLOW_UP','CASE_UPDATE','RESPONSE_REQUEST','DUPLICATE_SOURCE','NON_ACTIONABLE','REVIEW_REQUIRED'
  )),
  external_case_id TEXT,
  canonical_store_number TEXT,
  ingestion_mode TEXT NOT NULL CHECK(ingestion_mode IN ('LIVE','BACKFILL','TEST')),
  payload_json TEXT NOT NULL,
  occurred_at TEXT,
  validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_message_id,event_version)
);
CREATE INDEX canonical_mail_case_idx ON canonical_mail_events(external_case_id,created_at);

CREATE TABLE complaint_sources (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL REFERENCES complaints(id),
  source_message_id TEXT NOT NULL UNIQUE REFERENCES mail_source_messages(id),
  canonical_mail_event_id TEXT REFERENCES canonical_mail_events(id),
  source_role TEXT NOT NULL CHECK(source_role IN (
    'INITIAL','FOLLOW_UP','CASE_UPDATE','DUPLICATE','RESPONSE_REQUEST'
  )),
  linkage_basis TEXT NOT NULL,
  material_update INTEGER NOT NULL DEFAULT 0,
  linked_at TEXT NOT NULL
);
CREATE INDEX complaint_sources_complaint_idx ON complaint_sources(complaint_id,linked_at);

CREATE TABLE mail_review_items (
  id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL REFERENCES mail_source_messages(id),
  processing_run_id TEXT REFERENCES mail_processing_runs(id),
  canonical_mail_event_id TEXT REFERENCES canonical_mail_events(id),
  complaint_id TEXT REFERENCES complaints(id),
  status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED','DISMISSED')),
  reason_code TEXT NOT NULL,
  disagreement_flags_json TEXT NOT NULL DEFAULT '[]',
  resolution_json TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX mail_review_open_idx ON mail_review_items(status,created_at);

CREATE TABLE response_actions (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL REFERENCES complaints(id),
  source_message_id TEXT REFERENCES mail_source_messages(id),
  response_kind TEXT NOT NULL CHECK(response_kind IN ('RECEIPT_ACK','SUBSTANTIVE_RESPONSE')),
  policy_version TEXT NOT NULL,
  policy_state TEXT NOT NULL CHECK(policy_state IN (
    'NOT_EVALUATED','NO_RESPONSE','ACK_ELIGIBLE','ACK_ALREADY_SENT','ACK_BLOCKED',
    'DRAFT_REQUIRED','OWNER_APPROVAL_REQUIRED','READY_TO_SEND','SENT'
  )),
  content_kind TEXT CHECK(content_kind IN ('DETERMINISTIC_TEMPLATE','AI_DRAFT','HUMAN_EDITED')),
  content_ref TEXT,
  template_version TEXT,
  model_name TEXT,
  model_snapshot TEXT,
  prompt_version TEXT,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(complaint_id,response_kind,policy_version)
);

CREATE TABLE outbound_deliveries (
  id TEXT PRIMARY KEY,
  response_action_id TEXT REFERENCES response_actions(id),
  notification_id TEXT REFERENCES notifications(id),
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS')),
  provider TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN (
    'PENDING','PROCESSING','SENT','DELIVERED','FAILED_RETRYABLE','FAILED_PERMANENT','SEND_UNKNOWN','SUPPRESSED'
  )),
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  CHECK(response_action_id IS NOT NULL OR notification_id IS NOT NULL)
);
CREATE INDEX outbound_delivery_work_idx
  ON outbound_deliveries(status,lease_expires_at,created_at);

-- Compatibility migration for the source messages already persisted by the pilot. Raw bodies
-- were not archived by the legacy schema, so raw_content_ref/hash intentionally remain NULL.
INSERT OR IGNORE INTO mail_source_messages(
  id,provider,mailbox_key,provider_message_id,internet_message_id,conversation_id,
  direction,received_at,discovered_at,subject,sender_address,recipients_json,
  ingestion_mode,processing_state,attempt_count,created_at,updated_at
)
SELECT
  gmail_message_id,'MICROSOFT_GRAPH','production',gmail_message_id,message_id_header,
  gmail_thread_id,'INBOUND',internal_date,first_seen_at,subject,sender,
  json_array(recipients),
  CASE WHEN complaint_id='SR-2026-0001' THEN 'BACKFILL' ELSE 'LIVE' END,
  CASE
    WHEN processing_status IN ('PROCESSED','ROUTING_REVIEW','DUPLICATE','FOLLOW_UP','IGNORED') THEN 'COMPLETED'
    WHEN processing_status IN ('FAILED_PARSING','FAILED_PERSISTENCE') THEN 'RETRY_WAIT'
    ELSE 'DISCOVERED'
  END,
  CASE WHEN processed_at IS NULL THEN 0 ELSE 1 END,
  first_seen_at,updated_at
FROM gmail_messages;

INSERT OR IGNORE INTO mail_processing_runs(
  id,source_message_id,run_number,status,normalization_version,
  deterministic_evidence_json,validation_result_json,source_content_sha256,
  disagreement_flags_json,started_at,completed_at,created_at,updated_at
)
SELECT
  'legacy-run:' || gm.gmail_message_id,gm.gmail_message_id,1,
  CASE WHEN gm.processing_status IN ('FAILED_PARSING','FAILED_PERSISTENCE') THEN 'RETRY_WAIT' ELSE 'COMPLETED' END,
  'legacy-deterministic-v1',
  json_object('caseId',c.external_case_id,'source','LEGACY_MIGRATION'),
  json_object('outcome','MIGRATED','processingStatus',gm.processing_status),
  NULL,'[]',gm.first_seen_at,gm.processed_at,gm.first_seen_at,gm.updated_at
FROM gmail_messages gm
LEFT JOIN complaints c ON c.id=gm.complaint_id;

INSERT OR IGNORE INTO canonical_mail_events(
  id,source_message_id,processing_run_id,complaint_id,event_version,event_type,
  external_case_id,canonical_store_number,ingestion_mode,payload_json,
  occurred_at,validated_at,created_at
)
SELECT
  'legacy-event:' || gm.gmail_message_id,gm.gmail_message_id,
  'legacy-run:' || gm.gmail_message_id,gm.complaint_id,'mail-event.v1',
  CASE WHEN gm.is_follow_up=1 THEN 'FOLLOW_UP' ELSE 'NEW_CASE' END,
  c.external_case_id,s.dunkin_store_number,
  CASE WHEN gm.complaint_id='SR-2026-0001' THEN 'BACKFILL' ELSE 'LIVE' END,
  json_object('migration','LEGACY_MAIL_SOURCE','materialUpdate',CASE WHEN gm.is_follow_up=1 THEN 1 ELSE 0 END),
  gm.internal_date,COALESCE(gm.processed_at,gm.updated_at),gm.first_seen_at
FROM gmail_messages gm
LEFT JOIN complaints c ON c.id=gm.complaint_id
LEFT JOIN stores s ON s.id=c.store_id
WHERE gm.complaint_id IS NOT NULL;

INSERT OR IGNORE INTO complaint_sources(
  id,complaint_id,source_message_id,canonical_mail_event_id,source_role,
  linkage_basis,material_update,linked_at
)
SELECT
  'legacy-link:' || gmail_message_id,complaint_id,gmail_message_id,
  'legacy-event:' || gmail_message_id,
  CASE WHEN is_follow_up=1 THEN 'FOLLOW_UP' ELSE 'INITIAL' END,
  CASE WHEN is_follow_up=1 THEN 'EXACT_CASE_ID' ELSE 'INITIAL_SOURCE' END,
  is_follow_up,COALESCE(processed_at,updated_at)
FROM gmail_messages
WHERE complaint_id IS NOT NULL;

INSERT OR IGNORE INTO mail_review_items(
  id,source_message_id,processing_run_id,canonical_mail_event_id,complaint_id,
  status,reason_code,disagreement_flags_json,created_at,updated_at
)
SELECT
  'legacy-review:' || gm.gmail_message_id,gm.gmail_message_id,
  'legacy-run:' || gm.gmail_message_id,'legacy-event:' || gm.gmail_message_id,
  gm.complaint_id,'OPEN','STORE_NOT_CONFIGURED','[]',
  COALESCE(gm.processed_at,gm.updated_at),COALESCE(gm.processed_at,gm.updated_at)
FROM gmail_messages gm
JOIN complaints c ON c.id=gm.complaint_id
WHERE c.status='ROUTING_REVIEW' AND gm.is_follow_up=0;

-- Foundation deployment must leave every external I/O gate disabled.
INSERT INTO settings(key,value,updated_at) VALUES
  ('email_ingestion_enabled','false',datetime('now')),
  ('email_ack_enabled','false',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value='false',updated_at=excluded.updated_at;


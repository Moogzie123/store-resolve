ALTER TABLE complaints ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE complaints ADD COLUMN gmail_message_id TEXT;
ALTER TABLE complaints ADD COLUMN gmail_thread_id TEXT;
ALTER TABLE complaints ADD COLUMN source_sender TEXT;
ALTER TABLE complaints ADD COLUMN customer_name TEXT;
ALTER TABLE complaints ADD COLUMN customer_email TEXT;
ALTER TABLE complaints ADD COLUMN customer_phone TEXT;
ALTER TABLE complaints ADD COLUMN occurrence_at TEXT;
ALTER TABLE complaints ADD COLUMN customer_contacted_at TEXT;
ALTER TABLE complaints ADD COLUMN acknowledgement_status TEXT NOT NULL DEFAULT 'DISABLED';
ALTER TABLE complaints ADD COLUMN owner_reviewed_at TEXT;
ALTER TABLE complaints ADD COLUMN reopened_at TEXT;
ALTER TABLE complaints ADD COLUMN reopen_reason TEXT;
ALTER TABLE complaints ADD COLUMN owner_notes TEXT;
ALTER TABLE users ADD COLUMN complaint_notifications_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE users SET complaint_notifications_enabled=1 WHERE id IN ('father','uncle','grandfather');

CREATE UNIQUE INDEX complaint_gmail_message_idx ON complaints(gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX complaint_gmail_thread_idx ON complaints(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;

CREATE TABLE store_aliases (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  alias_normalized TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE user_store_assignments (
  user_id TEXT NOT NULL REFERENCES users(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, store_id)
);

INSERT OR IGNORE INTO user_store_assignments(user_id,store_id,created_at)
SELECT manager_id,id,datetime('now') FROM stores WHERE manager_id IS NOT NULL;

CREATE TABLE gmail_messages (
  gmail_message_id TEXT PRIMARY KEY,
  gmail_thread_id TEXT NOT NULL,
  complaint_id TEXT REFERENCES complaints(id),
  internal_date TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipients TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_id_header TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  processing_status TEXT NOT NULL,
  processing_detail TEXT,
  is_follow_up INTEGER NOT NULL DEFAULT 0,
  acknowledgment_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
  first_seen_at TEXT NOT NULL,
  processed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX gmail_thread_idx ON gmail_messages(gmail_thread_id);
CREATE INDEX gmail_processing_idx ON gmail_messages(processing_status,internal_date);

CREATE TABLE email_acknowledgments (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL UNIQUE REFERENCES complaints(id),
  gmail_thread_id TEXT NOT NULL,
  source_gmail_message_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE integration_events (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT,
  outcome TEXT NOT NULL,
  detail_code TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX integration_event_recent_idx ON integration_events(created_at DESC);

CREATE TABLE background_job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
CREATE INDEX background_job_recent_idx ON background_job_runs(job_name,started_at DESC);

CREATE TABLE background_job_locks (
  job_name TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL,
  owner_run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE signalwire_reconciliations (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  provider_message_id TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  authoritative_status TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reconciled_at TEXT NOT NULL
);

CREATE TABLE escalation_events (
  id TEXT PRIMARY KEY,
  complaint_id TEXT NOT NULL REFERENCES complaints(id),
  escalation_type TEXT NOT NULL,
  escalation_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(complaint_id, escalation_type, escalation_sequence)
);

INSERT INTO settings(key,value,updated_at) VALUES
  ('gmail_ingestion_enabled','false',datetime('now')),
  ('gmail_ack_enabled','false',datetime('now')),
  ('gmail_search_query','newer_than:30d',datetime('now')),
  ('manager_ack_deadline_minutes','30',datetime('now')),
  ('manager_resolution_target_hours','24',datetime('now')),
  ('escalation_interval_minutes','60',datetime('now')),
  ('signalwire_reconcile_after_minutes','10',datetime('now'))
ON CONFLICT(key) DO NOTHING;

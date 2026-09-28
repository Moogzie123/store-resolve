-- Phase C operations: response template storage for the approval-gated
-- ack/response workflow. Draft -> human approve -> (send disabled).
-- No production application yet: this file is schema-only and must be reviewed
-- before any D1 apply. Safety defaults are unchanged by this migration.

CREATE TABLE IF NOT EXISTS response_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  response_kind TEXT NOT NULL,
  subject_template TEXT,
  body_template TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_response_templates_kind_active
  ON response_templates(response_kind, active);

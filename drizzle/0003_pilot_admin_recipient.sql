ALTER TABLE users ADD COLUMN recipient_kind TEXT NOT NULL DEFAULT 'STANDARD' CHECK(recipient_kind IN ('STANDARD','PILOT_ADMIN'));

INSERT OR IGNORE INTO users (
  id, organization_id, name, email, phone, role, active, sms_enabled, timezone,
  created_at, updated_at, recipient_kind
) VALUES (
  'pilot-admin', 'org-1', 'Pilot Admin Test', 'pilot-admin@example.invalid', '',
  'VIEW_ONLY', 1, 0, 'America/New_York', datetime('now'), datetime('now'), 'PILOT_ADMIN'
);

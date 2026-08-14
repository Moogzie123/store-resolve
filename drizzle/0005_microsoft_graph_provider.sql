-- Microsoft Graph is the active production mail provider. Both independent I/O gates remain off.
INSERT INTO settings(key,value,updated_at) VALUES
  ('email_ingestion_enabled','false',datetime('now')),
  ('email_ack_enabled','false',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value='false',updated_at=excluded.updated_at;

INSERT INTO settings(key,value,updated_at)
VALUES('email_lookback_days','30',datetime('now'))
ON CONFLICT(key) DO NOTHING;

-- Keep legacy Gmail settings inert for a possible future pluggable adapter.
UPDATE settings SET value='false',updated_at=datetime('now')
WHERE key IN ('gmail_ingestion_enabled','gmail_ack_enabled');

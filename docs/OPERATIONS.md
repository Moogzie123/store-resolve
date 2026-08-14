# Operations

## Controls and rollout modes

- `gmail_ingestion_enabled`: permits scheduled Gmail reads and complaint ingestion.
- `gmail_ack_enabled`: permits one neutral reply for a newly accepted complaint.
- `external_notifications_enabled`: master gate for every real SMS call.
- `notification_mode`: `MOCK`, `FAMILY_PILOT`, `SINGLE_STORE_PILOT`, or `FULL`.

`FAMILY_PILOT` permits only explicitly eligible ownership contacts. Managers remain externally suppressed. `SINGLE_STORE_PILOT` permits the configured store's assigned manager. `FULL` permits configured routed managers. `PILOT_ADMIN` is never eligible for complaint or escalation fanout.

## Scheduled operations

Every five minutes the Worker:

1. computes acknowledgment and resolution overdue state;
2. creates idempotent escalation records and notification records;
3. dispatches only records allowed by rollout and the external kill switch;
4. reconciles stale SignalWire `SENT` records without resending;
5. polls Gmail only when ingestion is enabled;
6. records the job outcome and sanitized integration failures.

With external notifications off, SLA and escalation state remain visible but no SMS provider call occurs. With Gmail acknowledgment off, ingestion cannot send email.

## Administration

Owner/admin pages support stores, routing aliases, manager assignments, user roles, active state, notification eligibility, rollout controls, Gmail controls, SLA values, and SignalWire reconciliation timing. Client bootstrap responses mask user phones and emails. Sensitive changes are server-authorized and audited.

## Troubleshooting

- Gmail `401`: refresh token revoked/expired or OAuth client changed. Replace the refresh token; do not enable ingestion until readiness returns.
- Gmail `403`: verify Gmail API is enabled and the token includes both minimum scopes.
- Gmail `429`/`5xx`: reads use bounded backoff; inspect integration events and the next job run.
- Gmail message stuck `FAILED_PERSISTENCE`: correct the underlying D1/schema issue; the same Gmail ID can be retried without creating a second complaint.
- Acknowledgment `IN_FLIGHT`: treat as ambiguous and inspect Gmail Sent before any manual retry.
- SignalWire `SENT` too long: scheduled reconciliation will query authoritative state after the configured threshold. It never resends.
- Unexpected external behavior: first disable external notifications and Gmail acknowledgment, then inspect audit records.

The owner health payload reports Gmail/SignalWire readiness, switch states, rollout mode, last background run, and recent sanitized failures.

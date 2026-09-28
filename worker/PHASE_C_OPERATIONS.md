# Phase C — Operations Build (skeleton / functional, safety-first)

Branch: `muse/phase-c-operations`. Nothing here deploys, sends, or flips a
safety default. Cron stays disabled; `wrangler.toml` untouched.

## 1. Graph incremental discovery (`worker/mail-discovery.ts`)

Delta-query sync of the inbox into the existing intake path:

- `DeltaDiscoveryClient` interface (`fetchDeltaPage`) — tests inject
  `FakeDeltaDiscoveryClient`; production uses `GraphDeltaDiscoveryClient`,
  which wraps `MicrosoftGraphProvider.listInboxDeltaPage` (new).
- `runMailboxDiscovery(db, options)`:
  1. Refuses to run unless `ingestionEnabled` (mirrors
     `email_ingestion_enabled=false` default).
  2. Reads the cursor (`deltaLink`) from `mail_discovery_cursors`
     (`provider=MICROSOFT_GRAPH, mailbox_key, scope='inbox-delta'` — existing
     table, no migration).
  3. Pages the delta feed (bounded, default 10 pages). Tombstoned messages
     (`@removed`) are skipped. Each message is normalized, persisted via
     `persistDiscovered` (INSERT OR IGNORE on the existing unique key — a
     re-delivered page can never duplicate), and fed to `ingestEmailMessage`
     when newly discovered.
  4. Persists the fresh `deltaLink` + high-water `received_at` on completion;
     records `last_error_code` on failure.
- Identity/triage/provisional-intake rules are untouched — discovery only
  *discovers*; `ingestEmailMessage` decides everything downstream.
- Manual admin trigger: `POST /api/admin/email/discover` (owner/admin only,
  itself gated on `email_ingestion_enabled`). No cron, no schedule.

## 2. Family review queue

API (`worker/index.ts`):
- `GET /api/review-queue` — OPEN `mail_review_items` joined to
  `mail_source_messages` + `mail_processing_runs` (subject, sender, reason,
  disagreement flags, model/confidence).
- `GET /api/review-queue/:id` — full detail incl. interpretation JSON,
  normalized output, deterministic evidence.
- `POST /api/review-queue/:id/resolve` — `{action: 'dismiss'|'link',
  complaintId?, note?}`. **Identity rule:** `link` requires an *existing*
  complaint id (verified); it never creates a complaint or identity.
  Dismissal just closes the item. Writes `resolution_json`, `reviewed_by`,
  `resolved_at` (existing columns).
- `POST /api/review-queue/:id/assign` — sets `reviewed_by` on an OPEN item.

UI (`src/ReviewQueue.tsx`, new "Review queue" nav under Operations):
- Table of open items (subject, sender, reason, disagreement flags,
  received) + detail panel (message metadata, model extraction labeled
  review-only, deterministic evidence JSON).
- Resolve (link/dismiss + note) and assign controls render for OWNER/ADMIN
  only in this phase. Nothing in the queue sends anything.

## 3. Notification abstraction (`worker/notifications.ts`)

- Event types: `complaint.received`, `complaint.critical_escalation`,
  `complaint.sla_breach`.
- `NotificationTransport` interface; only `LogNotificationTransport` ships
  (logs, records a receipt, sends nothing).
- Config-driven routing: `settings.external_notifications_enabled`
  (default `'false'`) + `settings.notification_targets_json`
  (`[{channel, address, label}]`). Recipients/channels are unknown until the
  family provides them.
- `NotificationService.notify` is a no-op returning `[]` when disabled —
  verified by test that no transport is touched.
- Wired hook: `ingestEmailMessage` emits `complaint.critical_escalation`
  when a CRITICAL complaint is created. Inert by default; notification
  failures can never break ingestion (try/catch).

## 4. Ack/response workflow (`worker/response-workflow.ts`)

- `response_templates` table (new, `drizzle/0007_phase_c_operations.sql` —
  **not applied to any D1**; schema also registered in `worker/schema.ts`).
- Lifecycle on existing `response_actions`: `DRAFT -> PENDING_APPROVAL ->
  APPROVED`, with `REJECTED` as the alternate terminal state. Drafts render
  from a template (`{{var}}` substitution; unknown vars left visible) or
  from a supplied body. Drafts are human-authored, never model-generated.
- `sendResponseAction` **always throws in Phase C**: `SEND_DISABLED` when
  `email_ack_enabled=false` (the default), `SEND_NOT_WIRED` when on (no
  transport exists yet). No external send is possible from this module.
- API: `GET/POST /api/response-templates`, `POST
  /api/complaints/:id/response-drafts`, `POST
  /api/response-actions/:id/approve`, `POST /api/response-actions/:id/send`
  (returns 403 `SEND_DISABLED`).

## What Phase C does NOT do

- No production deployment, no prod D1 writes, no cron, no safety-flag
  changes.
- No live Graph calls except through the explicit admin trigger (which
  itself requires the ingestion flag).
- No live model calls: $0.00 API spend in this phase.
- No fabricated IDs; model output never identity evidence; non-complaint
  mail never reaches any model (unchanged from Phase B).

## Policy questions for Manav

1. **Notification channels/recipients:** who gets `critical_escalation`
   alerts, and how (SMS? email?)? Until you answer, the targets list stays
   empty and everything is log-only.
2. **SLA definitions:** what are the ack/resolution targets per severity,
   and what counts as a breach worth notifying? (The `sla_breach` event
   type exists; no breach detector is wired yet.)
3. **Review permissions:** should store managers resolve/assign review
   items for their own stores, or stay OWNER/ADMIN-only?
4. **Response approval:** who approves customer-facing drafts — you, or a
   designated family member per store? (Determines the `approvedBy`
   workflow.)
5. **Discovery trigger:** manual admin button is the Phase C trigger. Do
   you want a scheduled poll later (cron), or keep it manual through the
   pilot?

# StoreResolve architecture

## Runtime and data flow

StoreResolve is a single Cloudflare Worker deployment. It contains:

- a React/TypeScript client built by Vite and served through the Worker Assets binding;
- a Hono API with Zod request validation;
- Cloudflare Access identity mapped to active D1 users;
- D1 as the authoritative store for complaints, messages, lifecycle events, notification attempts, callbacks, reconciliation, jobs, and settings;
- a SignalWire Compatibility API adapter for SMS;
- an isolated Gmail API adapter using server-held OAuth refresh credentials;
- a five-minute Cloudflare Cron Trigger for Gmail polling, SLA evaluation, and stale-SMS reconciliation.

Production flow:

```text
Gmail poll
  -> GmailProvider retrieves message/MIME metadata
  -> durable gmail_message claim by Gmail message ID
  -> deterministic extraction (no LLM)
  -> exact store-number or normalized alias routing
  -> complaint create, follow-up attach, ignore, or ROUTING_REVIEW
  -> optional one-time Gmail acknowledgment (independent kill switch)
  -> independent ownership and assigned-manager notification records
  -> server-side rollout and external-send eligibility
  -> manager acknowledgment/investigation/contact/resolution
  -> owner review/close/reopen
  -> scheduled SLA escalation
  -> reporting and immutable audit history
```

## Idempotency and failure boundaries

`gmail_messages.gmail_message_id` is the ingestion idempotency key. Gmail thread ID and the extracted source complaint reference associate follow-ups with an existing complaint. Mailbox unread state is not used as application state. Failed processing remains diagnosable and can be retried without creating a second complaint.

Acknowledgments have a unique complaint and idempotency key. A send moves `PENDING -> IN_FLIGHT` before calling Gmail. `SENT` is terminal. An ambiguous interrupted send remains non-retryable without operator review, preventing automatic duplicate replies.

Each SMS recipient receives a separate notification record. SignalWire acceptance means `SENT`, never `DELIVERED`. The callback-supplied identifier is only a lookup key: the Worker retrieves the authoritative SignalWire record and verifies project, sender, and stored recipient before mutation. Callback and reconciliation transitions use separate audit tables and terminal states cannot regress.

## Authorization

- `OWNER` and `ADMIN` can mutate configuration and all complaints.
- `VIEW_ONLY` can read but cannot mutate.
- `STORE_MANAGER` sees and mutates only complaints assigned to that manager.
- `PILOT_ADMIN` is a notification test capability, not complaint authority, and is excluded from all complaint fanout and escalation.
- `DEV_AUTH_USER_ID` is local-only and must not exist in production.

Cloudflare Access protects all normal application/API routes. Only the exact `/api/signalwire/status` callback path is exempted, and that route performs its own authoritative provider verification.

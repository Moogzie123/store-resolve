# StoreResolve architecture

## Runtime and data flow

StoreResolve is a single Cloudflare Worker deployment. It contains:

- a React/TypeScript client built by Vite and served through the Worker Assets binding;
- a Hono API with Zod request validation;
- Cloudflare Access identity mapped to active D1 users;
- D1 as the authoritative store for complaints, messages, lifecycle events, notification attempts, callbacks, reconciliation, jobs, and settings;
- a SignalWire Compatibility API adapter for SMS;
- an isolated Microsoft Graph delegated-mail adapter using a server-held OAuth refresh token;
- a dormant Gmail adapter retained only for future provider pluggability;
- a five-minute Cloudflare Cron Trigger for email polling, SLA evaluation, and stale-SMS reconciliation.

Production flow:

```text
Microsoft Graph Inbox poll
  -> MicrosoftGraphProvider retrieves immutable message and conversation metadata
  -> durable message claim by Microsoft Graph message ID
  -> deterministic extraction (no LLM)
  -> exact store-number or normalized alias routing
  -> complaint create, follow-up attach, ignore, or ROUTING_REVIEW
  -> optional one-time Microsoft Graph reply (independent kill switch)
  -> independent ownership and assigned-manager notification records
  -> server-side rollout and external-send eligibility
  -> manager acknowledgment/investigation/contact/resolution
  -> owner review/close/reopen
  -> scheduled SLA escalation
  -> reporting and immutable audit history
```

## Idempotency and failure boundaries

The durable provider-message ID is the ingestion idempotency key. Microsoft Graph conversation ID and the extracted source complaint reference associate follow-ups with an existing complaint. Mailbox unread state is not used as application state. Failed processing remains diagnosable and can be retried without creating a second complaint. Legacy Gmail-named columns remain an internal compatibility detail until a later nonessential schema cleanup.

Acknowledgments have a unique complaint and idempotency key. A send moves `PENDING -> IN_FLIGHT` before calling Microsoft Graph. `SENT` is terminal. An ambiguous interrupted send remains non-retryable without operator review, preventing automatic duplicate replies.

Each SMS recipient receives a separate notification record. SignalWire acceptance means `SENT`, never `DELIVERED`. The callback-supplied identifier is only a lookup key: the Worker retrieves the authoritative SignalWire record and verifies project, sender, and stored recipient before mutation. Callback and reconciliation transitions use separate audit tables and terminal states cannot regress.

## Authorization

- `OWNER` and `ADMIN` can mutate configuration and all complaints.
- `VIEW_ONLY` can read but cannot mutate.
- `STORE_MANAGER` sees and mutates only complaints assigned to that manager.
- `PILOT_ADMIN` is a notification test capability, not complaint authority, and is excluded from all complaint fanout and escalation.
- `DEV_AUTH_USER_ID` is local-only and must not exist in production.

Cloudflare Access protects all normal application/API routes. Only the exact `/api/signalwire/status` callback path is exempted, and that route performs its own authoritative provider verification.

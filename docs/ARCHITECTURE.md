# Architecture

## Shape

- React + TypeScript + Vite responsive web client.
- Framework-independent domain workflow in `src/lib/workflow.ts`.
- Hono Cloudflare Worker boundary in `worker/index.ts`.
- Drizzle schema and D1 SQL migration in `worker/schema.ts` and `drizzle/0001_initial.sql`.
- Notification and email provider interfaces in `worker/providers.ts`.

The simulator calls the same `createComplaint` service intended for Gmail ingestion. Business logic does not import Gmail or Twilio. Every transition creates a chronological event. Each notification recipient receives a separate record.

## Security model

The domain service enforces owner-only close/reopen actions, manager assignment for operational actions, and view-only restrictions. A production deployment must place an identity-aware authentication layer in front of the Worker and derive the active user from verified session claims; the demo's user selector is explicitly a local role simulator, not production authentication.

External delivery has layered backend gates: global switch, rollout mode, recipient SMS setting, recipient role, and pilot store. MOCK mode and the default global switch prevent network delivery.

## State and deadlines

Workflow status and overdue flags are independent. Deadline processing checks durable flags before emitting events and alerts, making repeated cron runs idempotent. Production Cron should invoke the deadline processor against D1 in a transaction.

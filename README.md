# StoreResolve

Production complaint operations for a multi-location Dunkin franchise group. React is served by an authenticated Hono Worker; Cloudflare D1 is authoritative for Gmail ingestion, complaint lifecycle, routing, audits, notifications, callbacks, escalation, administration, and reporting.

## Local development

```bash
pnpm install
pnpm build
pnpm db:migrate:local
pnpm dev
```

`pnpm dev` uses the explicitly local-only `DEV_AUTH_USER_ID=father` binding. Production never exposes the role simulator; identity comes from Cloudflare Access.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:worker
pnpm test:e2e
```

The Playwright suite exercises the Worker+D1 path, refresh persistence, separate authenticated sessions, authorization, and the test-message confirmation guard. No live SMS is sent by tests. Default production state is `FAMILY_PILOT` with external notifications disabled.

Production SMS uses the server-side SignalWire adapter. Gmail uses an isolated OAuth provider with deterministic ingestion and exactly-once acknowledgment state. A five-minute Cron Trigger runs ingestion (when enabled), SLA escalation, and stale SignalWire reconciliation. All external-I/O switches default off.

Operator documentation:

- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Pilot runbook](docs/PILOT_RUNBOOK.md)

No real customer information, phone numbers, email addresses, or credentials belong in this repository.

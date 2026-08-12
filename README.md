# StoreResolve

Persistent complaint operations for a seven-location Dunkin franchise group. The React client now uses an authenticated Hono Worker API; Cloudflare D1 is the authoritative store for complaints, events, notifications, contacts, and rollout controls.

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

No real customer information, phone numbers, email addresses, or credentials belong in this repository.

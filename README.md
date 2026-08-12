# StoreResolve

Complaint operations for a seven-location Dunkin franchise group. The current build demonstrates the complete local workflow while keeping every outbound notification safely disabled.

## Quick start

```bash
pnpm install
pnpm dev
```

Use the user selector in the header to move between owner, view-only, and store-manager experiences. Create cases through **Simulator**. Default mode is `MOCK`; `external_notifications_enabled` is false.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

The browser demo uses in-memory state by design. The production persistence target is the checked-in D1 migration and Worker boundary. See [Architecture](docs/ARCHITECTURE.md), [Deployment](docs/DEPLOYMENT.md), and [Next steps](docs/NEXT_STEPS.md).

No real customer information, phone numbers, email addresses, or credentials belong in this repository.

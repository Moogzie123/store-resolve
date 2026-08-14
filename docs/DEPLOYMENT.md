# Deployment

## Verification and deployment

Use Node/pnpm versions supported by the checked-in lockfile. Wrangler 4.x is required.

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm build:worker
pnpm db:migrate:remote
pnpm deploy
```

`wrangler.toml` binds the production `store-resolve` D1 database, serves `dist`, enables Worker observability, and registers `*/5 * * * *` in UTC. Migration `0004_v1_operations.sql` is additive and preserves existing complaints, users, contacts, notification history, and SignalWire callback data.

Before and after deployment, verify:

```bash
npx wrangler whoami
npx wrangler d1 migrations list store-resolve --remote
npx wrangler secret list
npx wrangler versions list
```

Do not pass secret values as command arguments. Enter them only at Wrangler's interactive prompt.

## Cloudflare Access

1. Protect `store-resolve.moogzie.workers.dev` with the existing self-hosted Access application.
2. Allow only configured operator identities.
3. Keep normal UI and `/api/*` routes protected.
4. Bypass only the exact path `/api/signalwire/status` for provider callbacks.
5. Remove any obsolete `/api/twilio/status` bypass. There is no active Twilio route in the Worker.
6. Never set `DEV_AUTH_USER_ID` in production.

## Safe production defaults

The D1 settings remain authoritative after deploy:

- `notification_mode=FAMILY_PILOT`
- `external_notifications_enabled=false`
- `gmail_ingestion_enabled=false`
- `gmail_ack_enabled=false`

Deploying code, migrations, or Cron Triggers does not send an email or SMS while these switches are off.

## Rollback

Application rollback:

```bash
npx wrangler versions list
npx wrangler rollback <VERSION_ID>
```

D1 migrations are additive and should not be reversed by dropping tables or columns. If a deployment must be rolled back, roll back the Worker first and leave the additive schema in place. Use D1 Time Travel from the Cloudflare dashboard only for an actual data-loss incident and only with explicit approval.

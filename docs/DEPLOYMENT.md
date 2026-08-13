# Cloudflare deployment

## One-time provisioning

```bash
pnpm install
npx wrangler login
npx wrangler d1 create store-resolve
```

Copy the returned `database_id` into `wrangler.toml`, replacing `replace-after-d1-create`, then run:

```bash
pnpm db:migrate:remote
pnpm deploy
```

The deployment command builds the React assets and deploys the Worker with its D1 binding. Confirm health at `https://<worker-host>/api/health`.

## Local D1

```bash
pnpm build
pnpm db:migrate:local
pnpm dev
```

Local D1 data lives under ignored `.wrangler/` state and survives Worker restarts. Delete that local state only when intentionally resetting development data.

## Cloudflare Access

1. In Cloudflare Zero Trust, add a self-hosted Access application for the deployed Worker hostname.
2. Add an allow policy containing only the pilot users' verified email addresses.
3. In D1, replace each placeholder ownership email with the exact verified Access email through the secured admin page.
4. Do not configure `DEV_AUTH_USER_ID` in production.
5. Verify unauthenticated `/api/bootstrap` access is blocked by Access and by the Worker.
6. Add a narrow Access bypass policy only for `/api/signalwire/status`; that route independently verifies each message through SignalWire's authenticated API before updating D1. Do not bypass Access for any other `/api` path.
7. After the SignalWire callback is verified end-to-end, remove the legacy `/api/twilio/status` Access bypass if it exists.

## Safe deployment state

Migration `0002_persistence_and_auth.sql` sets `notification_mode=FAMILY_PILOT` and `external_notifications_enabled=false`. Deploying and setting provider secrets never sends a message. Gmail and Google Pub/Sub remain unconfigured.

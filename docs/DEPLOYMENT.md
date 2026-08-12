# Deployment

1. Create a Cloudflare D1 database: `wrangler d1 create store-resolve`.
2. Replace the placeholder D1 ID in `wrangler.toml`.
3. Apply `wrangler d1 migrations apply store-resolve --remote`.
4. Build with `pnpm build` and configure static assets for the Worker.
5. Keep `NOTIFICATION_MODE=MOCK` and `EXTERNAL_NOTIFICATIONS_ENABLED=false` for the initial deployment.
6. Configure authentication before exposing complaint routes.
7. Deploy with `wrangler deploy`.

Secrets must be added with `wrangler secret put`; never store them in `.dev.vars`, commits, CI logs, or documentation. Required for the later SMS milestone: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.

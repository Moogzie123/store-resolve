# Architecture

## Runtime

- React + TypeScript + Vite client, served as Worker static assets.
- Hono Worker API with Zod request validation.
- Cloudflare D1 as the authoritative application database.
- Framework-independent transition functions in `src/lib/workflow.ts` reused by simulator/API ingestion.
- D1 hydration/persistence adapter in `worker/d1.ts`.
- Cloudflare Access identity adapter in `worker/auth.ts`.
- Twilio adapter and signature verification in `worker/providers.ts`.

The browser loads `/api/bootstrap` and sends every mutation to the Worker. Refreshing or opening another browser rehydrates from D1. Events and per-recipient notification records use stable IDs and `INSERT OR IGNORE`; deadline flags prevent repeated escalation effects.

## Authentication and authorization

Cloudflare Access is the session boundary. After Access validates the user, the Worker maps `Cf-Access-Authenticated-User-Email` to an active D1 user. Access must protect the Worker hostname so clients cannot supply this header directly. The complaint domain remains independent of authentication.

Owners may view all stores and perform administrative mutations. View-only users receive all-store read access but fail owner mutations. Managers receive only complaints assigned to their user ID and cannot mutate other stores. `DEV_AUTH_USER_ID` exists solely for local Wrangler development and must never be set in production.

## Notification safety

Eligibility is checked server-side immediately before provider invocation. The D1 kill switch overrides severity and mode. In `FAMILY_PILOT`, only `father`, `uncle`, and `grandfather` are valid external recipients; manager records remain auditable as `SUPPRESSED / FAMILY_PILOT`. Twilio acceptance produces `SENT`, not `DELIVERED`. Signed, idempotent callbacks set final status.

# Integrations

## SignalWire

StoreResolve uses SignalWire's Compatibility API with HTTP Basic authentication. Enter every value interactively; never put production values in source, shell history, command arguments, or logs:

```bash
npx wrangler secret put SIGNALWIRE_PROJECT_ID
npx wrangler secret put SIGNALWIRE_API_TOKEN
npx wrangler secret put SIGNALWIRE_SPACE_URL
npx wrangler secret put SIGNALWIRE_PHONE_NUMBER
npx wrangler secret put PUBLIC_BASE_URL
```

`SIGNALWIRE_SPACE_URL` is the assigned `*.signalwire.com` host, with or without `https://`. `SIGNALWIRE_PHONE_NUMBER` must be an E.164 sender owned by the project. `PUBLIC_BASE_URL` is the deployed HTTPS origin without a path or trailing slash. Readiness remains `NOT READY` unless all five values pass structural validation.

The send request uses SignalWire's Compatibility REST API Create Message endpoint with an `application/x-www-form-urlencoded` body containing `To`, `From`, `Body`, and `StatusCallback=<PUBLIC_BASE_URL>/api/signalwire/status`. The provider never submits `status_callback_url`. StoreResolve does not trust callback delivery state directly. Before D1 mutation, the Worker retrieves the authoritative Compatibility API Message with its API credentials and compares project ID, message ID, sender, and the notification's stored recipient. The callback is idempotent and maps `queued`, `sending`, and `sent` to `SENT`; `delivered`, `failed`, and `undelivered` are terminal states.

Bootstrap performs a read-only authenticated Compatibility API message-list query. Provider readiness therefore verifies credentials, Messaging scope, JSON response shape, and API reachability without creating a message.

The owner-only reconciliation endpoint is available solely to recover a missed webhook for an existing `PILOT_ADMIN` notification. It refuses to run unless `FAMILY_PILOT` is active and external notifications are disabled, retrieves the authoritative provider message, verifies project/from/to identity, and updates only a terminal notification state. It does not create a `notification_callbacks` row because no webhook was received.

Compatibility Retrieve is attempted first. For a legacy message created by SignalWire's native Relay API, which may not be addressable through Compatibility Retrieve, StoreResolve falls back to the authenticated native message-log record. The native response does not repeat the project ID, so project identity is derived from the successful Basic-authenticated request scoped to the configured project. Both paths return the same normalized identity and are subject to the same project, sender, and stored-recipient checks before any mutation.

Cloudflare Access must bypass exactly `/api/signalwire/status`, and no broader `/api` route. Remove any legacy `/api/twilio/status` bypass only after the new callback works end-to-end.

## Controlled first SMS

1. Deploy and verify `FAMILY_PILOT` while external notifications remain disabled.
2. Configure exactly one of Father, Uncle, or Grandfather through the secured admin page with an E.164 phone, Active, and SMS enabled.
3. Add the five SignalWire secrets interactively and verify the page shows SignalWire `READY` and only a masked destination.
4. Confirm manager external notifications remain suppressed and no send-to-all target exists.
5. Obtain explicit approval for exactly one recipient and one harmless test.
6. Temporarily enable external notifications, select that recipient, check the explicit confirmation, and send once.
7. Record the provider message ID and initial `SENT` state, then wait for `DELIVERED`, `FAILED`, or `UNDELIVERED` through the authenticated callback.
8. Turn external notifications off immediately and verify no manager notification was sent.

The exact test body is:

```text
STORERESOLVE TEST
StoreResolve complaint alerts are connected to this phone.
No action is required.
```

The UI rate-limits each recipient to one test per five minutes. It has no manager or send-to-all target.

## Rotation and emergency shutdown

Rotate an API token in SignalWire, then replace only `SIGNALWIRE_API_TOKEN` with `wrangler secret put` and verify readiness before revoking the old token. If delivery behavior is unexpected, turn external notifications off in Pilot controls first; that D1 kill switch prevents all provider calls regardless of severity. Provider errors are redacted and phone/email values remain masked in client responses.

## Gmail

`ComplaintEmailProvider` remains an interface only. No Gmail inbox, push notification, Pub/Sub subscription, or real acknowledgment is connected in this milestone.

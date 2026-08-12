# Integrations

## Notifications

`NotificationProvider` isolates domain events from delivery. `MockNotificationProvider` is safe for local work. `TwilioSmsProvider` intentionally fails closed until credentials and its network adapter are explicitly enabled. A production webhook must validate Twilio signatures and update each notification independently.

## Gmail

`ComplaintEmailProvider` defines receive, thread retrieval, acknowledgment, and final reply operations. No inbox is connected. A future Gmail API + Pub/Sub adapter will translate an email into `NewComplaint`, call the existing workflow, and send the versioned acknowledgment in the original thread.

## Configuration

- `NOTIFICATION_MODE`: `MOCK`, `FAMILY_PILOT`, `SINGLE_STORE_PILOT`, or `FULL`.
- `EXTERNAL_NOTIFICATIONS_ENABLED`: defaults to `false` and overrides every provider.
- Twilio values: Cloudflare secrets only.
- Google OAuth/service-account values: secret store only; never source control.

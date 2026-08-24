# Integrations

## SignalWire SMS

Required Worker secrets:

```bash
npx wrangler secret put SIGNALWIRE_PROJECT_ID
npx wrangler secret put SIGNALWIRE_API_TOKEN
npx wrangler secret put SIGNALWIRE_SPACE_URL
npx wrangler secret put SIGNALWIRE_PHONE_NUMBER
npx wrangler secret put PUBLIC_BASE_URL
```

The Compatibility Create Message request is form encoded with `To`, `From`, `Body`, and `StatusCallback=<PUBLIC_BASE_URL>/api/signalwire/status`. StoreResolve never trusts callback status fields directly. It retrieves the provider record server-side and verifies project/from/to identity before updating D1.

## Microsoft Graph mail

Microsoft Graph is the only active production mail provider. Its one-time bootstrap uses Microsoft Device Code Flow with the `consumers` authority; production access continues through the stored delegated refresh token. Credentials and mailbox identity exist only in Worker secrets:

```bash
npx wrangler secret put MS_CLIENT_ID
npx wrangler secret put MS_REFRESH_TOKEN
npx wrangler secret put MS_MAILBOX_ADDRESS
npx wrangler secret put MS_TENANT
```

Required delegated scopes:

```text
offline_access
Mail.Read
Mail.Send
```

The production authority is `consumers`. StoreResolve requests immutable Outlook message IDs, polls only the Inbox in a bounded lookback window, retrieves message/conversation/Internet IDs, sender and recipients, timestamps, headers, and body metadata, and never uses read/unread state as application state. Replies use `POST /me/messages/{id}/reply`, which preserves the original message context. Read operations have bounded retry; a send is never automatically retried.

Email ingestion and acknowledgment have separate D1 switches. Both default off. Runtime readiness refreshes the delegated access token and reads only Inbox folder metadata (`id`, display name, and item counts); it never enumerates messages, reads message bodies, creates ingestion rows, or sends a reply.

The controlled production pilot uses a fixed, Inbox-only metadata selector containing an approved sender, subject prefix, and UTC time window. It requests at most two metadata rows to prove uniqueness, reads one message body only when exactly one metadata result matches, and atomically consumes the explicitly reset one-shot lock before that body request.

## Microsoft personal-account OAuth setup gate

In Microsoft Entra admin center:

1. Open **Identity -> Applications -> App registrations -> New registration**.
2. Name it `StoreResolve Production Mail`.
3. For **Supported account types**, select **Personal Microsoft accounts only** (`PersonalMicrosoftAccount`).
4. Register the app, then open **Authentication**.
5. Under **Advanced settings**, set **Allow public client flows** to **Yes**. Device Code Flow does not use a redirect URI or local callback server.
6. Open **API permissions -> Add a permission -> Microsoft Graph -> Delegated permissions**. Add only `Mail.Read` and `Mail.Send`; `offline_access` is requested by the OAuth flow.
7. Run `pnpm oauth:microsoft`, enter the existing Application client ID if prompted, then visit the displayed Microsoft device-login URL and enter its short code. The helper polls Microsoft server-side and writes the refresh token directly to Cloudflare through Wrangler without displaying it.

No client secret is required for this public-client device flow. Refresh/access tokens and the mailbox address must never be pasted into chat, committed, or logged. The dormant Gmail adapter has no production binding or readiness path.

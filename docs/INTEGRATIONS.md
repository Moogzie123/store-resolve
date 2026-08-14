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

Microsoft Graph is the only active production mail provider. It uses delegated authorization-code OAuth with PKCE and refresh-token support for a personal Microsoft account. Credentials and mailbox identity exist only in Worker secrets:

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

Email ingestion and acknowledgment have separate D1 switches. Both default off. Provider readiness is configuration-only and never reads mail or sends a reply.

## Microsoft personal-account OAuth setup gate

In Microsoft Entra admin center:

1. Open **Identity -> Applications -> App registrations -> New registration**.
2. Name it `StoreResolve Production Mail`.
3. For **Supported account types**, select **Personal Microsoft accounts only** (`PersonalMicrosoftAccount`).
4. Register the app, then open **Authentication -> Add a platform -> Mobile and desktop applications**.
5. Select the native redirect URI `http://localhost` and enable public client flows.
6. Open **API permissions -> Add a permission -> Microsoft Graph -> Delegated permissions**. Add only `Mail.Read` and `Mail.Send`; `offline_access` is requested by the OAuth flow.
7. In the repository terminal, set `MS_CLIENT_ID` only for that process and run `pnpm oauth:microsoft`. Sign in to the MSN mailbox and consent. The helper uses PKCE and writes the refresh token directly to Cloudflare through Wrangler without displaying it.

No client secret is required for this public-client PKCE flow. Refresh/access tokens and the mailbox address must never be pasted into chat, committed, or logged. The dormant Gmail adapter has no production binding or readiness path.

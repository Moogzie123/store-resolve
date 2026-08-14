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

The callback is the fast path. The scheduled fallback checks `SENT` records older than `signalwire_reconcile_after_minutes`, performs the same authoritative identity verification, never sends a message, never regresses a terminal state, and records transitions in `signalwire_reconciliations` rather than `notification_callbacks`.

## Gmail

StoreResolve uses direct Gmail REST calls through `GmailProvider`. OAuth credentials and mailbox identity exist only in Worker secrets:

```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GMAIL_MAILBOX_ADDRESS
```

Minimum scopes:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

`gmail.modify` is not required: StoreResolve does not depend on unread state, labels, or mailbox mutation. Polling is intentionally used instead of Pub/Sub for this low-volume mailbox. The high-water behavior is durable Gmail message-ID idempotency plus a bounded search query (default `newer_than:30d`).

The provider supports:

- OAuth refresh-token exchange;
- bounded retries for rate limits and temporary failures on read operations;
- full message and thread metadata;
- recursive text/plain extraction with sanitized HTML fallback;
- Message-ID, In-Reply-To, and References headers;
- replies in the original Gmail thread;
- no automatic retry of an ambiguous send.

Gmail ingestion and acknowledgment have separate D1 switches. Both default off. Provider readiness alone never reads mail or sends a reply.

## Gmail OAuth setup gate

In Google Cloud Console:

1. Select or create the StoreResolve production project.
2. Open **APIs & Services -> Library** and enable **Gmail API**.
3. Open **Google Auth Platform -> Branding/Audience/Data Access** and configure the consent screen.
4. Add only `gmail.readonly` and `gmail.send` under Data Access.
5. Open **Clients -> Create client -> Web application**.
6. For a one-mailbox operator-assisted authorization, use Google's OAuth 2.0 Playground redirect URI exactly: `https://developers.google.com/oauthplayground`.
7. In OAuth Playground settings, select **Use your own OAuth credentials**, request the two scopes, authorize the complaint mailbox, exchange the code, and copy the refresh token directly into the interactive Wrangler secret prompt.

The client ID is not a password but should still be configured through Wrangler. Client secret, refresh token, access token, and mailbox address must never be pasted into chat, committed, or logged.

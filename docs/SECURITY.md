# Security

- Cloudflare Access is the interactive authentication boundary.
- The Worker maps the verified Access email to an active D1 user and rechecks authorization server-side for every mutation.
- Only `/api/signalwire/status` may bypass Access. The handler retrieves and verifies the authoritative provider record.
- Gmail and SignalWire credentials are Worker secrets, never browser variables or D1 settings.
- Gmail uses only `gmail.readonly` and `gmail.send`.
- `DEV_AUTH_USER_ID` is local-only.
- User contact values are masked in normal client responses.
- Audit metadata uses identifiers and sanitized codes; credentials and unnecessary message/customer content are not logged.
- External SMS, Gmail ingestion, and Gmail replies each have server-enforced kill switches.
- Provider reads have bounded retry/backoff. Externally visible sends are not automatically retried after an ambiguous result.

Before every release run a tracked-source secret/PII scan and inspect the staged diff. Never add `.env`, `.dev.vars`, OAuth JSON, PEM files, tokens, mailbox addresses, or real customer data.

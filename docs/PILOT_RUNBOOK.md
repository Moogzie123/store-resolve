# Production pilot runbook

Every external-I/O step requires fresh approval. Stop immediately if observed identity, routing, or recipient data differs from the expected masked value.

## 1. Authorize Microsoft Graph delegated mail

1. Complete the OAuth setup in `INTEGRATIONS.md` with `offline_access`, `Mail.Read`, and `Mail.Send`.
2. Store the Microsoft client ID, refresh token, mailbox address, and `consumers` authority through Wrangler.
3. Keep Microsoft Graph ingestion and acknowledgment off.
4. Deploy and confirm Microsoft Graph reports configuration `READY` without enabling ingestion.

## 2. Ingest one real complaint without communication

1. Confirm `FAMILY_PILOT`, external SMS off, email acknowledgment off.
2. Obtain explicit approval to access one real complaint email.
3. Set the Inbox lookback to the narrowest approved period.
4. Enable Microsoft Graph ingestion for one polling cycle, then turn it off.
5. Verify one durable message row, one complaint or documented routing-review result, exact Graph message/conversation IDs, store routing evidence, and no acknowledgment/notification provider calls.

## 3. Approve one neutral acknowledgment

1. Review the complaint/thread and neutral template.
2. Obtain explicit approval for exactly one reply.
3. Enable Microsoft Graph acknowledgment and ingestion for the controlled complaint.
4. Verify `PENDING -> IN_FLIGHT -> SENT`, provider message ID, original thread ID, and one audit event.
5. Turn email acknowledgment off. Do not retry an ambiguous result without inspecting Outlook Sent Items.

## 4. Pilot ownership SMS

1. Configure exactly one ownership contact securely and confirm the masked destination.
2. Keep `FAMILY_PILOT`; verify managers suppressed and Pilot Admin excluded.
3. Obtain explicit approval, enable external notifications briefly, allow one complaint notification, then turn the switch off.
4. Verify SignalWire and D1 terminal state plus callback or reconciliation audit.

## 5. Pilot one store manager

1. Select `SINGLE_STORE_PILOT` and exactly one store.
2. Verify the Access identity, assigned store, masked SMS destination, and manager permissions.
3. Obtain explicit approval before the first manager SMS.
4. Exercise acknowledgment, investigation, customer contact, resolution, and owner close.

## 6. Expand

Add remaining stores/managers individually, verify aliases and Access identities, then move to `FULL` only after the pilot's routing, SLA, callback, and audit results are accepted. Keep all kill switches available throughout expansion.

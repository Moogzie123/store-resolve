# Production pilot runbook

Every external-I/O step requires fresh approval. Stop immediately if observed identity, routing, or recipient data differs from the expected masked value.

## 1. Connect Gmail read-only capability

1. Complete the OAuth setup in `INTEGRATIONS.md` with `gmail.readonly` and `gmail.send`.
2. Store all four Gmail values with interactive `wrangler secret put` commands.
3. Keep Gmail ingestion and acknowledgment off.
4. Deploy and confirm Gmail reports `READY` using the read-only profile diagnostic.

## 2. Ingest one real complaint without communication

1. Confirm `FAMILY_PILOT`, external SMS off, Gmail acknowledgment off.
2. Obtain explicit approval to access one real complaint email.
3. Narrow `gmail_search_query` to the approved message/reference.
4. Enable Gmail ingestion for one polling cycle, then turn it off.
5. Verify one `gmail_messages` row, one complaint or documented routing-review result, exact Gmail IDs, store routing evidence, and no acknowledgment/notification provider calls.

## 3. Approve one neutral acknowledgment

1. Review the complaint/thread and neutral template.
2. Obtain explicit approval for exactly one reply.
3. Enable Gmail acknowledgment and ingestion for the controlled complaint.
4. Verify `PENDING -> IN_FLIGHT -> SENT`, provider message ID, original thread ID, and one audit event.
5. Turn Gmail acknowledgment off. Do not retry an ambiguous result without inspecting Gmail Sent.

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

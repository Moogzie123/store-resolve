# Phase B — GPT-4o-mini Structured Interpretation (shadow / review-only)

Status: **design + implementation, interpreter disabled by default, no live model calls.**
The interpretation stage runs between deterministic normalization (Stage 3) and
deterministic reconciliation (Stage 4) of `ingestEmailMessage`. It produces records
and review signals only. It can never create/update complaints, merge records, invent
store mappings, send messages, or change routing on its own.

## 1. Pipeline placement

```
Stage 1  immutable source persistence      (mail_source_messages)
Stage 2  processing lease                 (mail_processing_runs)
Stage 3  deterministic normalization      (extractComplaint — regex/rules only)
Stage 3b ★ structured interpretation      (this doc — model, shadow-only)
Stage 4  deterministic reconciliation     (resolveComplaintIdentity + review signals)
Stage 5  canonical event commit           (canonical_mail_events [+ review item])
```

Rationale: the model receives the deterministic extraction as grounding input, so its
output can be *checked against* deterministic evidence (disagreement detection).
Reconciliation remains the single decision point, and it never trusts the model for
identity (see §7).

**Cost/privacy gate (architectural):** deterministic triage runs first on every
message. Only messages `extractComplaint` flags as complaint candidates
(`isComplaint: true`) may reach Stage 3b — non-complaint mail returns `IGNORED`
before the interpreter is constructed, and `interpretWithConfig` independently
refuses any input with `normalized.isComplaint === false` (no prompt built, no
model touched, no tokens spent, no text exposed). Two layers, same invariant.

## 2. Configuration

Read from the `settings` table (key/value), overridable per-call via
`ingestEmailMessage` options (used by tests):

| setting key                        | default           | meaning                                    |
| ---------------------------------- | ----------------- | ------------------------------------------ |
| `mail_interpretation_enabled`      | `'false'`         | master switch — **OFF unless explicitly set** |
| `mail_interpretation_model`        | `'gpt-4o-mini'`   | model id passed to the transport           |
| `mail_interpretation_prompt_version` | `'mail-interpret.v1'` | immutable prompt version (see §6)      |

`shadowMode` is hard-coded `true` in Phase B: there is no code path that lets the
interpreter write complaints or send anything, regardless of settings.

## 3. Input schema (`MailInterpretationInput`)

```ts
{
  schemaVersion: 'mail-interpret.input.v1',
  promptVersion: 'mail-interpret.v1',
  normalized: {
    subject: string,
    senderAddress: string,
    receivedAt: string,            // ISO
    conversationId?: string,
    isComplaint: boolean,          // deterministic verdict
    externalCaseId?: string,       // deterministic extraction, or absent
    storeNumber?: string,          // deterministic extraction, or absent
    locationHint?: string,
    customerName?: string, customerEmail?: string, customerPhone?: string,
    occurrenceAt?: string,
    category: 'Cleanliness' | 'Service' | 'Product quality' | 'Other',
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  },
  deterministicEvidence: {
    extractionRules: string[],     // which deterministic branches fired, e.g. 'CASE_ID_REGEX_LINE_ANCHORED'
    storeResolution: {
      storeNumber?: string,        // DB-verified store, or absent
      reason: 'EXACT_STORE_NUMBER' | 'EXACT_ALIAS' | 'NO_DETERMINISTIC_STORE_MATCH',
    },
  },
  sourceMetadata: {
    provider: 'MICROSOFT_GRAPH',
    mailboxKey: string,
    bodyExcerpt: string,           // first 4000 chars of text body — bounded on purpose
    internetMessageId?: string,
  },
}
```

Deliberately minimal: no full raw body, no attachments, no recipient lists beyond what
normalization already extracted. The excerpt is what the model actually reads; it is
persisted only as a SHA-256 (`model_input_sha256`), never the text itself.

## 4. Output schema (`MailInterpretationOutput`, strict)

```ts
{
  schemaVersion: 'mail-interpret.output.v1',
  externalCaseId: string | null,   // a REAL id quoted from the text, or null — never invented
  storeNumber: string | null,      // digits as written in the text, or null — never mapped
  storeConfidence: number | null,  // 0..1, null when storeNumber is null
  issueCategory: 'Cleanliness' | 'Service' | 'Product quality' | 'Other',
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  confidence: number,              // 0..1 overall
  summary: string,                 // <= 500 chars
  evidenceQuotes: string[],        // verbatim short quotes (<= 280 chars each), or []
}
```

Validation (`validateInterpretationOutput`) enforces: exact schema version, enum
membership, confidence ranges, string length bounds, `storeConfidence` null-iff
`storeNumber` null, and **every evidence quote must appear verbatim** (normalized
whitespace) in the source excerpt — a quote the model hallucinated is
`EVIDENCE_CONTRADICTION`, not evidence. A schema violation yields `output: null`
plus `SCHEMA_VIOLATION`; it never yields a partial object downstream.

## 5. Disagreement taxonomy

Computed by `detectDisagreements(input, output)` — pure function, no I/O.
Every code below is written to `mail_processing_runs.disagreement_flags_json` and,
on the review path, to the review item's `disagreement_flags_json`.

| code | meaning | default handling (shadow) |
| ---- | ------- | ------------------------- |
| `CASE_ID_MISMATCH` | model id ≠ deterministic id (both present) | record; reconciliation keeps the deterministic id |
| `CASE_ID_UNVERIFIED` | model suggests an id; deterministic found none | **identity rule**: still provisional review, `external_case_id` NULL; suggestion attached as an *unverified hint* for the human |
| `CASE_ID_MISSED` | deterministic found an id; model returned null | record (model recall signal) |
| `STORE_MISMATCH` | model store ≠ deterministic DB-verified store | record; deterministic store wins |
| `STORE_UNVERIFIED` | model suggests a store with no DB match | record; **never** invents a mapping — store stays unresolved |
| `STORE_MISSED` | deterministic resolved a store; model returned null | record |
| `CATEGORY_MISMATCH` | model category ≠ deterministic category | record |
| `SEVERITY_MISMATCH` | model urgency ≠ deterministic severity | record; if model is *higher*, also flag `SEVERITY_ESCALATION_CANDIDATE` for the reviewer — no auto-escalation in shadow |
| `LOW_CONFIDENCE` | model confidence < 0.6 | record |
| `ABSTAINED` | model returned null / transport failed | record; pipeline continues deterministically |
| `EVIDENCE_CONTRADICTION` | a quote isn't in the source text | record; quote discarded |
| `SCHEMA_VIOLATION` | output failed validation | record; output treated as null |

Threshold `0.6` is `INTERPRETATION_LOW_CONFIDENCE_THRESHOLD` (exported; a future
settings key if we need it runtime-tunable).

## 6. Prompt versioning

- Format: `mail-interpret.v<N>`. Prompts live in `INTERPRETATION_PROMPTS`, an
  immutable `Record<version, promptText>`.
- Prompts are append-only: fixing a prompt means adding `mail-interpret.v2`, never
  editing v1. Every run records its prompt version, so results are reproducible.
- Unknown version → `MailInterpretationError('UNKNOWN_PROMPT_VERSION')`; the
  pipeline continues deterministically (interpreter abstains), it never silently
  falls back to another prompt.
- The v1 system prompt's core directives: *extract, don't infer; quote verbatim;
  return null rather than guess; never invent case IDs, store numbers, names, or
  dates; a guessed identifier is worse than a null.*

## 7. Identity rule (non-negotiable) — enforcement points

Manav's rule: *no trustworthy external case ID → reviewable/provisional intake →
human/other evidence resolves identity.* The model is never "other evidence" on its own.

1. The prompt instructs null-over-guess for `externalCaseId`.
2. `CASE_ID_UNVERIFIED` can only produce a *hint* (`reviewSignals.suggestedCaseId`),
   never an identity. Type-level: the hint lives on `IdentityReviewSignals`, not on
   the `ComplaintIdentityResult` arms that carry `complaintId`.
3. `resolveComplaintIdentity` ignores model suggestions when choosing
   `EXACT_CASE_ID` / `CONVERSATION_HINT` / `NEW_CASE_ID` / `NO_IDENTITY` — the
   deterministic inputs alone decide the basis.
4. Provisional intake still writes `external_case_id = NULL` on the canonical event.
5. No synthetic IDs anywhere: the interpreter has no code path that generates an
   identifier (no UUID/counter/prefix logic for business IDs).

## 8. Shadow-mode guarantees (structural, not just flags)

- The only shipped `ModelTransport` is `DisabledModelTransport`, whose `complete()`
  unconditionally throws `MODEL_TRANSPORT_DISABLED`. There is **no `fetch` call** in
  the interpreter module and no API key plumbing.
- `worker/mail-interpretation.ts` imports nothing that can write complaints, send
  mail/SMS, or touch rollout policy (no `workflow`, no providers, no notifications).
  The interpreter receives data in and returns a result object; all persistence
  happens in `ingestion.ts` via explicit, auditable statements.
- When `mail_interpretation_enabled` is not `'true'`, Stage 3b is skipped entirely:
  no prompt built, no run-row columns touched, zero behavior change vs. today.
- **Non-complaint mail never reaches the model** (see §1): deterministic triage
  gates Stage 3b at the call site (`extraction.isComplaint`) and
  `interpretWithConfig` refuses non-candidates independently. This is both the
  cost control (no tokens for non-complaint mail) and the privacy boundary
  (non-complaint text is never sent to a model).
- On interpreter throw/abstain, the pipeline continues deterministically and the
  run records `ABSTAINED` — a model failure can never fail an intake.

## 9. Persistence mapping (existing columns — no migration)

`mail_processing_runs` row for the run (UPDATE after interpretation):

| column | value |
| ------ | ----- |
| `model_name` | config model (e.g. `gpt-4o-mini`) |
| `prompt_version` | config prompt version |
| `schema_version` | `mail-interpret.output.v1` (or input version on abstain) |
| `normalized_output_json` | deterministic extraction snapshot |
| `deterministic_evidence_json` | extraction rules + store resolution |
| `ai_structured_output_json` | validated model output (null on abstain/violation) |
| `model_input_sha256` / `model_output_sha256` | hashes of prompt input / raw model text |
| `validation_result_json` | `{ valid, errors[] }` |
| `disagreement_flags_json` | disagreement codes |
| `latency_ms` | measured around the interpret call |

The review item (`mail_review_items.disagreement_flags_json`) and the canonical
event payload (`modelSuggestedCaseId`, labeled unverified) carry the human-facing
signals.

## 10. Policy options for Manav

**Option A — review enrichment only (recommended default).** Disagreements are
recorded and surfaced on review items; routing and reconciliation logic are
byte-for-byte unchanged. Pure signal collection: we learn how often the model
disagrees and in which direction before it influences anything.

**Option B — severity-escalation candidates.** When the model rates urgency higher
than the deterministic severity *and* identity resolved normally, still create the
complaint but add `SEVERITY_ESCALATION_CANDIDATE` and open a review item for a
human to confirm the severity bump. Trade-off: catches under-triaged urgent mail
earlier; costs reviewer attention and the model will be wrong sometimes.

**Option C — store tiebreak on DB match.** When deterministic store resolution
fails (`NO_DETERMINISTIC_STORE_MATCH`) but the model suggests a store number with
confidence ≥ 0.8 **and** that number exactly matches an active store in `stores`,
routing may use it (recorded as `MODEL_STORE_TIEBREAK`). A non-matching suggestion
still routes to review. Trade-off: fewer `UNROUTED` complaints; small risk the model
reads the wrong digits — mitigated by the exact-DB-match requirement, which means
it can never invent a mapping.

Options B and C are **not implemented** — they need your pick first, and C needs a
pilot-scope decision (it changes routing). A is what's built.

## 11. What Phase B does NOT do

- No live OpenAI calls (transport stubbed; paid spend needs explicit approval).
- No unattended ingestion, no acknowledgments, no external sends.
- No automatic complaint creation/merge from model output.
- No `MSGRAPH-*` or any other fabricated business IDs.
- No changes to cron (still dead), safety-switch defaults, or existing reconciliation semantics.

## 12. Live eval harness (gated)

`tests/interpretation-eval-live.test.ts` — skipped in the normal suite; runs only with
`STORE_RESOLVE_LIVE_EVAL=1` (or `=dry` for a no-API dry run):

```
STORE_RESOLVE_LIVE_EVAL=1 pnpm vitest run tests/interpretation-eval-live.test.ts
```

- Uses the REAL pipeline code (`extractComplaint`, `buildInterpretationInput`,
  `OpenAiMailInterpreter.buildRequest`, `processRawInterpretation`) against 7
  synthetic sample emails — no PII, no production data, never touches prod D1.
- Calls gpt-4o-mini via `~/workspace/skills/openai/bin/openai_api.py` (Manav's
  connected credential; the harness never sees raw keys).
- Enforces the non-candidate gate in the harness too: the newsletter sample must
  never reach the model (asserted).
- Reports per email: deterministic vs. model extraction, confidence, disagreement
  codes, input/output tokens — plus a batch summary with full-agreement rate,
  disagreement counts by code, batch cost, and cumulative spend.
- **Hard budget cap: $2.00 cumulative.** Spend is tracked in
  `~/workspace/store-resolve-ops/interpretation-eval-spend.json`; the harness
  refuses to run when the next batch would exceed the cap.
- Status 2026-09-28: harness built and dry-run validated; live runs blocked —
  the OpenAI account reports `insufficient_quota` (no credits). Add credits at
  platform.openai.com → billing, then run the live batch.

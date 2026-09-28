/**
 * LIVE interpretation eval harness (gated — never runs in the normal suite).
 *
 * Run:  STORE_RESOLVE_LIVE_EVAL=1 pnpm vitest run tests/interpretation-eval-live.test.ts
 * Dry:  STORE_RESOLVE_LIVE_EVAL=dry pnpm vitest run tests/interpretation-eval-live.test.ts
 *         (builds inputs + requests, validates the pipeline, makes no API calls)
 *
 * What it does: runs the REAL deterministic normalization (extractComplaint) and
 * the REAL interpretation contract (buildInterpretationInput / processRawInterpretation)
 * against synthetic sample emails, calling gpt-4o-mini through Manav's connected
 * OpenAI credential via ~/workspace/skills/openai/bin/openai_api.py.
 *
 * Safety: shadow-only. Model output is validated and disagreement-checked; it never
 * creates/updates complaints, never serves as identity, never sends anything, and
 * never touches production D1. Non-complaint mail never reaches the model (the
 * architectural gate is enforced here too).
 *
 * Budget: hard cap of $2.00 cumulative across runs (Manav's cap). The harness
 * tracks spend in ~/workspace/store-resolve-ops/interpretation-eval-spend.json and
 * REFUSES to run when the next batch would exceed the cap.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEmailMessage } from '../worker/email-provider'
import { extractComplaint } from '../worker/ingestion'
import {
  DisabledModelTransport,
  OpenAiMailInterpreter,
  buildInterpretationInput,
  processRawInterpretation,
  type MailInterpretationConfig,
  type MailInterpretationInput,
} from '../worker/mail-interpretation'

const LIVE = process.env.STORE_RESOLVE_LIVE_EVAL === '1'
const DRY = process.env.STORE_RESOLVE_LIVE_EVAL === 'dry'
const RUN = LIVE || DRY

const OPENAI_CLI = join(homedir(), 'workspace/skills/openai/bin/openai_api.py')
const SPEND_STATE_PATH = join(homedir(), 'workspace/store-resolve-ops/interpretation-eval-spend.json')
const BUDGET_CAP_USD = 2.0
const INPUT_USD_PER_1M = 0.15
const OUTPUT_USD_PER_1M = 0.6
// Generous over-estimate per email for pre-flight cap checks (real cost is ~$0.0004).
const ESTIMATE_USD_PER_EMAIL = 0.002

const EVAL_CONFIG: MailInterpretationConfig = {
  enabled: true,
  model: 'gpt-4o-mini',
  promptVersion: 'mail-interpret.v1',
  shadowMode: true,
}

interface SampleEmail {
  id: string
  note: string
  subject: string
  textBody: string
}

// Synthetic samples only — no PII, no production data.
const SAMPLES: SampleEmail[] = [
  {
    id: 'eval-clean-case',
    note: 'clean case ID + store, service complaint',
    subject: 'Complaint reference DD-1001',
    textBody:
      'Complaint Reference ID: DD-1001\nStore Number: 41001\nCustomer Name: Jane Doe\nComplaint: slow service at the drive thru, waited 20 minutes.',
  },
  {
    id: 'eval-no-identity',
    note: 'no case ID, no store — model should abstain on identity fields',
    subject: 'Guest concern at an unknown store',
    textBody: 'Customer complaint with no location and no reference number. The coffee was cold.',
  },
  {
    id: 'eval-safety',
    note: 'safety issue — expect HIGH/CRITICAL urgency',
    subject: 'Foreign object in drink',
    textBody:
      'Case: DD-2024\nGuest found a piece of plastic in their iced coffee. Store Number: 41002. No injury reported but guest is upset.',
  },
  {
    id: 'eval-dd-suffix-store',
    note: 'store via DD suffix token',
    subject: 'Rude staff complaint',
    textBody: 'Reference # DD-3344\nThe cashier at 41003-DD was rude to my family this morning.',
  },
  {
    id: 'eval-dbi-format',
    note: 'DBI case format + cleanliness category',
    subject: 'Bathroom complaint',
    textBody: 'DBI Case # (XYZ789)\nThe bathroom at the location was dirty and unsanitary. Store Number: 41004.',
  },
  {
    id: 'eval-vague',
    note: 'vague complaint, low information — expect low confidence',
    subject: 'Order was wrong',
    textBody: 'My order was wrong yesterday. Not happy.',
  },
  {
    id: 'eval-non-complaint',
    note: 'NON-CANDIDATE: newsletter — must never reach the model',
    subject: 'Weekly newsletter',
    textBody: 'Here is our weekly newsletter with store updates and promotions.',
  },
]

interface SpendState {
  cumulative_usd: number
  runs: { at: string; emails: number; input_tokens: number; output_tokens: number; usd: number }[]
}

function loadSpendState(): SpendState {
  try {
    return JSON.parse(readFileSync(SPEND_STATE_PATH, 'utf8')) as SpendState
  } catch {
    return { cumulative_usd: 0, runs: [] }
  }
}

function saveSpendState(state: SpendState): void {
  mkdirSync(join(homedir(), 'workspace/store-resolve-ops'), { recursive: true })
  writeFileSync(SPEND_STATE_PATH, JSON.stringify(state, null, 2))
}

function toMessage(sample: SampleEmail): NormalizedEmailMessage {
  return {
    id: sample.id,
    threadId: `${sample.id}-thread`,
    internalDate: '2026-09-28T12:00:00.000Z',
    sender: 'Dunkin Guest Care <guestcare@example.invalid>',
    recipients: 'operations@example.invalid',
    subject: sample.subject,
    messageIdHeader: `<${sample.id}@example.invalid>`,
    textBody: sample.textBody,
  }
}

interface EvalResult {
  id: string
  note: string
  deterministic: { caseId?: string; store?: string; category: string; severity: string }
  modelCalled: boolean
  output?: Record<string, unknown> | null
  confidence?: number | null
  disagreements: string[]
  inputTokens: number
  outputTokens: number
}

function callModel(requestBody: Record<string, unknown>): { content: string | null; inputTokens: number; outputTokens: number } {
  const raw = execFileSync(
    OPENAI_CLI,
    ['request', '--method', 'POST', '--path', '/v1/chat/completions', '--data', JSON.stringify(requestBody)],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 },
  )
  const response = JSON.parse(raw) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  return {
    content: response.choices?.[0]?.message?.content ?? null,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  }
}

describe.skipIf(!RUN)('live interpretation eval (gated)', () => {
  it('runs the batch, enforcing the $2 budget cap', async () => {
    const spend = loadSpendState()
    const candidates = SAMPLES // triage happens per-sample below
    if (LIVE) {
      const projected = spend.cumulative_usd + candidates.length * ESTIMATE_USD_PER_EMAIL
      console.log(`\nSpend so far: $${spend.cumulative_usd.toFixed(4)} / $${BUDGET_CAP_USD.toFixed(2)} cap`)
      expect(
        projected <= BUDGET_CAP_USD,
        `BUDGET CAP: projected $${projected.toFixed(4)} exceeds $${BUDGET_CAP_USD.toFixed(2)} — refusing to run`,
      ).toBe(true)
    }

    const interpreter = new OpenAiMailInterpreter(EVAL_CONFIG, new DisabledModelTransport())
    const results: EvalResult[] = []
    let batchInputTokens = 0
    let batchOutputTokens = 0

    for (const sample of SAMPLES) {
      const msg = toMessage(sample)
      const extraction = extractComplaint(msg)
      // Architectural gate, enforced in the harness too: non-candidates never reach the model.
      if (!extraction.isComplaint) {
        results.push({
          id: sample.id,
          note: sample.note,
          deterministic: { category: extraction.category, severity: extraction.severity },
          modelCalled: false,
          disagreements: [],
          inputTokens: 0,
          outputTokens: 0,
        })
        continue
      }
      const input: MailInterpretationInput = buildInterpretationInput(
        msg,
        extraction,
        { reason: 'NO_DETERMINISTIC_STORE_MATCH' },
        EVAL_CONFIG,
        'eval',
      )
      const request = interpreter.buildRequest(input)
      let content: string | null = null
      let inputTokens = 0
      let outputTokens = 0
      if (LIVE) {
        const call = callModel(request as unknown as Record<string, unknown>)
        content = call.content
        inputTokens = call.inputTokens
        outputTokens = call.outputTokens
        batchInputTokens += inputTokens
        batchOutputTokens += outputTokens
      }
      const started = Date.now()
      const result = await processRawInterpretation(
        input,
        { rawText: content, latencyMs: Date.now() - started },
        EVAL_CONFIG,
      )
      results.push({
        id: sample.id,
        note: sample.note,
        deterministic: {
          caseId: extraction.externalCaseId,
          store: extraction.storeNumber,
          category: extraction.category,
          severity: extraction.severity,
        },
        modelCalled: LIVE,
        output: result.output as unknown as Record<string, unknown> | null,
        confidence: result.confidence,
        disagreements: result.disagreements.map((d) => d.code),
        inputTokens,
        outputTokens,
      })
    }

    // --- Report ---
    console.log('\n=== Interpretation eval report ===')
    for (const r of results) {
      console.log(`\n[${r.id}] ${r.note}`)
      console.log(`  deterministic: case=${r.deterministic.caseId ?? '—'} store=${r.deterministic.store ?? '—'} cat=${r.deterministic.category} sev=${r.deterministic.severity}`)
      if (!r.modelCalled) {
        console.log('  model: NOT CALLED (non-candidate gate)')
        continue
      }
      const o = r.output
      console.log(
        `  model: case=${o?.externalCaseId ?? 'null'} store=${o?.storeNumber ?? 'null'} cat=${o?.issueCategory} urgency=${o?.urgency} conf=${r.confidence}`,
      )
      console.log(`  disagreements: ${r.disagreements.length ? r.disagreements.join(', ') : 'none'}`)
      console.log(`  tokens: ${r.inputTokens} in / ${r.outputTokens} out`)
    }

    const batchUsd = (batchInputTokens * INPUT_USD_PER_1M + batchOutputTokens * OUTPUT_USD_PER_1M) / 1_000_000
    const disagreementCounts: Record<string, number> = {}
    let agreed = 0
    let evaluated = 0
    for (const r of results) {
      if (!r.modelCalled || !r.output) continue
      evaluated += 1
      if (r.disagreements.length === 0) agreed += 1
      for (const code of r.disagreements) disagreementCounts[code] = (disagreementCounts[code] ?? 0) + 1
    }
    console.log('\n--- Batch summary ---')
    console.log(`  emails evaluated: ${evaluated} (model called), ${results.length - evaluated} skipped by gate`)
    console.log(`  full agreement rate: ${evaluated ? `${agreed}/${evaluated} (${((agreed / evaluated) * 100).toFixed(0)}%)` : 'n/a'}`)
    console.log(`  disagreement counts: ${JSON.stringify(disagreementCounts)}`)
    console.log(`  batch tokens: ${batchInputTokens} in / ${batchOutputTokens} out`)
    console.log(`  batch cost: $${batchUsd.toFixed(4)}`)
    if (LIVE) {
      spend.cumulative_usd += batchUsd
      spend.runs.push({
        at: new Date().toISOString(),
        emails: evaluated,
        input_tokens: batchInputTokens,
        output_tokens: batchOutputTokens,
        usd: batchUsd,
      })
      saveSpendState(spend)
      console.log(`  cumulative spend: $${spend.cumulative_usd.toFixed(4)} / $${BUDGET_CAP_USD.toFixed(2)} cap`)
      expect(spend.cumulative_usd).toBeLessThanOrEqual(BUDGET_CAP_USD)
    } else {
      console.log('  DRY RUN — no API calls, no spend')
    }

    // The gate itself is the assertion that matters most here.
    const nonComplaint = results.find((r) => r.id === 'eval-non-complaint')
    expect(nonComplaint?.modelCalled).toBe(false)
  }, 300000)
})

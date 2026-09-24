import type { NormalizedEmailMessage } from './email-provider'
import { extractComplaint } from './ingestion'
import { maskGraphIdentifier } from './microsoft-graph'

export type PilotBodyClassification = 'DUPLICATE' | 'FOLLOW_UP' | 'DISTINCT'

interface DiagnosticCandidate {
  messageId: string
  receivedDateTime: string
  caseId?: string
  storeId?: string
  category: string
  customerFingerprint: string
  complaintTextFingerprint: string
}

export interface PilotBodyDiagnosticReport {
  scope: 'TWO_APPROVED_MESSAGES_BODY_DIAGNOSTIC'
  candidateA: DiagnosticCandidate
  candidateB: DiagnosticCandidate
  structuredFieldsMatch: boolean
  complaintTextFingerprintsMatch: boolean
  internetMessageIdsMatch: boolean
  classification: PilotBodyClassification
  canonicalMessageId: string
  duplicateMessageId?: string
}

const compact = (value?: string) => value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? ''
const normalizedStore = (value?: string) => value?.replace(/\D/g, '')
const first = (value: string, pattern: RegExp) => value.match(pattern)?.[1]?.trim()

const hmac = async (key: CryptoKey, value: string) => {
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return Array.from(new Uint8Array(signature))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const diagnosticFields = async (message: NormalizedEmailMessage, key: CryptoKey) => {
  if (
    /\b(?:complaint|details?)\s+(?:is|are)\s+(?:only\s+)?(?:in|on)\s+(?:the\s+)?attachment\b|\bsee\s+(?:the\s+)?attached\s+complaint\b/i.test(
      message.textBody,
    )
  )
    throw new Error('PILOT_DIAGNOSTIC_ATTACHMENT_REQUIRED')
  const extraction = extractComplaint(message)
  const contactReceivedAt = first(
    message.textBody,
    /\b(?:contact|complaint)\s+received(?:\s+(?:date|time|at))?\s*:\s*([^\n]{4,80})/i,
  )
  const customerIdentity = [
    extraction.customerName,
    extraction.customerEmail,
    extraction.customerPhone,
  ]
    .map(compact)
    .join('|')
  const normalizedComplaintText = compact(extraction.details)
  return {
    extraction,
    contactReceivedAt: compact(contactReceivedAt),
    location: compact(extraction.locationHint),
    customerFingerprint: await hmac(key, customerIdentity),
    complaintTextFingerprint: await hmac(key, normalizedComplaintText),
  }
}

export async function buildPilotBodyDiagnosticReport(
  messages: [NormalizedEmailMessage, NormalizedEmailMessage],
): Promise<PilotBodyDiagnosticReport> {
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const [a, b] = await Promise.all(messages.map((message) => diagnosticFields(message, key)))
  const normalizedA = {
    caseId: compact(a.extraction.externalCaseId),
    storeId: normalizedStore(a.extraction.storeNumber),
    category: compact(a.extraction.category),
    severity: a.extraction.severity,
    occurrenceAt: compact(a.extraction.occurrenceAt),
    contactReceivedAt: a.contactReceivedAt,
    location: a.location,
    customerFingerprint: a.customerFingerprint,
  }
  const normalizedB = {
    caseId: compact(b.extraction.externalCaseId),
    storeId: normalizedStore(b.extraction.storeNumber),
    category: compact(b.extraction.category),
    severity: b.extraction.severity,
    occurrenceAt: compact(b.extraction.occurrenceAt),
    contactReceivedAt: b.contactReceivedAt,
    location: b.location,
    customerFingerprint: b.customerFingerprint,
  }
  const structuredFieldsMatch = JSON.stringify(normalizedA) === JSON.stringify(normalizedB)
  const complaintTextFingerprintsMatch = a.complaintTextFingerprint === b.complaintTextFingerprint
  const sameCase = Boolean(normalizedA.caseId) && normalizedA.caseId === normalizedB.caseId
  const classification: PilotBodyClassification = !sameCase
    ? 'DISTINCT'
    : structuredFieldsMatch && complaintTextFingerprintsMatch
      ? 'DUPLICATE'
      : 'FOLLOW_UP'
  const ordered = [...messages].sort(
    (left, right) => Date.parse(left.internalDate) - Date.parse(right.internalDate),
  )
  const candidate = (
    message: NormalizedEmailMessage,
    fields: Awaited<ReturnType<typeof diagnosticFields>>,
  ): DiagnosticCandidate => ({
    messageId: maskGraphIdentifier(message.id),
    receivedDateTime: message.internalDate,
    caseId: fields.extraction.externalCaseId,
    storeId: normalizedStore(fields.extraction.storeNumber),
    category: fields.extraction.category,
    customerFingerprint: fields.customerFingerprint,
    complaintTextFingerprint: fields.complaintTextFingerprint,
  })
  return {
    scope: 'TWO_APPROVED_MESSAGES_BODY_DIAGNOSTIC',
    candidateA: candidate(messages[0], a),
    candidateB: candidate(messages[1], b),
    structuredFieldsMatch,
    complaintTextFingerprintsMatch,
    internetMessageIdsMatch:
      Boolean(messages[0].messageIdHeader) &&
      messages[0].messageIdHeader === messages[1].messageIdHeader,
    classification,
    canonicalMessageId: maskGraphIdentifier(ordered[0].id),
    duplicateMessageId:
      classification === 'DUPLICATE' ? maskGraphIdentifier(ordered[1].id) : undefined,
  }
}

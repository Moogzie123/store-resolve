import {
  maskGraphIdentifier,
  type PilotUniquenessMetadata,
  type PilotUniquenessMetadataResult,
} from './microsoft-graph'

export interface ResolvedPilotUniquenessMetadata extends PilotUniquenessMetadata {
  folderName: string
}

export interface RedactedPilotCandidate {
  messageId: string
  conversationId: string
  receivedDateTime: string
  parentFolderName: string
  subjectStructure: string
  subjectFingerprint: string
}

export interface PilotUniquenessReport {
  scope: 'AUGUST_1_METADATA_ONLY'
  totalRecordsExamined: number
  hasMore: boolean
  senderMatchCount: number
  caseIdMatchCount: number
  caseAndPhraseMatchCount: number
  allCriteriaMatchCount: number
  classification:
    | 'NO_MATCH'
    | 'UNIQUE_CANONICAL'
    | 'CANONICAL_WITH_COPIES'
    | 'DUPLICATED_ACROSS_FOLDERS'
    | 'SAME_CONVERSATION_MESSAGES'
    | 'DISTINCT_CONVERSATIONS'
    | 'AMBIGUOUS_METADATA'
    | 'INCOMPLETE_LIMIT_REACHED'
  canonicalMessageId?: string
  matchingCandidates: RedactedPilotCandidate[]
}

const fullMatch = (record: PilotUniquenessMetadata) =>
  record.senderMatched &&
  record.caseIdMatched &&
  record.subjectPhraseMatched &&
  record.storeNumberMatched

const subjectKind = (subject: string) => {
  if (/^\s*re\s*:/i.test(subject)) return 'REPLY'
  if (/^\s*(fw|fwd)\s*:/i.test(subject)) return 'FORWARD'
  return 'ORIGINAL'
}

const isOutboundFolder = (folderName: string) =>
  /^(sent items|sent|drafts|outbox)$/i.test(folderName.trim())

const fingerprint = async (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function buildPilotUniquenessReport(
  result: PilotUniquenessMetadataResult,
  matchingWithFolders: ResolvedPilotUniquenessMetadata[],
): Promise<PilotUniquenessReport> {
  const matches = result.records.filter(fullMatch)
  if (matchingWithFolders.length !== matches.length)
    throw new Error('Every matching candidate must have resolved folder metadata')

  const matchingCandidates = await Promise.all(
    matchingWithFolders.map(async (record) => ({
      messageId: maskGraphIdentifier(record.id),
      conversationId: maskGraphIdentifier(record.conversationId),
      receivedDateTime: record.receivedDateTime,
      parentFolderName: record.folderName,
      subjectStructure: `${subjectKind(record.subject)} · CASE(CCC11122413) · PHRASE(Slow Service) · STORE(350909)`,
      subjectFingerprint: await fingerprint(record.subject),
    })),
  )

  let classification: PilotUniquenessReport['classification'] = 'NO_MATCH'
  let canonicalMessageId: string | undefined
  if (result.hasMore) classification = 'INCOMPLETE_LIMIT_REACHED'
  else if (matches.length === 1) {
    classification = 'UNIQUE_CANONICAL'
    canonicalMessageId = maskGraphIdentifier(matches[0].id)
  } else if (matches.length > 1) {
    const originals = matchingWithFolders.filter(
      (record) =>
        subjectKind(record.subject) === 'ORIGINAL' && !isOutboundFolder(record.folderName),
    )
    const conversationIds = new Set(matches.map((record) => record.conversationId))
    const duplicateKeys = new Set(
      matchingWithFolders.map(
        (record) =>
          `${record.conversationId}\u0000${record.receivedDateTime}\u0000${record.subject}`,
      ),
    )
    if (originals.length === 1) {
      classification = 'CANONICAL_WITH_COPIES'
      canonicalMessageId = maskGraphIdentifier(originals[0].id)
    } else if (duplicateKeys.size === 1) classification = 'DUPLICATED_ACROSS_FOLDERS'
    else if (conversationIds.size === 1) classification = 'SAME_CONVERSATION_MESSAGES'
    else if (conversationIds.size > 1) classification = 'DISTINCT_CONVERSATIONS'
    else classification = 'AMBIGUOUS_METADATA'
  }

  return {
    scope: 'AUGUST_1_METADATA_ONLY',
    totalRecordsExamined: result.records.length,
    hasMore: result.hasMore,
    senderMatchCount: result.records.filter((record) => record.senderMatched).length,
    caseIdMatchCount: result.records.filter((record) => record.caseIdMatched).length,
    caseAndPhraseMatchCount: result.records.filter(
      (record) => record.caseIdMatched && record.subjectPhraseMatched,
    ).length,
    allCriteriaMatchCount: matches.length,
    classification,
    canonicalMessageId,
    matchingCandidates,
  }
}

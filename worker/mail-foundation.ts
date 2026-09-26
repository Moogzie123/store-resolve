import type { D1Database } from './d1'

export type IngestionMode = 'LIVE' | 'BACKFILL' | 'TEST'
export type MailProcessingState =
  | 'DISCOVERED'
  | 'PROCESSING'
  | 'RETRY_WAIT'
  | 'REVIEW_REQUIRED'
  | 'NON_ACTIONABLE'
  | 'COMPLETED'
  | 'FAILED_PERMANENT'

export interface DiscoveredMailSource {
  id: string
  provider: 'MICROSOFT_GRAPH' | 'GMAIL'
  mailboxKey: string
  providerMessageId: string
  internetMessageId?: string
  conversationId?: string
  parentFolderId?: string
  direction: 'INBOUND' | 'OUTBOUND' | 'UNKNOWN'
  receivedAt: string
  discoveredAt: string
  subject: string
  senderAddress: string
  recipients: string[]
  rawContentRef?: string
  rawContentSha256?: string
  transportMetadataSha256?: string
  ingestionMode: IngestionMode
}
export interface MailProcessingVersions {
  normalizationVersion: string
  modelName?: string
  modelSnapshot?: string
  promptVersion?: string
  schemaVersion?: string
}

export interface ProcessingLease {
  sourceId: string
  runId: string
  runNumber: number
  owner: string
  expiresAt: string
}

export type ComplaintIdentityResult =
  | { complaintId: string; basis: 'EXACT_CASE_ID' | 'CONVERSATION_HINT' }
  | { complaintId?: undefined; basis: 'NEW_CASE_ID' | 'NO_IDENTITY' }

export interface CanonicalEventCommit {
  eventId: string
  sourceId: string
  processingRunId: string
  complaintId?: string
  eventVersion: string
  eventType:
    | 'NEW_CASE'
    | 'FOLLOW_UP'
    | 'CASE_UPDATE'
    | 'RESPONSE_REQUEST'
    | 'DUPLICATE_SOURCE'
    | 'NON_ACTIONABLE'
    | 'REVIEW_REQUIRED'
  externalCaseId?: string
  canonicalStoreNumber?: string
  ingestionMode: IngestionMode
  payload: Record<string, unknown>
  occurredAt?: string
  validatedAt: string
  complaintSource?: {
    id: string
    role: 'INITIAL' | 'FOLLOW_UP' | 'CASE_UPDATE' | 'DUPLICATE' | 'RESPONSE_REQUEST'
    linkageBasis: string
    materialUpdate: boolean
  }
  review?: {
    id: string
    reasonCode: string
    disagreementFlags: string[]
  }
}

export interface MailSourceRepository {
  persistDiscovered(source: DiscoveredMailSource): Promise<boolean>
  acquireProcessingLease(
    sourceId: string,
    owner: string,
    now: string,
    leaseMs: number,
    versions: MailProcessingVersions,
  ): Promise<ProcessingLease | null>
  finishProcessing(
    lease: ProcessingLease,
    state: Exclude<MailProcessingState, 'DISCOVERED' | 'PROCESSING'>,
    now: string,
    errorCode?: string,
  ): Promise<boolean>
}

export interface MailDomainRepository {
  resolveComplaintIdentity(
    externalCaseId: string | undefined,
    provider: string,
    mailboxKey: string,
    conversationId: string | undefined,
  ): Promise<ComplaintIdentityResult>
  commitCanonicalEvent(input: CanonicalEventCommit): Promise<void>
}

export class D1MailFoundationRepository implements MailSourceRepository, MailDomainRepository {
  constructor(private readonly db: D1Database) {}

  async persistDiscovered(source: DiscoveredMailSource): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO mail_source_messages(
          id,provider,mailbox_key,provider_message_id,internet_message_id,conversation_id,
          parent_folder_id,direction,received_at,discovered_at,subject,sender_address,
          recipients_json,raw_content_ref,raw_content_sha256,transport_metadata_sha256,
          ingestion_mode,processing_state,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISCOVERED',?,?)`,
      )
      .bind(
        source.id,
        source.provider,
        source.mailboxKey,
        source.providerMessageId,
        source.internetMessageId ?? null,
        source.conversationId ?? null,
        source.parentFolderId ?? null,
        source.direction,
        source.receivedAt,
        source.discoveredAt,
        source.subject,
        source.senderAddress,
        JSON.stringify(source.recipients),
        source.rawContentRef ?? null,
        source.rawContentSha256 ?? null,
        source.transportMetadataSha256 ?? null,
        source.ingestionMode,
        source.discoveredAt,
        source.discoveredAt,
      )
      .run()
    return Number(result.meta?.changes ?? 0) === 1
  }

  async acquireProcessingLease(
    sourceId: string,
    owner: string,
    now: string,
    leaseMs: number,
    versions: MailProcessingVersions,
  ): Promise<ProcessingLease | null> {
    const current = await this.db
      .prepare('SELECT attempt_count FROM mail_source_messages WHERE id=?')
      .bind(sourceId)
      .first<{ attempt_count: number }>()
    if (!current) return null
    const runNumber = Number(current.attempt_count) + 1
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
    const claimed = await this.db
      .prepare(
        `UPDATE mail_source_messages
         SET processing_state='PROCESSING',lease_owner=?,lease_expires_at=?,
             attempt_count=?,last_error_code=NULL,updated_at=?
         WHERE id=? AND attempt_count=? AND (
           processing_state IN ('DISCOVERED','RETRY_WAIT') OR
           (processing_state='PROCESSING' AND (lease_expires_at IS NULL OR lease_expires_at<=?))
         )`,
      )
      .bind(owner, expiresAt, runNumber, now, sourceId, current.attempt_count, now)
      .run()
    if (Number(claimed.meta?.changes ?? 0) !== 1) return null

    const runId = crypto.randomUUID()
    await this.db
      .prepare(
        `INSERT INTO mail_processing_runs(
          id,source_message_id,run_number,status,normalization_version,model_name,
          model_snapshot,prompt_version,schema_version,started_at,created_at,updated_at
        ) VALUES(?,?,?,'PROCESSING',?,?,?,?,?,?,?,?)`,
      )
      .bind(
        runId,
        sourceId,
        runNumber,
        versions.normalizationVersion,
        versions.modelName ?? null,
        versions.modelSnapshot ?? null,
        versions.promptVersion ?? null,
        versions.schemaVersion ?? null,
        now,
        now,
        now,
      )
      .run()
    return { sourceId, runId, runNumber, owner, expiresAt }
  }

  async finishProcessing(
    lease: ProcessingLease,
    state: Exclude<MailProcessingState, 'DISCOVERED' | 'PROCESSING'>,
    now: string,
    errorCode?: string,
  ): Promise<boolean> {
    const sourceUpdate = this.db
      .prepare(
        `UPDATE mail_source_messages SET processing_state=?,lease_owner=NULL,
         lease_expires_at=NULL,last_error_code=?,updated_at=?
         WHERE id=? AND processing_state='PROCESSING' AND lease_owner=?`,
      )
      .bind(state, errorCode ?? null, now, lease.sourceId, lease.owner)
    const runUpdate = this.db
      .prepare(
        `UPDATE mail_processing_runs SET status=?,error_code=?,completed_at=?,updated_at=?
         WHERE id=? AND status='PROCESSING'`,
      )
      .bind(state, errorCode ?? null, now, now, lease.runId)
    const results = await this.db.batch([sourceUpdate, runUpdate])
    return results.every((result) => Number(result.meta?.changes ?? 0) === 1)
  }

  async resolveComplaintIdentity(
    externalCaseId: string | undefined,
    provider: string,
    mailboxKey: string,
    conversationId: string | undefined,
  ): Promise<ComplaintIdentityResult> {
    const normalizedCaseId = externalCaseId?.trim()
    if (normalizedCaseId) {
      const exact = await this.db
        .prepare('SELECT id FROM complaints WHERE lower(external_case_id)=lower(?)')
        .bind(normalizedCaseId)
        .first<{ id: string }>()
      if (exact) return { complaintId: exact.id, basis: 'EXACT_CASE_ID' }
      // An explicit new case identity must never be overridden by a Graph conversation hint.
      return { basis: 'NEW_CASE_ID' }
    }
    if (!conversationId) return { basis: 'NO_IDENTITY' }
    const hinted = await this.db
      .prepare(
        `SELECT cs.complaint_id
         FROM mail_source_messages ms
         JOIN complaint_sources cs ON cs.source_message_id=ms.id
         WHERE ms.provider=? AND ms.mailbox_key=? AND ms.conversation_id=?
         ORDER BY cs.linked_at LIMIT 1`,
      )
      .bind(provider, mailboxKey, conversationId)
      .first<{ complaint_id: string }>()
    return hinted
      ? { complaintId: hinted.complaint_id, basis: 'CONVERSATION_HINT' }
      : { basis: 'NO_IDENTITY' }
  }

  async commitCanonicalEvent(input: CanonicalEventCommit): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO canonical_mail_events(
            id,source_message_id,processing_run_id,complaint_id,event_version,event_type,
            external_case_id,canonical_store_number,ingestion_mode,payload_json,
            occurred_at,validated_at,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          input.eventId,
          input.sourceId,
          input.processingRunId,
          input.complaintId ?? null,
          input.eventVersion,
          input.eventType,
          input.externalCaseId ?? null,
          input.canonicalStoreNumber ?? null,
          input.ingestionMode,
          JSON.stringify(input.payload),
          input.occurredAt ?? null,
          input.validatedAt,
          input.validatedAt,
        ),
    ]
    if (input.complaintSource && input.complaintId)
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO complaint_sources(
              id,complaint_id,source_message_id,canonical_mail_event_id,source_role,
              linkage_basis,material_update,linked_at
            ) VALUES(?,?,?,?,?,?,?,?)`,
          )
          .bind(
            input.complaintSource.id,
            input.complaintId,
            input.sourceId,
            input.eventId,
            input.complaintSource.role,
            input.complaintSource.linkageBasis,
            input.complaintSource.materialUpdate ? 1 : 0,
            input.validatedAt,
          ),
      )
    if (input.review)
      statements.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO mail_review_items(
              id,source_message_id,processing_run_id,canonical_mail_event_id,complaint_id,
              status,reason_code,disagreement_flags_json,created_at,updated_at
            ) VALUES(?,?,?,?,?,'OPEN',?,?,?,?)`,
          )
          .bind(
            input.review.id,
            input.sourceId,
            input.processingRunId,
            input.eventId,
            input.complaintId ?? null,
            input.review.reasonCode,
            JSON.stringify(input.review.disagreementFlags),
            input.validatedAt,
            input.validatedAt,
          ),
      )
    // Kept deliberately small: event, source link, and optional review commit atomically.
    await this.db.batch(statements)
  }
}

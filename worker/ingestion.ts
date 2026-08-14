import type { AppConfig, Complaint, Severity } from '../src/lib/types'
import { createComplaint } from '../src/lib/workflow'
import type { D1Database } from './d1'
import { loadState, persistState } from './d1'
import type { GmailProvider, NormalizedGmailMessage } from './gmail'
import { GmailProviderError } from './gmail'

export type GmailProcessingStatus =
  | 'PROCESSED'
  | 'IGNORED'
  | 'ROUTING_REVIEW'
  | 'DUPLICATE'
  | 'FOLLOW_UP'
  | 'FAILED_PARSING'
  | 'FAILED_PERSISTENCE'

export interface ComplaintExtraction {
  isComplaint: boolean
  externalCaseId?: string
  storeNumber?: string
  locationHint?: string
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  category: string
  severity: Severity
  occurrenceAt?: string
  details: string
}

const compact = (value: string) => value.replace(/\s+/g, ' ').trim()
const normalizeAlias = (value: string) =>
  compact(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
const first = (value: string, pattern: RegExp) => value.match(pattern)?.[1]?.trim()

export function extractComplaint(message: NormalizedGmailMessage): ComplaintExtraction {
  const combined = `${message.subject}\n${message.textBody}`
  const isComplaint =
    /\b(complaint|guest concern|customer concern|customer issue|case id|reference id)\b/i.test(
      combined,
    )
  const category = /clean|sanit|bathroom|dirty/i.test(combined)
    ? 'Cleanliness'
    : /staff|employee|service|rude|wait/i.test(combined)
      ? 'Service'
      : /food|drink|coffee|order|product/i.test(combined)
        ? 'Product quality'
        : 'Other'
  const severity: Severity = /injur|hospital|allerg|threat|violence|fire/i.test(combined)
    ? 'CRITICAL'
    : /health|safety|contamin|foreign object/i.test(combined)
      ? 'HIGH'
      : /refund|repeat|multiple|escalat/i.test(combined)
        ? 'MEDIUM'
        : 'LOW'
  return {
    isComplaint,
    externalCaseId:
      first(
        combined,
        /(?:^|\n)\s*(?:complaint\s+reference|case|complaint|reference|ref)\s*(?:id|number|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{2,50})/im,
      ) ?? first(combined, /\b(?:case|reference)\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{2,50})/i),
    storeNumber: first(
      combined,
      /\b(?:store|location)\s*(?:number|no\.?|#)?\s*[:#-]?\s*(\d{3,8})\b/i,
    ),
    locationHint: first(combined, /\b(?:store address|location|address)\s*:\s*([^\n]{4,160})/i),
    customerName: first(combined, /\b(?:customer|guest)\s*name\s*:\s*([^\n]{2,100})/i),
    customerEmail: first(combined, /\b(?:customer|guest)\s*email\s*:\s*([^\s<>]+@[^\s<>]+)/i),
    customerPhone: first(combined, /\b(?:customer|guest)\s*phone\s*:\s*([+()\d .-]{7,25})/i),
    occurrenceAt: first(
      combined,
      /\b(?:incident|occurrence)\s*(?:date|time)?\s*:\s*([^\n]{4,80})/i,
    ),
    category,
    severity,
    details: message.textBody.trim().slice(0, 20_000),
  }
}

async function resolveStore(
  db: D1Database,
  extraction: ComplaintExtraction,
): Promise<{ storeNumber?: string; reason: string }> {
  if (extraction.storeNumber) {
    const exact = await db
      .prepare('SELECT dunkin_store_number FROM stores WHERE dunkin_store_number=? AND active=1')
      .bind(extraction.storeNumber)
      .first<{ dunkin_store_number: string }>()
    if (exact) return { storeNumber: exact.dunkin_store_number, reason: 'EXACT_STORE_NUMBER' }
  }
  if (extraction.locationHint) {
    const alias = await db
      .prepare(
        'SELECT s.dunkin_store_number FROM store_aliases a JOIN stores s ON s.id=a.store_id WHERE a.alias_normalized=? AND s.active=1',
      )
      .bind(normalizeAlias(extraction.locationHint))
      .first<{ dunkin_store_number: string }>()
    if (alias) return { storeNumber: alias.dunkin_store_number, reason: 'EXACT_ALIAS' }
  }
  return { reason: 'NO_DETERMINISTIC_STORE_MATCH' }
}

async function recordIntegrationEvent(
  db: D1Database,
  eventType: string,
  entityId: string,
  outcome: string,
  detailCode?: string,
) {
  await db
    .prepare(
      'INSERT INTO integration_events(id,integration,event_type,entity_id,outcome,detail_code,metadata,created_at) VALUES(?,?,?,?,?,?,NULL,?)',
    )
    .bind(
      crypto.randomUUID(),
      'GMAIL',
      eventType,
      entityId,
      outcome,
      detailCode ?? null,
      new Date().toISOString(),
    )
    .run()
}

export async function ingestGmailMessage(
  db: D1Database,
  message: NormalizedGmailMessage,
): Promise<{ status: GmailProcessingStatus; complaintId?: string }> {
  const now = new Date().toISOString()
  const prior = await db
    .prepare('SELECT processing_status,complaint_id FROM gmail_messages WHERE gmail_message_id=?')
    .bind(message.id)
    .first<{ processing_status: GmailProcessingStatus; complaint_id: string | null }>()
  if (prior && !['FAILED_PARSING', 'FAILED_PERSISTENCE'].includes(prior.processing_status))
    return { status: 'DUPLICATE', complaintId: prior.complaint_id ?? undefined }
  if (!prior)
    await db
      .prepare(
        `INSERT INTO gmail_messages(gmail_message_id,gmail_thread_id,internal_date,sender,recipients,subject,message_id_header,in_reply_to,references_header,processing_status,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'PROCESSING',?,?)`,
      )
      .bind(
        message.id,
        message.threadId,
        message.internalDate,
        message.sender,
        message.recipients,
        message.subject,
        message.messageIdHeader ?? null,
        message.inReplyTo ?? null,
        message.references ?? null,
        now,
        now,
      )
      .run()
  try {
    const extraction = extractComplaint(message)
    if (!extraction.isComplaint) {
      await db
        .prepare(
          `UPDATE gmail_messages SET processing_status='IGNORED',processing_detail='NOT_COMPLAINT',processed_at=?,updated_at=? WHERE gmail_message_id=?`,
        )
        .bind(now, now, message.id)
        .run()
      await recordIntegrationEvent(db, 'MESSAGE_IGNORED', message.id, 'IGNORED', 'NOT_COMPLAINT')
      return { status: 'IGNORED' }
    }
    const threaded = await db
      .prepare(
        `SELECT complaint_id FROM gmail_messages WHERE gmail_thread_id=? AND complaint_id IS NOT NULL ORDER BY first_seen_at LIMIT 1`,
      )
      .bind(message.threadId)
      .first<{ complaint_id: string }>()
    const referenced = extraction.externalCaseId
      ? await db
          .prepare('SELECT id FROM complaints WHERE lower(external_case_id)=lower(?)')
          .bind(extraction.externalCaseId)
          .first<{ id: string }>()
      : null
    const existingId = threaded?.complaint_id ?? referenced?.id
    if (existingId) {
      const row = await db
        .prepare('SELECT follow_ups FROM complaints WHERE id=?')
        .bind(existingId)
        .first<{ follow_ups: string }>()
      const followUps = row?.follow_ups ? (JSON.parse(row.follow_ups) as unknown[]) : []
      followUps.push({
        receivedAt: message.internalDate,
        text: extraction.details,
        gmailMessageId: message.id,
      })
      await db.batch([
        db
          .prepare('UPDATE complaints SET follow_ups=?,updated_at=? WHERE id=?')
          .bind(JSON.stringify(followUps), now, existingId),
        db
          .prepare(
            `UPDATE gmail_messages SET complaint_id=?,processing_status='FOLLOW_UP',is_follow_up=1,acknowledgment_status='NOT_APPLICABLE',processed_at=?,updated_at=? WHERE gmail_message_id=?`,
          )
          .bind(existingId, now, now, message.id),
        db
          .prepare(
            `INSERT INTO complaint_events(id,complaint_id,event_type,actor,timestamp,metadata) VALUES(?,?,'FOLLOW_UP_RECEIVED','gmail',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            existingId,
            now,
            JSON.stringify({ gmailMessageId: message.id }),
          ),
      ])
      await recordIntegrationEvent(db, 'FOLLOW_UP_INGESTED', message.id, 'SUCCESS')
      return { status: 'FOLLOW_UP', complaintId: existingId }
    }
    const route = await resolveStore(db, extraction)
    const state = await loadState(db)
    const result = createComplaint(
      state,
      {
        externalCaseId: extraction.externalCaseId ?? `GMAIL-${message.id}`,
        storeNumber: route.storeNumber ?? 'UNROUTED',
        subject: message.subject,
        complaintText: extraction.details || '(No complaint body supplied)',
        category: extraction.category,
        severity: extraction.severity,
      },
      message.internalDate,
      { source: 'GMAIL', actor: 'gmail', acknowledged: false },
    )
    Object.assign(result.complaint, {
      source: 'GMAIL',
      gmailMessageId: message.id,
      gmailThreadId: message.threadId,
      sourceSender: message.sender,
      customerName: extraction.customerName,
      customerEmail: extraction.customerEmail,
      customerPhone: extraction.customerPhone,
      occurrenceAt: extraction.occurrenceAt,
      acknowledgementStatus: 'DISABLED',
      routingReason: route.reason,
    } satisfies Partial<Complaint>)
    await persistState(db, result.state)
    const status: GmailProcessingStatus = result.complaint.storeId ? 'PROCESSED' : 'ROUTING_REVIEW'
    await db
      .prepare(
        `UPDATE gmail_messages SET complaint_id=?,processing_status=?,processing_detail=?,acknowledgment_status='PENDING',processed_at=?,updated_at=? WHERE gmail_message_id=?`,
      )
      .bind(result.complaint.id, status, route.reason, now, now, message.id)
      .run()
    await recordIntegrationEvent(db, 'MESSAGE_INGESTED', message.id, 'SUCCESS', status)
    return { status, complaintId: result.complaint.id }
  } catch (error) {
    await db
      .prepare(
        `UPDATE gmail_messages SET processing_status='FAILED_PERSISTENCE',processing_detail=?,updated_at=? WHERE gmail_message_id=?`,
      )
      .bind(error instanceof Error ? error.name : 'UNKNOWN', now, message.id)
      .run()
    await recordIntegrationEvent(
      db,
      'MESSAGE_INGESTION_FAILED',
      message.id,
      'FAILED',
      'FAILED_PERSISTENCE',
    )
    throw error
  }
}

export const neutralAcknowledgment =
  'We have received this complaint and are reviewing it with the appropriate location. We will follow up as needed.'

export async function acknowledgeComplaint(
  db: D1Database,
  gmail: GmailProvider,
  complaintId: string,
  config: AppConfig,
): Promise<'DISABLED' | 'SENT' | 'ALREADY_HANDLED' | 'FAILED'> {
  if (!config.gmailAckEnabled) return 'DISABLED'
  const source = await db
    .prepare(
      `SELECT gm.*,c.acknowledgement_status FROM gmail_messages gm JOIN complaints c ON c.id=gm.complaint_id WHERE gm.complaint_id=? AND gm.is_follow_up=0 ORDER BY gm.first_seen_at LIMIT 1`,
    )
    .bind(complaintId)
    .first<Record<string, unknown>>()
  if (!source) return 'FAILED'
  const idempotencyKey = `gmail-ack:${complaintId}`
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT OR IGNORE INTO email_acknowledgments(id,complaint_id,gmail_thread_id,source_gmail_message_id,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,'PENDING',?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      complaintId,
      source.gmail_thread_id,
      source.gmail_message_id,
      idempotencyKey,
      now,
      now,
    )
    .run()
  const acknowledgment = await db
    .prepare('SELECT id,status FROM email_acknowledgments WHERE complaint_id=?')
    .bind(complaintId)
    .first<{ id: string; status: string }>()
  if (!acknowledgment || acknowledgment.status !== 'PENDING') return 'ALREADY_HANDLED'
  await db
    .prepare(
      `UPDATE email_acknowledgments SET status='IN_FLIGHT',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='PENDING'`,
    )
    .bind(now, acknowledgment.id)
    .run()
  const message: NormalizedGmailMessage = {
    id: String(source.gmail_message_id),
    threadId: String(source.gmail_thread_id),
    internalDate: String(source.internal_date),
    sender: String(source.sender),
    recipients: String(source.recipients),
    subject: String(source.subject),
    messageIdHeader: source.message_id_header ? String(source.message_id_header) : undefined,
    inReplyTo: source.in_reply_to ? String(source.in_reply_to) : undefined,
    references: source.references_header ? String(source.references_header) : undefined,
    textBody: '',
  }
  try {
    const providerMessageId = await gmail.sendAcknowledgment(message, neutralAcknowledgment)
    const sentAt = new Date().toISOString()
    await db.batch([
      db
        .prepare(
          `UPDATE email_acknowledgments SET status='SENT',provider_message_id=?,sent_at=?,updated_at=? WHERE id=? AND status='IN_FLIGHT'`,
        )
        .bind(providerMessageId, sentAt, sentAt, acknowledgment.id),
      db
        .prepare(
          `UPDATE complaints SET dunkin_acknowledged_at=?,acknowledgement_status='SENT',acknowledgment_body=?,updated_at=? WHERE id=?`,
        )
        .bind(sentAt, neutralAcknowledgment, sentAt, complaintId),
      db
        .prepare(
          `UPDATE gmail_messages SET acknowledgment_status='SENT',updated_at=? WHERE gmail_message_id=?`,
        )
        .bind(sentAt, message.id),
      db
        .prepare(
          `INSERT INTO complaint_events(id,complaint_id,event_type,actor,timestamp,metadata) VALUES(?,?,'DUNKIN_ACKNOWLEDGED','gmail',?,?)`,
        )
        .bind(crypto.randomUUID(), complaintId, sentAt, JSON.stringify({ providerMessageId })),
    ])
    await recordIntegrationEvent(db, 'ACKNOWLEDGMENT_SENT', complaintId, 'SUCCESS')
    return 'SENT'
  } catch (error) {
    const code = error instanceof GmailProviderError ? error.code : 'GMAIL_SEND_UNKNOWN'
    const failedAt = new Date().toISOString()
    await db.batch([
      db
        .prepare(
          `UPDATE email_acknowledgments SET status='FAILED',last_error_code=?,updated_at=? WHERE id=?`,
        )
        .bind(code, failedAt, acknowledgment.id),
      db
        .prepare(`UPDATE complaints SET acknowledgement_status='FAILED',updated_at=? WHERE id=?`)
        .bind(failedAt, complaintId),
    ])
    await recordIntegrationEvent(db, 'ACKNOWLEDGMENT_FAILED', complaintId, 'FAILED', code)
    return 'FAILED'
  }
}

export async function pollGmail(
  db: D1Database,
  gmail: GmailProvider,
  config: AppConfig,
): Promise<{ processed: number; failures: number }> {
  if (!config.gmailIngestionEnabled || !gmail.ready) return { processed: 0, failures: 0 }
  const ids = await gmail.listMessageIds(config.gmailSearchQuery ?? 'newer_than:30d')
  let processed = 0
  let failures = 0
  for (const id of ids.reverse()) {
    try {
      const message = await gmail.getMessage(id)
      const result = await ingestGmailMessage(db, message)
      if (result.status !== 'DUPLICATE') processed += 1
      if (result.complaintId && config.gmailAckEnabled)
        await acknowledgeComplaint(db, gmail, result.complaintId, config)
    } catch {
      failures += 1
    }
  }
  return { processed, failures }
}

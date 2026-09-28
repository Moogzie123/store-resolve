// Phase C — ack/response workflow scaffolding.
//
// Template storage (response_templates, new in migration 0007) plus an
// approval-gated lifecycle on the existing response_actions table:
//
//   DRAFT -> PENDING_APPROVAL -> APPROVED -> (send)
//                                        \-> REJECTED
//
// Sending is disabled in this phase, unconditionally:
//   - email_ack_enabled=false  -> SEND_DISABLED
//   - email_ack_enabled=true   -> SEND_NOT_WIRED (no transport exists yet)
// No external send can happen from this module. Ever, in Phase C.
//
// The identity rule is unaffected: drafts are human-authored from templates,
// never model-generated, and approving a response never creates or merges a
// complaint.

import type { D1Database } from './d1'

export const RESPONSE_POLICY_VERSION = 'response-policy.v1'

export type ResponseActionPolicyState =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'SEND_BLOCKED'

export class ResponseWorkflowError extends Error {
  constructor(
    readonly code: 'TEMPLATE_NOT_FOUND' | 'COMPLAINT_NOT_FOUND' | 'INVALID_TRANSITION' | 'SEND_DISABLED' | 'SEND_NOT_WIRED' | 'ACTION_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'ResponseWorkflowError'
  }
}

export interface ResponseTemplate {
  id: string
  name: string
  responseKind: string
  subjectTemplate?: string
  bodyTemplate: string
  version: number
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface ResponseAction {
  id: string
  complaintId: string
  responseKind: string
  policyVersion: string
  policyState: ResponseActionPolicyState
  contentKind?: string
  contentRef?: string
  templateVersion?: string
  approvedBy?: string
  approvedAt?: string
  createdAt: string
  updatedAt: string
}

/**
 * Render a template with {{variable}} placeholders. Unknown variables are
 * left in place (visible in review) rather than silently dropped.
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : match,
  )
}

const toTemplate = (row: Record<string, unknown>): ResponseTemplate => ({
  id: String(row.id),
  name: String(row.name),
  responseKind: String(row.response_kind),
  subjectTemplate: row.subject_template ? String(row.subject_template) : undefined,
  bodyTemplate: String(row.body_template),
  version: Number(row.version),
  active: Number(row.active) === 1,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

const toAction = (row: Record<string, unknown>): ResponseAction => ({
  id: String(row.id),
  complaintId: String(row.complaint_id),
  responseKind: String(row.response_kind),
  policyVersion: String(row.policy_version),
  policyState: String(row.policy_state) as ResponseActionPolicyState,
  contentKind: row.content_kind ? String(row.content_kind) : undefined,
  contentRef: row.content_ref ? String(row.content_ref) : undefined,
  templateVersion: row.template_version ? String(row.template_version) : undefined,
  approvedBy: row.approved_by ? String(row.approved_by) : undefined,
  approvedAt: row.approved_at ? String(row.approved_at) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
})

export async function createResponseTemplate(
  db: D1Database,
  input: { name: string; responseKind: string; subjectTemplate?: string; bodyTemplate: string },
): Promise<ResponseTemplate> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO response_templates(id,name,response_kind,subject_template,body_template,version,active,created_at,updated_at)
       VALUES(?,?,?,?,?,1,1,?,?)`,
    )
    .bind(id, input.name, input.responseKind, input.subjectTemplate ?? null, input.bodyTemplate, now, now)
    .run()
  const row = await db.prepare('SELECT * FROM response_templates WHERE id=?').bind(id).first<Record<string, unknown>>()
  if (!row) throw new ResponseWorkflowError('TEMPLATE_NOT_FOUND', 'template insert failed')
  return toTemplate(row)
}

export async function listResponseTemplates(db: D1Database): Promise<ResponseTemplate[]> {
  const rows = await db
    .prepare('SELECT * FROM response_templates WHERE active=1 ORDER BY name')
    .all<Record<string, unknown>>()
  return rows.results.map(toTemplate)
}

export async function getResponseTemplate(db: D1Database, id: string): Promise<ResponseTemplate | null> {
  const row = await db
    .prepare('SELECT * FROM response_templates WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>()
  return row ? toTemplate(row) : null
}

/**
 * Create a DRAFT response action for a complaint. Body comes from a template
 * (rendered with the given vars) or is supplied directly. Never sends.
 */
export async function createResponseDraft(
  db: D1Database,
  input: {
    complaintId: string
    responseKind?: string
    templateId?: string
    templateVars?: Record<string, unknown>
    body?: string
    createdBy?: string
  },
): Promise<ResponseAction> {
  const complaint = await db
    .prepare('SELECT id FROM complaints WHERE id=?')
    .bind(input.complaintId)
    .first<{ id: string }>()
  if (!complaint)
    throw new ResponseWorkflowError('COMPLAINT_NOT_FOUND', `complaint ${input.complaintId} not found`)

  let body = input.body ?? ''
  let templateVersion: string | undefined
  if (input.templateId) {
    const template = await getResponseTemplate(db, input.templateId)
    if (!template || !template.active)
      throw new ResponseWorkflowError('TEMPLATE_NOT_FOUND', `template ${input.templateId} not found`)
    body = renderTemplate(template.bodyTemplate, input.templateVars ?? {})
    templateVersion = `response-template.v${template.version}`
  }
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO response_actions(
         id,complaint_id,response_kind,policy_version,policy_state,
         content_kind,content_ref,template_version,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      input.complaintId,
      input.responseKind ?? 'ACKNOWLEDGMENT',
      RESPONSE_POLICY_VERSION,
      'DRAFT',
      'draft-body',
      body,
      templateVersion ?? null,
      now,
      now,
    )
    .run()
  const row = await db.prepare('SELECT * FROM response_actions WHERE id=?').bind(id).first<Record<string, unknown>>()
  if (!row) throw new ResponseWorkflowError('ACTION_NOT_FOUND', 'draft insert failed')
  return toAction(row)
}

async function transitionState(
  db: D1Database,
  id: string,
  from: ResponseActionPolicyState[],
  to: ResponseActionPolicyState,
  extra?: { approvedBy?: string },
): Promise<ResponseAction> {
  const now = new Date().toISOString()
  const row = await db
    .prepare('SELECT * FROM response_actions WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>()
  if (!row) throw new ResponseWorkflowError('ACTION_NOT_FOUND', `response action ${id} not found`)
  const current = String(row.policy_state) as ResponseActionPolicyState
  if (!from.includes(current))
    throw new ResponseWorkflowError(
      'INVALID_TRANSITION',
      `cannot transition response action ${id} from ${current} to ${to}`,
    )
  await db
    .prepare(
      `UPDATE response_actions SET policy_state=?,approved_by=COALESCE(?,approved_by),
       approved_at=CASE WHEN ? IS NOT NULL THEN ? ELSE approved_at END, updated_at=?
       WHERE id=? AND policy_state=?`,
    )
    .bind(to, extra?.approvedBy ?? null, extra?.approvedBy ?? null, now, now, id, current)
    .run()
  const updated = await db
    .prepare('SELECT * FROM response_actions WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>()
  return toAction(updated!)
}

export const submitResponseForApproval = (db: D1Database, id: string): Promise<ResponseAction> =>
  transitionState(db, id, ['DRAFT'], 'PENDING_APPROVAL')

export const approveResponseAction = (
  db: D1Database,
  input: { id: string; approvedBy: string },
): Promise<ResponseAction> =>
  transitionState(db, input.id, ['PENDING_APPROVAL'], 'APPROVED', { approvedBy: input.approvedBy })

export const rejectResponseAction = (
  db: D1Database,
  input: { id: string; rejectedBy: string },
): Promise<ResponseAction> =>
  transitionState(db, input.id, ['PENDING_APPROVAL'], 'REJECTED', { approvedBy: input.rejectedBy })

/**
 * Sending is disabled in Phase C. This function never performs an external
 * send: it throws SEND_DISABLED when the ack flag is off (the default) and
 * SEND_NOT_WIRED when it is on (no transport exists yet).
 */
export async function sendResponseAction(
  db: D1Database,
  input: { id: string; emailAckEnabled: boolean },
): Promise<never> {
  const row = await db
    .prepare('SELECT id,policy_state FROM response_actions WHERE id=?')
    .bind(input.id)
    .first<{ id: string; policy_state: string }>()
  if (!row) throw new ResponseWorkflowError('ACTION_NOT_FOUND', `response action ${input.id} not found`)
  if (!input.emailAckEnabled)
    throw new ResponseWorkflowError(
      'SEND_DISABLED',
      'sending is disabled: email_ack_enabled=false (Phase C never sends)',
    )
  throw new ResponseWorkflowError(
    'SEND_NOT_WIRED',
    'email_ack_enabled is on but no send transport is wired in Phase C; refusing rather than sending',
  )
}

export async function getResponseAction(db: D1Database, id: string): Promise<ResponseAction | null> {
  const row = await db
    .prepare('SELECT * FROM response_actions WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>()
  return row ? toAction(row) : null
}

export async function listResponseActionsForComplaint(
  db: D1Database,
  complaintId: string,
): Promise<ResponseAction[]> {
  const rows = await db
    .prepare('SELECT * FROM response_actions WHERE complaint_id=? ORDER BY created_at')
    .bind(complaintId)
    .all<Record<string, unknown>>()
  return rows.results.map(toAction)
}

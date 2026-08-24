import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  actionSchema,
  complaintInputSchema,
  configSchema,
  contactSchema,
  signalWireCallbackSchema,
  signalWireReconcileSchema,
  storeAdminSchema,
  testNotificationSchema,
  userAdminSchema,
} from '../src/lib/api-schema'
import { createComplaint, processDeadlines, updateComplaint } from '../src/lib/workflow'
import type { AppState, User } from '../src/lib/types'
import { authenticate, canAdmin, canViewComplaint, maskEmail, maskPhone } from './auth'
import { loadState, persistState, type D1Database } from './d1'
import { SignalWireSmsProvider } from './providers'
import { applySignalWireCallback, reconcileSignalWireMessage } from './callbacks'
import { maskGraphIdentifier, MicrosoftGraphProvider } from './microsoft-graph'
import { EmailProviderError } from './email-provider'
import { ingestSinglePilotComplaint } from './ingestion'
import { runScheduledOperations } from './operations'
import { buildReport } from './reporting'

type Bindings = Env & {
  DEV_AUTH_USER_ID?: string
  SIGNALWIRE_PROJECT_ID?: string
  SIGNALWIRE_API_TOKEN?: string
  SIGNALWIRE_SPACE_URL?: string
  SIGNALWIRE_PHONE_NUMBER?: string
  PUBLIC_BASE_URL?: string
  MS_CLIENT_ID?: string
  MS_CLIENT_SECRET?: string
  MS_REFRESH_TOKEN?: string
  MS_MAILBOX_ADDRESS?: string
  MS_TENANT?: string
}
type Variables = { user: User }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const ownerIds = ['father', 'uncle', 'grandfather']
const pilotAdminId = 'pilot-admin'
const testRecipientIds = [...ownerIds, pilotAdminId]
const jsonError = (message: string) => ({ error: message })
const provider = (env: Bindings) =>
  new SignalWireSmsProvider({
    projectId: env.SIGNALWIRE_PROJECT_ID,
    apiToken: env.SIGNALWIRE_API_TOKEN,
    spaceUrl: env.SIGNALWIRE_SPACE_URL,
    from: env.SIGNALWIRE_PHONE_NUMBER,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  })
const emailProvider = (env: Bindings) =>
  new MicrosoftGraphProvider({
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    refreshToken: env.MS_REFRESH_TOKEN,
    mailboxAddress: env.MS_MAILBOX_ADDRESS,
    tenant: env.MS_TENANT,
  })
const auditAdminChange = async (
  db: D1Database,
  eventType: string,
  entityId: string,
  actorId: string,
) =>
  db
    .prepare(
      `INSERT INTO integration_events(id,integration,event_type,entity_id,outcome,detail_code,metadata,created_at) VALUES(?,'ADMIN',?,?,'SUCCESS',NULL,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      eventType,
      entityId,
      JSON.stringify({ actorId }),
      new Date().toISOString(),
    )
    .run()
const publicState = (state: AppState, user: User): AppState => ({
  ...state,
  activeUserId: user.id,
  users: state.users.map((u) => ({ ...u, email: maskEmail(u.email), phone: maskPhone(u.phone) })),
  complaints: state.complaints.filter((c) =>
    canViewComplaint(user, c.storeId, c.assignedManagerId),
  ),
})

app.get('/api/health', (c) => c.json({ ok: true, service: 'store-resolve' }))
app.post('/api/signalwire/status', async (c) => {
  let payload: unknown
  try {
    payload = c.req.header('content-type')?.includes('application/json')
      ? await c.req.json()
      : await c.req.parseBody()
  } catch {
    return c.json(jsonError('Invalid callback'), 400)
  }
  const parsed = signalWireCallbackSchema.safeParse(payload)
  if (!parsed.success) return c.json(jsonError('Invalid callback'), 400)
  if ('project_id' in parsed.data && parsed.data.project_id !== c.env.SIGNALWIRE_PROJECT_ID)
    return c.json(jsonError('SignalWire verification failed'), 403)
  const signalWire = provider(c.env)
  if (!signalWire.ready) return c.json(jsonError('Provider unavailable'), 503)
  let message
  try {
    message = await signalWire.retrieveMessage(
      'id' in parsed.data ? parsed.data.id : parsed.data.MessageSid,
    )
  } catch {
    return c.json(jsonError('SignalWire verification failed'), 403)
  }
  const result = await applySignalWireCallback(
    c.env.DB,
    message,
    c.env.SIGNALWIRE_PROJECT_ID!,
    c.env.SIGNALWIRE_PHONE_NUMBER!,
  )
  if (result === 'AUTHENTICITY_FAILED')
    return c.json(jsonError('SignalWire verification failed'), 403)
  if (result === 'NOT_FOUND') return c.json(jsonError('Notification not found'), 404)
  return c.json({ ok: true, result })
})

app.use('/api/*', async (c, next) => {
  const user = await authenticate(c.req.raw, c.env.DB, c.env)
  if (!user) return c.json(jsonError('Unauthorized'), 401)
  c.set('user', user)
  await next()
})
app.get('/api/bootstrap', async (c) => {
  const state = await loadState(c.env.DB)
  const user = c.get('user')
  const signalWire = provider(c.env)
  let providerReady = false
  if (signalWire.ready)
    try {
      await signalWire.verifyConnection()
      providerReady = true
    } catch {
      providerReady = false
    }
  const graph = emailProvider(c.env)
  let microsoftGraphReady = false
  if (graph.ready)
    try {
      await graph.verifyConnection()
      microsoftGraphReady = true
    } catch {
      microsoftGraphReady = false
    }
  const [lastEmailSync, lastBackgroundRun, failures] = await Promise.all([
    c.env.DB.prepare(
      `SELECT completed_at FROM background_job_runs WHERE job_name='OPERATIONS' AND outcome IN ('SUCCESS','PARTIAL') ORDER BY started_at DESC LIMIT 1`,
    ).first<{ completed_at: string }>(),
    c.env.DB.prepare(
      `SELECT completed_at FROM background_job_runs ORDER BY started_at DESC LIMIT 1`,
    ).first<{ completed_at: string }>(),
    c.env.DB.prepare(
      `SELECT integration,detail_code,created_at FROM integration_events WHERE outcome='FAILED' ORDER BY created_at DESC LIMIT 10`,
    ).all<{ integration: string; detail_code: string; created_at: string }>(),
  ])
  return c.json({
    state: publicState(state, user),
    currentUser: {
      ...user,
      phone: maskPhone(user.phone),
      email: maskEmail(user.email),
      maskedPhone: maskPhone(user.phone),
      maskedEmail: maskEmail(user.email),
    },
    providerReady,
    health: {
      microsoftGraphReady,
      emailIngestionEnabled: Boolean(state.config.emailIngestionEnabled),
      emailAckEnabled: Boolean(state.config.emailAckEnabled),
      lastEmailSyncAt: lastEmailSync?.completed_at,
      signalWireReady: providerReady,
      externalNotificationsEnabled: state.config.externalNotificationsEnabled,
      rolloutMode: state.config.mode,
      lastBackgroundRunAt: lastBackgroundRun?.completed_at,
      recentFailures: failures.results.map((row) => ({
        integration: row.integration,
        code: row.detail_code,
        occurredAt: row.created_at,
      })),
    },
  })
})
app.post(
  '/api/admin/signalwire/reconcile',
  zValidator('json', signalWireReconcileSchema),
  async (c) => {
    const user = c.get('user')
    if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
    const state = await loadState(c.env.DB)
    if (state.config.externalNotificationsEnabled)
      return c.json(jsonError('External notifications must be disabled'), 409)
    if (state.config.mode !== 'FAMILY_PILOT')
      return c.json(jsonError('FAMILY_PILOT mode required'), 409)
    const signalWire = provider(c.env)
    if (!signalWire.ready) return c.json(jsonError('Provider unavailable'), 503)
    let message
    try {
      message = await signalWire.retrieveMessage(c.req.valid('json').providerMessageId)
    } catch {
      return c.json(jsonError('SignalWire verification failed'), 403)
    }
    const result = await reconcileSignalWireMessage(
      c.env.DB,
      message,
      c.env.SIGNALWIRE_PROJECT_ID!,
      c.env.SIGNALWIRE_PHONE_NUMBER!,
      pilotAdminId,
    )
    if (result === 'AUTHENTICITY_FAILED')
      return c.json(jsonError('SignalWire verification failed'), 403)
    if (result === 'NOT_FOUND') return c.json(jsonError('Notification not found'), 404)
    if (result === 'NON_TERMINAL') return c.json(jsonError('Provider state is not terminal'), 409)
    return c.json({ ok: true, result, providerStatus: message.status.toUpperCase() })
  },
)
app.post('/api/complaints', zValidator('json', complaintInputSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const state = await loadState(c.env.DB)
  const result = createComplaint(state, c.req.valid('json'))
  await persistState(c.env.DB, result.state)
  await dispatchEligible(c.env, result.state)
  return c.json(publicState(await loadState(c.env.DB), user))
})
app.post('/api/complaints/:id/actions', zValidator('json', actionSchema), async (c) => {
  const user = c.get('user')
  const state = await loadState(c.env.DB)
  const complaint = state.complaints.find((x) => x.id === c.req.param('id'))
  if (!complaint) return c.json(jsonError('Complaint not found'), 404)
  if (!canViewComplaint(user, complaint.storeId, complaint.assignedManagerId))
    return c.json(jsonError('Forbidden'), 403)
  try {
    const body = c.req.valid('json')
    const next = updateComplaint(state, complaint.id, body.action, user.id, body.data)
    await persistState(c.env.DB, next)
    await dispatchEligible(c.env, next)
    return c.json(publicState(await loadState(c.env.DB), user))
  } catch (error) {
    return c.json(jsonError((error as Error).message), 403)
  }
})
app.post(
  '/api/admin/deadlines',
  zValidator('json', z.object({ advanceHours: z.number().min(0).max(720).default(0) })),
  async (c) => {
    const user = c.get('user')
    if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
    const state = await loadState(c.env.DB)
    const now = new Date(Date.now() + c.req.valid('json').advanceHours * 3600000).toISOString()
    const next = processDeadlines(state, now)
    await persistState(c.env.DB, next)
    await dispatchEligible(c.env, next)
    return c.json(publicState(await loadState(c.env.DB), user))
  },
)
app.put('/api/admin/config', zValidator('json', configSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const state = await loadState(c.env.DB)
  state.config = c.req.valid('json')
  await persistState(c.env.DB, state)
  await auditAdminChange(c.env.DB, 'SETTINGS_CHANGED', 'operational-settings', user.id)
  return c.json(publicState(await loadState(c.env.DB), user))
})

app.post('/api/admin/email/pilot-ingest', async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const state = await loadState(c.env.DB)
  try {
    const result = await ingestSinglePilotComplaint(c.env.DB, emailProvider(c.env), state.config)
    return c.json({ ok: true, ...result })
  } catch (error) {
    const code = error instanceof EmailProviderError ? error.code : 'MS_GRAPH_PILOT_FAILED'
    return c.json(jsonError(code), 409)
  }
})

app.get('/api/admin/email/readiness', async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const graph = emailProvider(c.env)
  if (!graph.ready)
    return c.json({ ok: false, ready: false, error: 'MS_GRAPH_NOT_CONFIGURED' }, 503)
  try {
    await graph.verifyConnection()
    return c.json({ ok: true, ready: true, check: 'INBOX_FOLDER_METADATA' })
  } catch (error) {
    const code = error instanceof EmailProviderError ? error.code : 'MS_GRAPH_READINESS_FAILED'
    return c.json({ ok: false, ready: false, error: code }, 503)
  }
})

app.get('/api/admin/email/pilot-diagnostic', async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const state = await loadState(c.env.DB)
  if (
    state.config.mode !== 'FAMILY_PILOT' ||
    state.config.externalNotificationsEnabled ||
    state.config.emailIngestionEnabled ||
    state.config.emailAckEnabled
  )
    return c.json(jsonError('Production safety controls must remain locked down'), 409)
  const graph = emailProvider(c.env)
  if (!graph.ready)
    return c.json({ ok: false, ready: false, error: 'MS_GRAPH_NOT_CONFIGURED' }, 503)
  try {
    await graph.verifyConnection()
    const selection = await graph.findPilotComplaintCandidates()
    const result = {
      ok: true,
      scope: 'INBOX_METADATA_ONLY',
      rawMetadataCandidateCount: selection.inspectedCandidates.length,
      hasMoreMetadataCandidates: selection.hasMore,
      finalCandidateCount: selection.candidates.length,
      uniquenessEstablished: !selection.hasMore && selection.candidates.length === 1,
      candidates: selection.inspectedCandidates.map((candidate) => ({
        messageId: maskGraphIdentifier(candidate.id),
        conversationId: maskGraphIdentifier(candidate.conversationId),
        receivedDateTime: candidate.receivedDateTime,
        senderMatched: candidate.senderMatched,
        receivedWindowMatched: candidate.receivedWindowMatched,
        caseIdMatched: candidate.caseIdMatched,
        subjectPhraseMatched: candidate.subjectPhraseMatched,
        storeTokenMatched: candidate.storeTokenMatched,
        previousSubjectPrefixMatched: candidate.previousSubjectPrefixMatched,
        previousWindowMatched: candidate.previousWindowMatched,
      })),
    }
    if (c.req.header('accept')?.includes('text/html')) {
      const escaped = JSON.stringify(result, null, 2)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return c.html(`<pre>${escaped}</pre>`)
    }
    return c.json(result)
  } catch (error) {
    const code = error instanceof EmailProviderError ? error.code : 'MS_GRAPH_DIAGNOSTIC_FAILED'
    return c.json({ ok: false, error: code }, 503)
  }
})

app.get('/diagnostics/pilot-mail', (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/api/admin/email/pilot-diagnostic'
  return app.fetch(new Request(url, { headers: c.req.raw.headers }), c.env)
})

app.get('/api/admin/reporting', async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const state = await loadState(c.env.DB)
  return c.json(
    buildReport(state, {
      from: c.req.query('from'),
      to: c.req.query('to'),
      storeId: c.req.query('storeId'),
      status: c.req.query('status'),
      category: c.req.query('category'),
      severity: c.req.query('severity'),
    }),
  )
})

app.put('/api/admin/stores/:id', zValidator('json', storeAdminSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const id = c.req.param('id').trim()
  if (!id || id.length > 100) return c.json(jsonError('Invalid store identifier'), 400)
  const input = c.req.valid('json')
  const now = new Date().toISOString()
  const manager = input.managerId
    ? await c.env.DB.prepare(
        `SELECT id FROM users WHERE id=? AND role='STORE_MANAGER' AND active=1`,
      )
        .bind(input.managerId)
        .first<{ id: string }>()
    : null
  if (input.managerId && !manager) return c.json(jsonError('Active manager required'), 400)
  await c.env.DB.prepare(
    `INSERT INTO stores(id,organization_id,dunkin_store_number,name,address,city,state,postal_code,phone,active,manager_id,created_at,updated_at) VALUES(?,'org-1',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dunkin_store_number=excluded.dunkin_store_number,name=excluded.name,address=excluded.address,city=excluded.city,state=excluded.state,postal_code=excluded.postal_code,phone=excluded.phone,active=excluded.active,manager_id=excluded.manager_id,updated_at=excluded.updated_at`,
  )
    .bind(
      id,
      input.number,
      input.name,
      input.address,
      input.city,
      input.state,
      input.postalCode,
      input.phone,
      input.active ? 1 : 0,
      input.managerId ?? null,
      now,
      now,
    )
    .run()
  await c.env.DB.prepare('DELETE FROM store_aliases WHERE store_id=?').bind(id).run()
  if (input.aliases.length)
    await c.env.DB.batch(
      input.aliases.map((alias) =>
        c.env.DB.prepare(
          `INSERT INTO store_aliases(id,store_id,alias_normalized,created_at) VALUES(?,?,?,?)`,
        ).bind(crypto.randomUUID(), id, alias.toLowerCase().replace(/[^a-z0-9]/g, ''), now),
      ),
    )
  await auditAdminChange(c.env.DB, 'STORE_CHANGED', id, user.id)
  return c.json(publicState(await loadState(c.env.DB), user))
})

app.put('/api/admin/users/:id', zValidator('json', userAdminSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const id = c.req.param('id').trim()
  if (!id || id.length > 100 || id === pilotAdminId)
    return c.json(jsonError('Invalid managed user identifier'), 400)
  const input = c.req.valid('json')
  const now = new Date().toISOString()
  const existing = await c.env.DB.prepare('SELECT * FROM users WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>()
  if (!existing) return c.json(jsonError('User not found'), 404)
  await c.env.DB.prepare(
    `INSERT INTO users(id,organization_id,name,email,phone,role,active,sms_enabled,timezone,created_at,updated_at,recipient_kind,complaint_notifications_enabled) VALUES(?,'org-1',?,?,?,?,?,?,?, ?,?,'STANDARD',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,role=excluded.role,active=excluded.active,sms_enabled=excluded.sms_enabled,timezone=excluded.timezone,complaint_notifications_enabled=excluded.complaint_notifications_enabled,updated_at=excluded.updated_at`,
  )
    .bind(
      id,
      input.name ?? String(existing.name),
      input.email ?? String(existing.email),
      input.phone ?? String(existing.phone),
      input.role ?? String(existing.role),
      (input.active ?? Boolean(existing.active)) ? 1 : 0,
      (input.smsEnabled ?? Boolean(existing.sms_enabled)) ? 1 : 0,
      input.timezone ?? String(existing.timezone),
      now,
      now,
      (input.complaintNotificationsEnabled ?? Boolean(existing.complaint_notifications_enabled))
        ? 1
        : 0,
    )
    .run()
  if (input.storeIds) {
    await c.env.DB.prepare('DELETE FROM user_store_assignments WHERE user_id=?').bind(id).run()
  }
  if ((input.role ?? existing.role) === 'STORE_MANAGER' && input.storeIds?.length)
    await c.env.DB.batch(
      input.storeIds.map((storeId) =>
        c.env.DB.prepare(
          `INSERT INTO user_store_assignments(user_id,store_id,created_at) SELECT ?,id,? FROM stores WHERE id=?`,
        ).bind(id, now, storeId),
      ),
    )
  await auditAdminChange(c.env.DB, 'USER_CHANGED', id, user.id)
  return c.json(publicState(await loadState(c.env.DB), user))
})
app.put('/api/admin/contacts/:id', zValidator('json', contactSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const id = c.req.param('id')
  if (!testRecipientIds.includes(id))
    return c.json(jsonError('Only controlled recipients can be configured'), 400)
  const state = await loadState(c.env.DB)
  const target = state.users.find((u) => u.id === id)
  if (!target) return c.json(jsonError('Recipient not found'), 404)
  if (id === pilotAdminId) {
    if (target.recipientKind !== 'PILOT_ADMIN')
      return c.json(jsonError('Pilot recipient capability is unavailable'), 400)
    if (state.config.mode !== 'FAMILY_PILOT')
      return c.json(jsonError('Pilot recipient requires FAMILY_PILOT mode'), 403)
  }
  const contact = c.req.valid('json')
  target.name = contact.name
  target.smsEnabled = contact.smsEnabled
  target.active = contact.active
  if (contact.email) target.email = contact.email
  if (contact.phone) target.phone = contact.phone
  await persistState(c.env.DB, state)
  return c.json(publicState(await loadState(c.env.DB), user))
})
app.post('/api/admin/test-notifications', zValidator('json', testNotificationSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const { recipientUserId } = c.req.valid('json')
  const state = await loadState(c.env.DB)
  const recipient = state.users.find((u) => u.id === recipientUserId)
  if (!recipient || !testRecipientIds.includes(recipient.id))
    return c.json(jsonError('Controlled test recipient required'), 400)
  if (recipient.id === pilotAdminId && recipient.recipientKind !== 'PILOT_ADMIN')
    return c.json(jsonError('Pilot recipient capability is unavailable'), 400)
  const last = await c.env.DB.prepare(
    'SELECT last_sent_at FROM test_notification_rate_limits WHERE recipient_user_id=?',
  )
    .bind(recipient.id)
    .first<{ last_sent_at: string }>()
  if (last && Date.now() - new Date(last.last_sent_at).getTime() < 300000)
    return c.json(jsonError('Please wait five minutes before another test to this recipient'), 429)
  const now = new Date().toISOString()
  const id = `test-${crypto.randomUUID()}`
  const message =
    'STORERESOLVE TEST\nStoreResolve complaint alerts are connected to this phone.\nNo action is required.'
  let status = 'SUPPRESSED',
    reason: string | undefined,
    providerMessageId: string | undefined
  if (!state.config.externalNotificationsEnabled) reason = 'EXTERNAL_NOTIFICATIONS_DISABLED'
  else if (state.config.mode !== 'FAMILY_PILOT') reason = 'FAMILY_PILOT_REQUIRED'
  else if (!recipient.active || !recipient.smsEnabled || !recipient.phone)
    reason = 'RECIPIENT_NOT_READY'
  else if (!provider(c.env).ready) reason = 'SIGNALWIRE_NOT_READY'
  else {
    try {
      const result = await provider(c.env).send(
        {
          id,
          complaintId: '',
          eventType: 'TEST',
          recipientUserId: recipient.id,
          channel: 'SMS',
          message,
          status: 'PENDING',
          provider: 'SIGNALWIRE',
          createdAt: now,
        },
        recipient.phone,
      )
      status = result.status
      providerMessageId = result.providerMessageId
    } catch (error) {
      status = 'FAILED'
      reason = (error as Error).message
    }
  }
  await c.env.DB.prepare(
    `INSERT INTO notifications(id,complaint_id,event_type,recipient_user_id,channel,message,status,provider,provider_message_id,created_at,sent_at,failed_at,failure_reason) VALUES(?,NULL,'TEST',?,'SMS',?,?,'SIGNALWIRE',?,?,?, ?,?)`,
  )
    .bind(
      id,
      recipient.id,
      message,
      status,
      providerMessageId ?? null,
      now,
      status === 'SENT' ? now : null,
      status === 'FAILED' ? now : null,
      reason ?? null,
    )
    .run()
  await c.env.DB.prepare(
    'INSERT INTO test_notification_rate_limits(recipient_user_id,last_sent_at) VALUES(?,?) ON CONFLICT(recipient_user_id) DO UPDATE SET last_sent_at=excluded.last_sent_at',
  )
    .bind(recipient.id, now)
    .run()
  return c.json(publicState(await loadState(c.env.DB), user))
})

export async function dispatchEligible(env: Bindings, state: AppState) {
  for (const complaint of state.complaints)
    for (const n of complaint.notifications) {
      if (n.status !== 'PENDING' || n.providerMessageId) continue
      const recipient = state.users.find((u) => u.id === n.recipientUserId)
      if (!recipient) continue
      let reason: string | undefined
      if (!state.config.externalNotificationsEnabled) reason = 'EXTERNAL_NOTIFICATIONS_DISABLED'
      else if (recipient.recipientKind === 'PILOT_ADMIN') reason = 'TEST_RECIPIENT_ONLY'
      else if (state.config.mode === 'FAMILY_PILOT' && !recipient.complaintNotificationsEnabled)
        reason = 'FAMILY_PILOT'
      else if (
        state.config.mode === 'SINGLE_STORE_PILOT' &&
        recipient.role === 'STORE_MANAGER' &&
        complaint.storeId !== state.config.pilotStoreId
      )
        reason = 'SINGLE_STORE_PILOT'
      else if (!recipient.smsEnabled || !recipient.active || !recipient.phone)
        reason = 'RECIPIENT_NOT_READY'
      else if (!provider(env).ready) reason = 'SIGNALWIRE_NOT_READY'
      if (reason) {
        n.status = 'SUPPRESSED'
        n.failureReason = reason
        continue
      }
      try {
        const result = await provider(env).send(n, recipient.phone)
        n.providerMessageId = result.providerMessageId
        n.status = result.status
        n.sentAt = new Date().toISOString()
      } catch (error) {
        n.status = 'FAILED'
        n.failedAt = new Date().toISOString()
        n.failureReason = (error as Error).message
      }
    }
  await persistState(env.DB, state)
}

app.all('/api/*', (c) => c.json(jsonError('API route not found'), 404))
app.get('*', (c) =>
  c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('StoreResolve worker is healthy'),
)
export default {
  fetch: app.fetch,
  async scheduled(
    _controller: { cron: string; scheduledTime: number },
    env: Bindings,
  ): Promise<void> {
    await runScheduledOperations(env, emailProvider(env), provider(env), dispatchEligible)
  },
}

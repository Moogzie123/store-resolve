import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  actionSchema,
  callbackSchema,
  complaintInputSchema,
  configSchema,
  contactSchema,
  testNotificationSchema,
} from '../src/lib/api-schema'
import { createComplaint, processDeadlines, updateComplaint } from '../src/lib/workflow'
import type { AppState, User } from '../src/lib/types'
import { authenticate, canAdmin, canViewComplaint, maskEmail, maskPhone } from './auth'
import { loadState, persistState, type D1Database } from './d1'
import { TwilioSmsProvider, validateTwilioSignature } from './providers'
import { applyTwilioCallback } from './callbacks'

type Bindings = {
  DB: D1Database
  ASSETS?: { fetch(request: Request): Promise<Response> }
  DEV_AUTH_USER_ID?: string
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_PHONE_NUMBER?: string
  PUBLIC_BASE_URL?: string
}
type Variables = { user: User }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const ownerIds = ['father', 'uncle', 'grandfather']
const jsonError = (message: string) => ({ error: message })
const provider = (env: Bindings) =>
  new TwilioSmsProvider({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_PHONE_NUMBER,
    statusCallbackUrl: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/api/twilio/status` : undefined,
  })
const publicState = (state: AppState, user: User): AppState => ({
  ...state,
  activeUserId: user.id,
  users: state.users.map((u) => ({ ...u, email: maskEmail(u.email), phone: maskPhone(u.phone) })),
  complaints: state.complaints.filter((c) =>
    canViewComplaint(user, c.storeId, c.assignedManagerId),
  ),
})

app.get('/api/health', (c) => c.json({ ok: true, service: 'store-resolve' }))
app.post('/api/twilio/status', async (c) => {
  const form = await c.req.parseBody()
  const signature = c.req.header('X-Twilio-Signature') ?? ''
  if (
    !c.env.TWILIO_AUTH_TOKEN ||
    !signature ||
    !(await validateTwilioSignature(c.env.TWILIO_AUTH_TOKEN, signature, c.req.url, form))
  )
    return c.json(jsonError('Invalid Twilio signature'), 403)
  const parsed = callbackSchema.safeParse(form)
  if (!parsed.success) return c.json(jsonError('Invalid callback'), 400)
  const result = await applyTwilioCallback(c.env.DB, {
    messageSid: parsed.data.MessageSid,
    messageStatus: parsed.data.MessageStatus,
    errorCode: parsed.data.ErrorCode,
  })
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
  return c.json({
    state: publicState(state, user),
    currentUser: {
      ...user,
      phone: maskPhone(user.phone),
      email: maskEmail(user.email),
      maskedPhone: maskPhone(user.phone),
      maskedEmail: maskEmail(user.email),
    },
    providerReady: provider(c.env).ready,
  })
})
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
  return c.json(publicState(await loadState(c.env.DB), user))
})
app.put('/api/admin/contacts/:id', zValidator('json', contactSchema), async (c) => {
  const user = c.get('user')
  if (!canAdmin(user)) return c.json(jsonError('Owner access required'), 403)
  const id = c.req.param('id')
  if (!ownerIds.includes(id))
    return c.json(jsonError('Only ownership recipients can be configured'), 400)
  const state = await loadState(c.env.DB)
  const target = state.users.find((u) => u.id === id)
  if (!target) return c.json(jsonError('Recipient not found'), 404)
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
  if (!recipient || !ownerIds.includes(recipient.id))
    return c.json(jsonError('Ownership recipient required'), 400)
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
    'STORERESOLVE TEST\n\nStoreResolve complaint alerts are connected to this phone.\n\nNo action is required.'
  let status = 'SUPPRESSED',
    reason: string | undefined,
    providerMessageId: string | undefined
  if (!state.config.externalNotificationsEnabled) reason = 'EXTERNAL_NOTIFICATIONS_DISABLED'
  else if (state.config.mode !== 'FAMILY_PILOT') reason = 'FAMILY_PILOT_REQUIRED'
  else if (!recipient.active || !recipient.smsEnabled || !recipient.phone)
    reason = 'RECIPIENT_NOT_READY'
  else if (!provider(c.env).ready) reason = 'TWILIO_NOT_READY'
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
          provider: 'TWILIO',
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
    `INSERT INTO notifications(id,complaint_id,event_type,recipient_user_id,channel,message,status,provider,provider_message_id,created_at,sent_at,failed_at,failure_reason) VALUES(?,NULL,'TEST',?,'SMS',?,?,'TWILIO',?,?,?, ?,?)`,
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

async function dispatchEligible(env: Bindings, state: AppState) {
  for (const complaint of state.complaints)
    for (const n of complaint.notifications) {
      if (n.status !== 'SENT' || n.providerMessageId) continue
      const recipient = state.users.find((u) => u.id === n.recipientUserId)
      if (!recipient) continue
      let reason: string | undefined
      if (!state.config.externalNotificationsEnabled) reason = 'EXTERNAL_NOTIFICATIONS_DISABLED'
      else if (state.config.mode === 'FAMILY_PILOT' && !ownerIds.includes(recipient.id))
        reason = 'FAMILY_PILOT'
      else if (!recipient.smsEnabled || !recipient.active || !recipient.phone)
        reason = 'RECIPIENT_NOT_READY'
      if (reason) {
        n.status = 'SUPPRESSED'
        n.failureReason = reason
        continue
      }
      try {
        const result = await provider(env).send(n, recipient.phone)
        n.providerMessageId = result.providerMessageId
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
export default app

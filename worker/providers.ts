import type { Notification } from '../src/lib/types'

export interface NotificationProvider {
  readonly ready: boolean
  send(
    notification: Notification,
    destination: string,
  ): Promise<{ providerMessageId: string; status: 'SENT' | 'FAILED' }>
}

export interface SignalWireMessage {
  sid: string
  accountSid: string
  status: string
  from: string
  to: string
  errorCode?: string
  errorMessage?: string
}

type SignalWireConfig = {
  projectId?: string
  apiToken?: string
  spaceUrl?: string
  from?: string
  publicBaseUrl?: string
}

const e164 = /^\+[1-9]\d{7,14}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function signalWireOrigin(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.signalwire.com') ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    )
      return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function publicOrigin(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    )
      return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function safeDiagnostic(value: unknown, secrets: Array<string | undefined>): string {
  let message = typeof value === 'string' ? value : 'SignalWire request failed'
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]')
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 300)
}

function messageFrom(value: unknown, expectedProjectId: string): SignalWireMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const body = value as Record<string, unknown>
  if (
    typeof body.id !== 'string' ||
    typeof body.status !== 'string' ||
    typeof body.from !== 'string' ||
    typeof body.to !== 'string'
  )
    return undefined
  return {
    sid: body.id,
    accountSid: typeof body.project_id === 'string' ? body.project_id : expectedProjectId,
    status: body.status,
    from: body.from,
    to: body.to,
    errorCode: typeof body.error_code === 'string' ? body.error_code : undefined,
    errorMessage: typeof body.error_message === 'string' ? body.error_message : undefined,
  }
}

export class MockNotificationProvider implements NotificationProvider {
  readonly ready = true
  async send() {
    return { providerMessageId: `mock-${crypto.randomUUID()}`, status: 'SENT' as const }
  }
}

export class SignalWireSmsProvider implements NotificationProvider {
  constructor(private readonly config: SignalWireConfig) {}

  get ready() {
    return Boolean(
      this.config.projectId &&
      uuid.test(this.config.projectId) &&
      this.config.apiToken &&
      signalWireOrigin(this.config.spaceUrl) &&
      this.config.from &&
      e164.test(this.config.from) &&
      publicOrigin(this.config.publicBaseUrl),
    )
  }

  get statusCallbackUrl() {
    const origin = publicOrigin(this.config.publicBaseUrl)
    return origin ? `${origin}/api/signalwire/status` : undefined
  }

  private get apiBase() {
    const origin = signalWireOrigin(this.config.spaceUrl)
    return origin ? `${origin}/api/messaging` : undefined
  }

  private get authorization() {
    return this.config.projectId && this.config.apiToken
      ? `Basic ${btoa(`${this.config.projectId}:${this.config.apiToken}`)}`
      : undefined
  }

  private async responseBody(response: Response): Promise<Record<string, unknown>> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('json'))
      throw new Error(
        `SignalWire returned an unexpected ${contentType.split(';')[0] || 'unknown'} response (${response.status})`,
      )
    try {
      return (await response.json()) as Record<string, unknown>
    } catch {
      throw new Error(`SignalWire returned a malformed response (${response.status})`)
    }
  }

  async send(
    notification: Notification,
    destination: string,
  ): Promise<{ providerMessageId: string; status: 'SENT' | 'FAILED' }> {
    const projectId = this.config.projectId
    if (!this.ready || !this.apiBase || !this.authorization || !this.config.from || !projectId)
      throw new Error('SignalWire is not configured')
    if (!e164.test(destination)) throw new Error('SignalWire destination must use E.164 format')
    const form = new URLSearchParams({
      to: destination,
      from: this.config.from,
      body: notification.message,
      status_callback_url: this.statusCallbackUrl!,
    })
    const response = await fetch(`${this.apiBase}/messages`, {
      method: 'POST',
      headers: {
        authorization: this.authorization,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(Object.fromEntries(form)),
    })
    const body = await this.responseBody(response)
    const message = messageFrom(body, projectId)
    if (response.status !== 201 || !message)
      throw new Error(
        safeDiagnostic(
          body.message ?? body.error_message ?? `SignalWire request failed (${response.status})`,
          [this.config.projectId, this.config.apiToken],
        ),
      )
    if (message.accountSid !== this.config.projectId || !uuid.test(message.sid))
      throw new Error('SignalWire returned an unexpected message identity')
    return { providerMessageId: message.sid, status: 'SENT' }
  }

  async retrieveMessage(messageSid: string): Promise<SignalWireMessage> {
    const projectId = this.config.projectId
    if (!this.ready || !this.apiBase || !this.authorization || !projectId)
      throw new Error('SignalWire is not configured')
    if (!uuid.test(messageSid)) throw new Error('Invalid SignalWire message identifier')
    const response = await fetch(`${this.apiBase}/logs/${encodeURIComponent(messageSid)}`, {
      headers: { accept: 'application/json', authorization: this.authorization },
    })
    const body = await this.responseBody(response)
    const message = messageFrom(body, projectId)
    if (!response.ok || !message)
      throw new Error(
        safeDiagnostic(
          body.message ??
            body.error_message ??
            `SignalWire verification failed (${response.status})`,
          [this.config.projectId, this.config.apiToken],
        ),
      )
    if (message.sid !== messageSid || message.accountSid !== this.config.projectId)
      throw new Error('SignalWire returned an unexpected message identity')
    return message
  }

  async verifyConnection(): Promise<void> {
    if (!this.ready || !this.apiBase || !this.authorization)
      throw new Error('SignalWire is not configured')
    const response = await fetch(`${this.apiBase}/logs?page_size=1`, {
      headers: { accept: 'application/json', authorization: this.authorization },
    })
    const body = await this.responseBody(response)
    if (response.status !== 200 || !Array.isArray(body.data))
      throw new Error(
        safeDiagnostic(
          body.message ?? body.error_message ?? `SignalWire diagnostic failed (${response.status})`,
          [this.config.projectId, this.config.apiToken],
        ),
      )
  }
}

export interface ComplaintEmailProvider {
  receive(): Promise<unknown[]>
  getThread(threadId: string): Promise<unknown>
  sendAcknowledgment(threadId: string, body: string): Promise<void>
  sendFinalReply(threadId: string, body: string): Promise<void>
}

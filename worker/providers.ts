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

function messageFrom(value: unknown): SignalWireMessage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const body = value as Record<string, unknown>
  if (
    typeof body.sid !== 'string' ||
    typeof body.account_sid !== 'string' ||
    typeof body.status !== 'string' ||
    typeof body.from !== 'string' ||
    typeof body.to !== 'string'
  )
    return undefined
  return {
    sid: body.sid,
    accountSid: body.account_sid,
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
    return origin && this.config.projectId
      ? `${origin}/api/laml/2010-04-01/Accounts/${encodeURIComponent(this.config.projectId)}`
      : undefined
  }

  private get authorization() {
    return this.config.projectId && this.config.apiToken
      ? `Basic ${btoa(`${this.config.projectId}:${this.config.apiToken}`)}`
      : undefined
  }

  private async responseBody(response: Response): Promise<Record<string, unknown>> {
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
    if (!this.ready || !this.apiBase || !this.authorization || !this.config.from)
      throw new Error('SignalWire is not configured')
    if (!e164.test(destination)) throw new Error('SignalWire destination must use E.164 format')
    const form = new URLSearchParams({
      To: destination,
      From: this.config.from,
      Body: notification.message,
      StatusCallback: this.statusCallbackUrl!,
    })
    const response = await fetch(`${this.apiBase}/Messages`, {
      method: 'POST',
      headers: {
        authorization: this.authorization,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    })
    const body = await this.responseBody(response)
    const message = messageFrom(body)
    if (!response.ok || !message)
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
    if (!this.ready || !this.apiBase || !this.authorization)
      throw new Error('SignalWire is not configured')
    if (!uuid.test(messageSid)) throw new Error('Invalid SignalWire message identifier')
    const response = await fetch(
      `${this.apiBase}/Messages/${encodeURIComponent(messageSid)}.json`,
      {
        headers: { authorization: this.authorization },
      },
    )
    const body = await this.responseBody(response)
    const message = messageFrom(body)
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
}

export interface ComplaintEmailProvider {
  receive(): Promise<unknown[]>
  getThread(threadId: string): Promise<unknown>
  sendAcknowledgment(threadId: string, body: string): Promise<void>
  sendFinalReply(threadId: string, body: string): Promise<void>
}

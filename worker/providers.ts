import type { Notification } from '../src/lib/types'
export interface NotificationProvider {
  send(
    notification: Notification,
    destination: string,
  ): Promise<{ providerMessageId: string; status: 'SENT' | 'FAILED' }>
}
export class MockNotificationProvider implements NotificationProvider {
  async send() {
    return { providerMessageId: `mock-${crypto.randomUUID()}`, status: 'SENT' as const }
  }
}
export class TwilioSmsProvider implements NotificationProvider {
  constructor(
    private readonly config: {
      accountSid?: string
      authToken?: string
      from?: string
      statusCallbackUrl?: string
    },
  ) {}
  get ready() {
    return Boolean(this.config.accountSid && this.config.authToken && this.config.from)
  }
  async send(
    notification: Notification,
    destination: string,
  ): Promise<{ providerMessageId: string; status: 'SENT' | 'FAILED' }> {
    if (!this.config.accountSid || !this.config.authToken || !this.config.from)
      throw new Error('Twilio is not configured')
    const form = new URLSearchParams({
      To: destination,
      From: this.config.from,
      Body: notification.message,
    })
    if (this.config.statusCallbackUrl) form.set('StatusCallback', this.config.statusCallbackUrl)
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${this.config.accountSid}:${this.config.authToken}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      },
    )
    const body = (await response.json()) as { sid?: string; message?: string }
    if (!response.ok || !body.sid)
      throw new Error(body.message ?? `Twilio request failed (${response.status})`)
    return { providerMessageId: body.sid, status: 'SENT' }
  }
}
export async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string | File>,
): Promise<boolean> {
  const payload =
    url +
    Object.keys(params)
      .sort()
      .map((key) => `${key}${typeof params[key] === 'string' ? params[key] : ''}`)
      .join('')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const expected = btoa(String.fromCharCode(...Array.from(new Uint8Array(digest))))
  if (expected.length !== signature.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++)
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return mismatch === 0
}
export interface ComplaintEmailProvider {
  receive(): Promise<unknown[]>
  getThread(threadId: string): Promise<unknown>
  sendAcknowledgment(threadId: string, body: string): Promise<void>
  sendFinalReply(threadId: string, body: string): Promise<void>
}

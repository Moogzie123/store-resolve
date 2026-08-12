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
    private readonly config: { accountSid?: string; authToken?: string; from?: string },
  ) {}
  async send(): Promise<{ providerMessageId: string; status: 'SENT' | 'FAILED' }> {
    if (!this.config.accountSid || !this.config.authToken || !this.config.from)
      throw new Error('Twilio is not configured')
    throw new Error(
      'Twilio network adapter intentionally disabled until family pilot credentials are supplied',
    )
  }
}
export interface ComplaintEmailProvider {
  receive(): Promise<unknown[]>
  getThread(threadId: string): Promise<unknown>
  sendAcknowledgment(threadId: string, body: string): Promise<void>
  sendFinalReply(threadId: string, body: string): Promise<void>
}

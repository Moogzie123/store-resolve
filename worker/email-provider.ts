export interface NormalizedEmailMessage {
  id: string
  threadId: string
  internalDate: string
  sender: string
  recipients: string
  subject: string
  messageIdHeader?: string
  inReplyTo?: string
  references?: string
  textBody: string
  htmlBody?: string
}

export interface EmailProvider {
  readonly ready: boolean
  verifyConnection(): Promise<void>
  listMessageIds(lookbackDays: number, maxResults?: number): Promise<string[]>
  getMessage(id: string): Promise<NormalizedEmailMessage>
  sendAcknowledgment(message: NormalizedEmailMessage, body: string): Promise<string | undefined>
}

export class EmailProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

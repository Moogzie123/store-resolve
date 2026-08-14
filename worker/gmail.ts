export interface GmailConfig {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  mailboxAddress?: string
}

export interface GmailMessagePart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailMessagePart[]
}

export interface GmailApiMessage {
  id: string
  threadId: string
  internalDate: string
  payload: GmailMessagePart & {
    headers?: Array<{ name: string; value: string }>
  }
}

export interface NormalizedGmailMessage {
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

export class GmailProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const safeHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()
const header = (message: GmailApiMessage, name: string) =>
  message.payload.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ??
  ''

function decodeBase64Url(data?: string): string {
  if (!data) return ''
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of Array.from(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function collectBodies(part: GmailMessagePart, bodies: { plain: string[]; html: string[] }) {
  const decoded = decodeBase64Url(part.body?.data)
  if (part.mimeType === 'text/plain' && decoded) bodies.plain.push(decoded)
  if (part.mimeType === 'text/html' && decoded) bodies.html.push(decoded)
  for (const child of part.parts ?? []) collectBodies(child, bodies)
}

function htmlToText(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeGmailMessage(message: GmailApiMessage): NormalizedGmailMessage {
  const bodies = { plain: [] as string[], html: [] as string[] }
  collectBodies(message.payload, bodies)
  const htmlBody = bodies.html.join('\n').trim()
  const textBody = bodies.plain.join('\n').trim() || htmlToText(htmlBody)
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: new Date(Number(message.internalDate)).toISOString(),
    sender: safeHeader(header(message, 'From')),
    recipients: safeHeader(header(message, 'To')),
    subject: safeHeader(header(message, 'Subject')) || '(no subject)',
    messageIdHeader: safeHeader(header(message, 'Message-ID')) || undefined,
    inReplyTo: safeHeader(header(message, 'In-Reply-To')) || undefined,
    references: safeHeader(header(message, 'References')) || undefined,
    textBody: textBody.slice(0, 100_000),
    htmlBody: htmlBody ? htmlBody.slice(0, 200_000) : undefined,
  }
}

export class GmailProvider {
  constructor(private readonly config: GmailConfig) {}

  get ready() {
    return Boolean(
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.refreshToken &&
      this.config.mailboxAddress,
    )
  }

  private async accessToken(): Promise<string> {
    if (!this.ready) throw new GmailProviderError('GMAIL_NOT_CONFIGURED', 'Gmail is not configured')
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        refresh_token: this.config.refreshToken!,
        grant_type: 'refresh_token',
      }),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok || typeof body.access_token !== 'string') {
      const code = response.status === 401 ? 'GMAIL_OAUTH_401' : 'GMAIL_OAUTH_FAILED'
      throw new GmailProviderError(code, 'Gmail OAuth refresh failed', response.status)
    }
    return body.access_token
  }

  private async request<T>(path: string, init: RequestInit = {}, retryReads = true): Promise<T> {
    const attempts = retryReads && (!init.method || init.method === 'GET') ? 3 : 1
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const token = await this.accessToken()
      const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...init.headers,
        },
      })
      if (response.ok) return (await response.json()) as T
      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
        continue
      }
      const code =
        response.status === 401
          ? 'GMAIL_API_401'
          : response.status === 403
            ? 'GMAIL_API_403_SCOPE'
            : response.status === 429
              ? 'GMAIL_API_RATE_LIMIT'
              : response.status >= 500
                ? 'GMAIL_API_TEMPORARY'
                : 'GMAIL_API_ERROR'
      throw new GmailProviderError(
        code,
        `Gmail API request failed (${response.status})`,
        response.status,
      )
    }
    throw new GmailProviderError('GMAIL_API_RETRY_EXHAUSTED', 'Gmail API retry limit reached')
  }

  async verifyConnection(): Promise<void> {
    await this.request<{ emailAddress: string }>('/profile')
  }

  async listMessageIds(query: string, maxResults = 25): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(maxResults, 100)) })
    const page = await this.request<{ messages?: Array<{ id: string }> }>(`/messages?${params}`)
    return (page.messages ?? []).map((item) => item.id)
  }

  async getMessage(id: string): Promise<NormalizedGmailMessage> {
    const message = await this.request<GmailApiMessage>(
      `/messages/${encodeURIComponent(id)}?format=full`,
    )
    return normalizeGmailMessage(message)
  }

  async getThread(threadId: string): Promise<GmailApiMessage[]> {
    const thread = await this.request<{ messages?: GmailApiMessage[] }>(
      `/threads/${encodeURIComponent(threadId)}?format=metadata`,
    )
    return thread.messages ?? []
  }

  async sendAcknowledgment(message: NormalizedGmailMessage, body: string): Promise<string> {
    if (!this.config.mailboxAddress)
      throw new GmailProviderError('GMAIL_NOT_CONFIGURED', 'Gmail is not configured')
    const subject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`
    const references = [message.references, message.messageIdHeader].filter(Boolean).join(' ')
    const lines = [
      `From: ${safeHeader(this.config.mailboxAddress)}`,
      `To: ${safeHeader(message.sender)}`,
      `Subject: ${safeHeader(subject)}`,
      ...(message.messageIdHeader ? [`In-Reply-To: ${message.messageIdHeader}`] : []),
      ...(references ? [`References: ${safeHeader(references)}`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ]
    const response = await this.request<{ id: string; threadId: string }>(
      '/messages/send',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          raw: encodeBase64Url(lines.join('\r\n')),
          threadId: message.threadId,
        }),
      },
      false,
    )
    if (!response.id || response.threadId !== message.threadId)
      throw new GmailProviderError(
        'GMAIL_SEND_IDENTITY',
        'Gmail returned an unexpected reply identity',
      )
    return response.id
  }
}

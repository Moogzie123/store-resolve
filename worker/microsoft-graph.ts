import {
  EmailProviderError,
  type EmailProvider,
  type NormalizedEmailMessage,
} from './email-provider'

export interface MicrosoftGraphConfig {
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  mailboxAddress?: string
  tenant?: string
}

interface GraphAddress {
  emailAddress?: { name?: string; address?: string }
}

export interface GraphMessage {
  id?: string
  conversationId?: string
  internetMessageId?: string
  receivedDateTime?: string
  subject?: string
  from?: GraphAddress
  sender?: GraphAddress
  toRecipients?: GraphAddress[]
  ccRecipients?: GraphAddress[]
  body?: { contentType?: string; content?: string }
  bodyPreview?: string
  internetMessageHeaders?: Array<{ name?: string; value?: string }>
}

export interface PilotMessageSelection {
  id: string
  conversationId: string
  internetMessageId?: string
  receivedDateTime: string
  subject: string
  senderAddress: string
}

export const pilotMessageSelector = {
  senderAddress: 'customerservice@dunkinbrands.com',
  subjectPrefix: 'DBI Case # (CCC11122413) - Guest Contact: Slow Service',
  receivedStart: '2026-08-01T18:25:00.000Z',
  receivedEnd: '2026-08-01T18:30:00.000Z',
} as const

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'
const GRAPH_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
].join(' ')

const htmlToText = (value: string) =>
  value
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

const formatAddress = (value?: GraphAddress) => {
  const address = value?.emailAddress?.address?.replace(/[\r\n]+/g, ' ').trim() ?? ''
  const name = value?.emailAddress?.name?.replace(/[\r\n]+/g, ' ').trim() ?? ''
  return name && address ? `${name} <${address}>` : address
}

const header = (message: GraphMessage, name: string) =>
  message.internetMessageHeaders?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
    ?.value

export function normalizeGraphMessage(message: GraphMessage): NormalizedEmailMessage {
  if (!message.id || !message.conversationId || !message.receivedDateTime)
    throw new EmailProviderError(
      'MS_GRAPH_INVALID_MESSAGE',
      'Microsoft Graph message is incomplete',
    )
  const content = message.body?.content ?? message.bodyPreview ?? ''
  const isHtml = message.body?.contentType?.toLowerCase() === 'html'
  return {
    id: message.id,
    threadId: message.conversationId,
    internalDate: new Date(message.receivedDateTime).toISOString(),
    sender: formatAddress(message.from ?? message.sender),
    recipients: [...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]
      .map(formatAddress)
      .filter(Boolean)
      .join(', '),
    subject: message.subject?.replace(/[\r\n]+/g, ' ').trim() || '(no subject)',
    messageIdHeader: message.internetMessageId || header(message, 'Message-ID'),
    inReplyTo: header(message, 'In-Reply-To'),
    references: header(message, 'References'),
    textBody: (isHtml ? htmlToText(content) : content).slice(0, 100_000),
    htmlBody: isHtml ? content.slice(0, 200_000) : undefined,
  }
}

export class MicrosoftGraphProvider implements EmailProvider {
  constructor(private readonly config: MicrosoftGraphConfig) {}

  get ready() {
    return Boolean(this.config.clientId && this.config.refreshToken && this.config.mailboxAddress)
  }

  private async accessToken(): Promise<string> {
    if (!this.ready)
      throw new EmailProviderError('MS_GRAPH_NOT_CONFIGURED', 'Microsoft Graph is not configured')
    const tenant = this.config.tenant?.trim() || 'consumers'
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId!,
          refresh_token: this.config.refreshToken!,
          grant_type: 'refresh_token',
          scope: GRAPH_SCOPES,
          ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
        }),
      },
    )
    const payload: unknown = await response.json().catch(() => null)
    const accessToken =
      payload && typeof payload === 'object' && 'access_token' in payload
        ? (payload as { access_token?: unknown }).access_token
        : undefined
    if (!response.ok || typeof accessToken !== 'string')
      throw new EmailProviderError(
        response.status === 401 ? 'MS_GRAPH_OAUTH_401' : 'MS_GRAPH_OAUTH_FAILED',
        'Microsoft Graph OAuth refresh failed',
        response.status,
      )
    return accessToken
  }

  private async request<T>(path: string, init: RequestInit = {}, retryReads = true): Promise<T> {
    const method = init.method ?? 'GET'
    const attempts = retryReads && method === 'GET' ? 3 : 1
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const token = await this.accessToken()
      const response = await fetch(`${GRAPH_ROOT}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
          ...init.headers,
        },
      })
      if (response.ok) {
        if (response.status === 202 || response.status === 204) return undefined as T
        return (await response.json()) as T
      }
      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
        continue
      }
      const code =
        response.status === 401
          ? 'MS_GRAPH_API_401'
          : response.status === 403
            ? 'MS_GRAPH_API_403_SCOPE'
            : response.status === 429
              ? 'MS_GRAPH_API_RATE_LIMIT'
              : response.status >= 500
                ? 'MS_GRAPH_API_TEMPORARY'
                : 'MS_GRAPH_API_ERROR'
      throw new EmailProviderError(
        code,
        `Microsoft Graph request failed (${response.status})`,
        response.status,
      )
    }
    throw new EmailProviderError('MS_GRAPH_RETRY_EXHAUSTED', 'Microsoft Graph retry limit reached')
  }

  async verifyConnection(): Promise<void> {
    const folder = await this.request<{
      id?: string
      displayName?: string
      totalItemCount?: number
      unreadItemCount?: number
    }>('/me/mailFolders/inbox?$select=id,displayName,totalItemCount,unreadItemCount')
    if (!folder.id)
      throw new EmailProviderError(
        'MS_GRAPH_INVALID_MAILBOX_METADATA',
        'Microsoft Graph Inbox metadata is incomplete',
      )
  }

  async findPilotComplaintCandidates(): Promise<{
    candidates: PilotMessageSelection[]
    hasMore: boolean
  }> {
    const escapedSubject = pilotMessageSelector.subjectPrefix.replace(/'/g, "''")
    const params = new URLSearchParams({
      $filter: [
        `receivedDateTime ge ${pilotMessageSelector.receivedStart}`,
        `receivedDateTime le ${pilotMessageSelector.receivedEnd}`,
        `from/emailAddress/address eq '${pilotMessageSelector.senderAddress}'`,
        `startswith(subject,'${escapedSubject}')`,
      ].join(' and '),
      $select: 'id,conversationId,internetMessageId,receivedDateTime,subject,from',
      $top: '2',
    })
    const page = await this.request<{
      value?: GraphMessage[]
      '@odata.nextLink'?: string
    }>(`/me/mailFolders/inbox/messages?${params.toString()}`)
    const candidates = (page.value ?? []).map((candidate) => {
      const senderAddress = candidate.from?.emailAddress?.address?.trim() ?? ''
      const receivedAt = Date.parse(candidate.receivedDateTime ?? '')
      if (
        !candidate.id ||
        !candidate.conversationId ||
        !candidate.receivedDateTime ||
        !candidate.subject ||
        senderAddress.toLowerCase() !== pilotMessageSelector.senderAddress ||
        !candidate.subject.startsWith(pilotMessageSelector.subjectPrefix) ||
        !Number.isFinite(receivedAt) ||
        receivedAt < Date.parse(pilotMessageSelector.receivedStart) ||
        receivedAt > Date.parse(pilotMessageSelector.receivedEnd)
      )
        throw new EmailProviderError(
          'MS_GRAPH_PILOT_INVALID_SELECTION',
          'Microsoft Graph pilot metadata did not satisfy every approved selector',
        )
      return {
        id: candidate.id,
        conversationId: candidate.conversationId,
        internetMessageId: candidate.internetMessageId,
        receivedDateTime: candidate.receivedDateTime,
        subject: candidate.subject,
        senderAddress,
      }
    })
    return { candidates, hasMore: Boolean(page['@odata.nextLink']) }
  }

  async listMessageIds(lookbackDays: number, maxResults = 25): Promise<string[]> {
    const since = new Date(
      Date.now() - Math.max(1, Math.min(365, lookbackDays)) * 86_400_000,
    ).toISOString()
    const params = new URLSearchParams({
      $select: 'id',
      $filter: `receivedDateTime ge ${since}`,
      $orderby: 'receivedDateTime asc',
      $top: String(Math.min(maxResults, 100)),
    })
    const page = await this.request<{ value?: Array<{ id?: string }> }>(
      `/me/mailFolders/inbox/messages?${params.toString()}`,
    )
    return (page.value ?? []).flatMap((item) => (item.id ? [item.id] : []))
  }

  async getMessage(id: string): Promise<NormalizedEmailMessage> {
    const select = [
      'id',
      'conversationId',
      'internetMessageId',
      'receivedDateTime',
      'subject',
      'from',
      'sender',
      'toRecipients',
      'ccRecipients',
      'body',
      'bodyPreview',
      'internetMessageHeaders',
    ].join(',')
    const message = await this.request<GraphMessage>(
      `/me/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(select)}`,
    )
    return normalizeGraphMessage(message)
  }

  async sendAcknowledgment(message: NormalizedEmailMessage, body: string): Promise<undefined> {
    await this.request<void>(
      `/me/messages/${encodeURIComponent(message.id)}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment: body }),
      },
      false,
    )
    // Graph's reply action returns 202 with no response body or sent-message identifier.
    return undefined
  }
}

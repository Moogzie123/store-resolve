// Phase C — notification abstraction.
//
// Defines the notification interface (complaint received, critical escalation,
// SLA breach) with a stub/log transport only. Recipients and channels are
// unknown until the family provides them, so routing is config-driven:
//
//   settings.external_notifications_enabled = 'true' | 'false'  (default false)
//   settings.notification_targets_json      = JSON array of {channel,address,label}
//
// Safety: with the flag off (the default), NotificationService.notify is a
// no-op that never touches a transport. Only the 'log' transport ships in
// this phase; email/SMS transports need explicit approval + credentials.

import type { D1Database } from './d1'

export type NotificationEventType =
  | 'complaint.received'
  | 'complaint.critical_escalation'
  | 'complaint.sla_breach'

export interface NotificationEvent {
  id: string
  type: NotificationEventType
  complaintId?: string
  severity?: string
  summary: string
  occurredAt: string
  metadata?: Record<string, unknown>
}

export type NotificationChannel = 'log' | 'email' | 'sms'

export interface NotificationTarget {
  channel: NotificationChannel
  /** Where the notification goes: log stream name, email address, phone number. */
  address: string
  label?: string
}

export interface NotificationReceipt {
  eventId: string
  transport: string
  channel: NotificationChannel
  target: string
  delivered: boolean
  detail?: string
  at: string
}

export interface NotificationTransport {
  readonly name: NotificationChannel
  send(event: NotificationEvent, target: NotificationTarget): Promise<NotificationReceipt>
}

export class NotificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NotificationError'
  }
}

/** The only transport shipped in Phase C: records to the log, sends nothing. */
export class LogNotificationTransport implements NotificationTransport {
  readonly name: NotificationChannel = 'log'
  public readonly sent: Array<{ event: NotificationEvent; target: NotificationTarget }> = []
  async send(event: NotificationEvent, target: NotificationTarget): Promise<NotificationReceipt> {
    this.sent.push({ event, target })
    console.log(
      `[notification:${event.type}] complaint=${event.complaintId ?? 'n/a'} target=${target.address} summary=${event.summary}`,
    )
    return {
      eventId: event.id,
      transport: this.name,
      channel: target.channel,
      target: target.address,
      delivered: true,
      detail: 'logged only; no external send in Phase C',
      at: new Date().toISOString(),
    }
  }
}

export interface NotificationConfig {
  enabled: boolean
  targets: NotificationTarget[]
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = { enabled: false, targets: [] }

const SETTINGS_KEYS = ['external_notifications_enabled', 'notification_targets_json'] as const

export async function loadNotificationConfig(db: D1Database): Promise<NotificationConfig> {
  const rows = await db
    .prepare(`SELECT key,value FROM settings WHERE key IN (${SETTINGS_KEYS.map(() => '?').join(',')})`)
    .bind(...SETTINGS_KEYS)
    .all<{ key: string; value: string }>()
  const values = new Map(rows.results.map((row) => [row.key, row.value]))
  const enabled = values.get('external_notifications_enabled') === 'true'
  let targets: NotificationTarget[] = []
  const raw = values.get('notification_targets_json')
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed))
        targets = parsed
          .filter(
            (item): item is NotificationTarget =>
              typeof item === 'object' &&
              item !== null &&
              ['log', 'email', 'sms'].includes((item as { channel?: unknown }).channel as string) &&
              typeof (item as { address?: unknown }).address === 'string',
          )
          .map((item) => ({
            channel: item.channel,
            address: item.address,
            label: typeof item.label === 'string' ? item.label : undefined,
          }))
    } catch {
      targets = []
    }
  }
  return { enabled, targets }
}

export class NotificationService {
  constructor(
    private readonly config: NotificationConfig,
    private readonly transports: NotificationTransport[],
  ) {}

  /**
   * Fan out an event to every configured target. When notifications are
   * disabled (the default) this returns [] without touching any transport.
   */
  async notify(event: NotificationEvent): Promise<NotificationReceipt[]> {
    if (!this.config.enabled || this.config.targets.length === 0) return []
    const receipts: NotificationReceipt[] = []
    for (const target of this.config.targets) {
      const transport =
        this.transports.find((candidate) => candidate.name === target.channel) ??
        this.transports[0]
      if (!transport)
        throw new NotificationError(
          'NO_TRANSPORT',
          `no transport available for channel ${target.channel}`,
        )
      receipts.push(await transport.send(event, target))
    }
    return receipts
  }
}

/** Convenience: build the standard critical-escalation event for a complaint. */
export function criticalEscalationEvent(input: {
  complaintId: string
  severity: string
  summary: string
  metadata?: Record<string, unknown>
}): NotificationEvent {
  return {
    id: crypto.randomUUID(),
    type: 'complaint.critical_escalation',
    complaintId: input.complaintId,
    severity: input.severity,
    summary: input.summary,
    occurredAt: new Date().toISOString(),
    metadata: input.metadata,
  }
}

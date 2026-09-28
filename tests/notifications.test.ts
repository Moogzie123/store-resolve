// Phase C: notification abstraction — config-driven, default off, log transport only.
import { describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/d1'
import {
  LogNotificationTransport,
  NotificationService,
  criticalEscalationEvent,
  loadNotificationConfig,
} from '../worker/notifications'

class FakeStatement implements D1PreparedStatement {
  values: unknown[] = []
  constructor(
    readonly sql: string,
    private readonly settings: Map<string, string>,
  ) {}
  bind(...values: unknown[]) {
    this.values = values
    return this
  }
  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes('FROM settings')) {
      const results = [...this.settings.entries()]
        .filter(([key]) => this.values.includes(key))
        .map(([key, value]) => ({ key, value }))
      return { results: results as T[], success: true }
    }
    return { results: [] as T[], success: true }
  }
  async first<T>(): Promise<T | null> {
    return null
  }
  async run(): Promise<D1Result> {
    return { results: [], success: true }
  }
}

const fakeDb = (settings: Record<string, string> = {}): D1Database =>
  ({
    prepare: (sql: string) => new FakeStatement(sql, new Map(Object.entries(settings))),
    batch: async () => [],
    exec: async () => null,
  }) as unknown as D1Database

describe('loadNotificationConfig', () => {
  it('defaults to disabled with no targets when settings are absent', async () => {
    const config = await loadNotificationConfig(fakeDb())
    expect(config.enabled).toBe(false)
    expect(config.targets).toEqual([])
  })

  it('reads the enabled flag and parses targets JSON', async () => {
    const config = await loadNotificationConfig(
      fakeDb({
        external_notifications_enabled: 'true',
        notification_targets_json: JSON.stringify([
          { channel: 'log', address: 'ops-log', label: 'Ops log' },
        ]),
      }),
    )
    expect(config.enabled).toBe(true)
    expect(config.targets).toEqual([{ channel: 'log', address: 'ops-log', label: 'Ops log' }])
  })

  it('ignores malformed targets JSON instead of crashing', async () => {
    const config = await loadNotificationConfig(
      fakeDb({ external_notifications_enabled: 'true', notification_targets_json: 'not-json' }),
    )
    expect(config.enabled).toBe(true)
    expect(config.targets).toEqual([])
  })

  it('drops targets with unknown channels', async () => {
    const config = await loadNotificationConfig(
      fakeDb({
        notification_targets_json: JSON.stringify([
          { channel: 'carrier-pigeon', address: 'x' },
          { channel: 'log', address: 'ops-log' },
        ]),
      }),
    )
    expect(config.targets).toHaveLength(1)
  })
})

describe('NotificationService', () => {
  it('is a no-op when disabled: no transport is ever touched', async () => {
    const transport = new LogNotificationTransport()
    const service = new NotificationService({ enabled: false, targets: [{ channel: 'log', address: 'ops' }] }, [
      transport,
    ])
    const receipts = await service.notify(
      criticalEscalationEvent({ complaintId: 'c1', severity: 'CRITICAL', summary: 'test' }),
    )
    expect(receipts).toEqual([])
    expect(transport.sent).toHaveLength(0)
  })

  it('is a no-op when enabled but no targets are configured', async () => {
    const transport = new LogNotificationTransport()
    const service = new NotificationService({ enabled: true, targets: [] }, [transport])
    const receipts = await service.notify(
      criticalEscalationEvent({ complaintId: 'c1', severity: 'CRITICAL', summary: 'test' }),
    )
    expect(receipts).toEqual([])
    expect(transport.sent).toHaveLength(0)
  })

  it('fans out to the log transport when enabled with targets', async () => {
    const transport = new LogNotificationTransport()
    const service = new NotificationService(
      { enabled: true, targets: [{ channel: 'log', address: 'ops-log' }] },
      [transport],
    )
    const event = criticalEscalationEvent({
      complaintId: 'c1',
      severity: 'CRITICAL',
      summary: 'foreign object',
    })
    const receipts = await service.notify(event)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.eventId).toBe(event.id)
    expect(receipts[0]?.delivered).toBe(true)
    expect(receipts[0]?.transport).toBe('log')
    expect(transport.sent).toHaveLength(1)
  })
})

describe('criticalEscalationEvent', () => {
  it('builds a well-formed critical escalation event', () => {
    const event = criticalEscalationEvent({
      complaintId: 'c9',
      severity: 'CRITICAL',
      summary: 'injury reported',
      metadata: { storeNumber: '41001' },
    })
    expect(event.type).toBe('complaint.critical_escalation')
    expect(event.complaintId).toBe('c9')
    expect(event.id).toBeTruthy()
    expect(event.occurredAt).toBeTruthy()
  })
})

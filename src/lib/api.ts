import { z } from 'zod'
import type { AppConfig, AppState, BootstrapResponse, NewComplaint, Store, User } from './types'
import {
  actionSchema,
  complaintInputSchema,
  configSchema,
  contactSchema,
  storeAdminSchema,
  userAdminSchema,
} from './api-schema'

const errorSchema = z.object({ error: z.string() })
async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...init,
  })
  const json: unknown = await response.json()
  if (!response.ok) throw new Error(errorSchema.safeParse(json).data?.error ?? 'Request failed')
  return schema.parse(json)
}
const bootstrapSchema = z.custom<BootstrapResponse>()
const stateSchema = z.custom<AppState>()
const reconciliationSchema = z.object({
  ok: z.literal(true),
  result: z.enum(['UPDATED', 'UNCHANGED']),
  providerStatus: z.enum(['DELIVERED', 'FAILED', 'UNDELIVERED']),
})
const pilotEmailSchema = z.object({
  ok: z.literal(true),
  accessed: z.boolean(),
  status: z.enum(['PROCESSED', 'ROUTING_REVIEW', 'DUPLICATE', 'FOLLOW_UP']).optional(),
  complaintId: z.string().optional(),
  messageId: z.string().optional(),
  conversationId: z.string().optional(),
  matchCount: z.union([z.literal(0), z.literal(1), z.literal('2+')]).optional(),
})
export const api = {
  bootstrap: () => request('/bootstrap', bootstrapSchema),
  createComplaint: (input: NewComplaint) =>
    request('/complaints', stateSchema, {
      method: 'POST',
      body: JSON.stringify(complaintInputSchema.parse(input)),
    }),
  act: (
    id: string,
    action: z.infer<typeof actionSchema>['action'],
    data: Record<string, unknown> = {},
  ) =>
    request(`/complaints/${encodeURIComponent(id)}/actions`, stateSchema, {
      method: 'POST',
      body: JSON.stringify(actionSchema.parse({ action, data })),
    }),
  processDeadlines: (advanceHours = 0) =>
    request('/admin/deadlines', stateSchema, {
      method: 'POST',
      body: JSON.stringify({ advanceHours }),
    }),
  updateConfig: (config: AppConfig) =>
    request('/admin/config', stateSchema, {
      method: 'PUT',
      body: JSON.stringify(configSchema.parse(config)),
    }),
  updateContact: (
    id: string,
    contact: Pick<User, 'name' | 'email' | 'phone' | 'smsEnabled' | 'active'>,
  ) =>
    request('/admin/contacts/' + id, stateSchema, {
      method: 'PUT',
      body: JSON.stringify(contactSchema.parse(contact)),
    }),
  sendTest: (recipientUserId: 'father' | 'uncle' | 'grandfather' | 'pilot-admin') =>
    request('/admin/test-notifications', stateSchema, {
      method: 'POST',
      body: JSON.stringify({ recipientUserId, confirmed: true }),
    }),
  reconcileSignalWire: (providerMessageId: string) =>
    request('/admin/signalwire/reconcile', reconciliationSchema, {
      method: 'POST',
      body: JSON.stringify({ providerMessageId }),
    }),
  ingestPilotEmail: () =>
    request('/admin/email/pilot-ingest', pilotEmailSchema, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  updateStore: (id: string, store: Store) =>
    request(`/admin/stores/${encodeURIComponent(id)}`, stateSchema, {
      method: 'PUT',
      body: JSON.stringify(
        storeAdminSchema.parse({
          number: store.number,
          name: store.name,
          address: store.address,
          city: store.city,
          state: store.state,
          postalCode: store.postalCode,
          phone: store.phone,
          active: store.active,
          managerId: store.managerId || undefined,
          aliases: store.aliases ?? [],
        }),
      ),
    }),
  updateUser: (id: string, changes: Partial<User> & { storeIds?: string[] }) =>
    request(`/admin/users/${encodeURIComponent(id)}`, stateSchema, {
      method: 'PUT',
      body: JSON.stringify(userAdminSchema.parse(changes)),
    }),
}

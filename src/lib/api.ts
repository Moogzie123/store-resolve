import { z } from 'zod'
import type { AppConfig, AppState, BootstrapResponse, NewComplaint, User } from './types'
import { actionSchema, complaintInputSchema, configSchema, contactSchema } from './api-schema'

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
}

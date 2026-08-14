import type { User } from '../src/lib/types'
import type { D1Database } from './d1'

export type AuthBindings = { DEV_AUTH_USER_ID?: string }
export async function authenticate(
  request: Request,
  db: D1Database,
  env: AuthBindings,
): Promise<User | null> {
  const accessEmail = request.headers
    .get('Cf-Access-Authenticated-User-Email')
    ?.trim()
    .toLowerCase()
  const id = env.DEV_AUTH_USER_ID
  if (!accessEmail && !id) return null
  const row = accessEmail
    ? await db
        .prepare('SELECT * FROM users WHERE lower(email)=? AND active=1')
        .bind(accessEmail)
        .first<Record<string, unknown>>()
    : await db
        .prepare('SELECT * FROM users WHERE id=? AND active=1')
        .bind(id)
        .first<Record<string, unknown>>()
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    phone: String(row.phone),
    role: row.role as User['role'],
    recipientKind: (row.recipient_kind ?? 'STANDARD') as User['recipientKind'],
    active: Boolean(row.active),
    smsEnabled: Boolean(row.sms_enabled),
    complaintNotificationsEnabled: Boolean(row.complaint_notifications_enabled),
    timezone: String(row.timezone),
  }
}
export const canAdmin = (user: User) => user.role === 'OWNER' || user.role === 'ADMIN'
export const canViewComplaint = (user: User, storeId?: string, managerId?: string) =>
  user.role !== 'STORE_MANAGER' ||
  user.id === managerId ||
  Boolean(storeId && user.id === managerId)
export const maskPhone = (value: string) =>
  value ? `(***) ***-${value.replace(/\D/g, '').slice(-4)}` : 'Not configured'
export const maskEmail = (value: string) => {
  const [name, domain] = value.split('@')
  return domain ? `${name.slice(0, 1)}***@${domain}` : 'Not configured'
}

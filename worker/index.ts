import { Hono } from 'hono'
type Bindings = {
  DB: unknown
  ASSETS?: { fetch(request: Request): Promise<Response> }
  NOTIFICATION_MODE: string
  EXTERNAL_NOTIFICATIONS_ENABLED: string
}
const app = new Hono<{ Bindings: Bindings }>()
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'store-resolve',
    mode: c.env.NOTIFICATION_MODE,
    externalNotificationsEnabled: c.env.EXTERNAL_NOTIFICATIONS_ENABLED === 'true',
  }),
)
app.all('/api/*', (c) => c.json({ error: 'API route not found' }, 404))
app.get('*', (c) =>
  c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('StoreResolve worker is healthy'),
)
export default app

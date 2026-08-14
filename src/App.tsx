import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Check,
  ChevronRight,
  CircleGauge,
  Clock3,
  FileText,
  LayoutDashboard,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Store as StoreIcon,
  Users,
} from 'lucide-react'
import { metrics } from './lib/workflow'
import { api } from './lib/api'
import { fixtures, initialState } from './lib/seed'
import type { AppState, Complaint, NewComplaint, Severity } from './lib/types'

type View = 'dashboard' | 'complaints' | 'simulator' | 'detail' | 'settings'
const fmt = (value?: string) =>
  value
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value))
    : '—'
const cx = (...x: (string | false | undefined)[]) => x.filter(Boolean).join(' ')

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>
}
function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar">
      {name
        .split(' ')
        .map((x) => x[0])
        .join('')
        .slice(0, 2)}
    </span>
  )
}

export default function App() {
  const [state, setState] = useState<AppState>(initialState)
  const [loading, setLoading] = useState(true)
  const [providerReady, setProviderReady] = useState(false)
  const [view, setView] = useState<View>('dashboard')
  const [selectedId, setSelectedId] = useState<string>()
  const [toast, setToast] = useState<string>()
  const user = state.users.find((u) => u.id === state.activeUserId)!
  const selected = state.complaints.find((c) => c.id === selectedId)
  const show = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(undefined), 2800)
  }
  const navigate = (next: View, id?: string) => {
    setView(next)
    setSelectedId(id)
    window.scrollTo(0, 0)
  }
  const visibleComplaints =
    user.role === 'STORE_MANAGER'
      ? state.complaints.filter((c) => c.assignedManagerId === user.id)
      : state.complaints
  useEffect(() => {
    api
      .bootstrap()
      .then((result) => {
        setState(result.state)
        setProviderReady(result.providerReady)
      })
      .catch((error: Error) => show(error.message))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    if (loading) return
    const timer = window.setInterval(
      () =>
        api
          .bootstrap()
          .then((result) => setState(result.state))
          .catch(() => undefined),
      10_000,
    )
    return () => window.clearInterval(timer)
  }, [loading])
  if (loading)
    return (
      <div className="loading-screen">
        <ShieldCheck />
        <strong>Loading secure workspace…</strong>
      </div>
    )
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Check size={18} />
          </span>
          <span>StoreResolve</span>
        </div>
        <nav>
          <button
            className={cx(view === 'dashboard' && 'active')}
            onClick={() => navigate('dashboard')}
          >
            <LayoutDashboard />
            Overview
          </button>
          <button
            className={cx((view === 'complaints' || view === 'detail') && 'active')}
            onClick={() => navigate('complaints')}
          >
            <FileText />
            Complaints <span className="nav-count">{visibleComplaints.length}</span>
          </button>
          {(user.role === 'OWNER' || user.role === 'ADMIN') && (
            <button
              className={cx(view === 'simulator' && 'active')}
              onClick={() => navigate('simulator')}
            >
              <Plus />
              Simulator
            </button>
          )}
          <div className="nav-label">Operations</div>
          <button>
            <StoreIcon />
            Stores
          </button>
          <button>
            <Users />
            Team
          </button>
          <button>
            <CircleGauge />
            Reports
          </button>
          {(user.role === 'OWNER' || user.role === 'ADMIN') && (
            <>
              <div className="nav-label">Administration</div>
              <button
                className={cx(view === 'settings' && 'active')}
                onClick={() => navigate('settings')}
              >
                <Settings />
                Pilot controls
              </button>
            </>
          )}
        </nav>
        <div className="safety-card">
          <ShieldCheck />
          <div>
            <strong>External messages off</strong>
            <span>All alerts are safely simulated.</span>
          </div>
        </div>
        <div className="profile">
          <Avatar name={user.name} />
          <div>
            <strong>{user.name}</strong>
            <span>{user.role.replace('_', ' ')}</span>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <button className="mobile-menu">
            <Menu />
          </button>
          <div className="search">
            <Search />
            <input placeholder="Search cases, stores, managers…" />
          </div>
          <div className="header-actions">
            <Badge tone="safe">{state.config.mode.replaceAll('_', ' ')}</Badge>
            <button className="icon-button">
              <Bell />
              <i />
            </button>
            <span className="session-user">
              <ShieldCheck /> Signed in as {user.name}
            </span>
          </div>
        </header>
        <div className="page">
          {view === 'dashboard' && (
            <Dashboard
              state={{ ...state, complaints: visibleComplaints }}
              onOpen={(id) => navigate('detail', id)}
              onCreate={() => navigate('simulator')}
            />
          )}
          {view === 'complaints' && (
            <ComplaintList
              state={{ ...state, complaints: visibleComplaints }}
              onOpen={(id) => navigate('detail', id)}
            />
          )}
          {view === 'simulator' && (
            <Simulator
              state={state}
              onCreate={async (input) => {
                try {
                  const next = await api.createComplaint(input)
                  setState(next)
                  const created = next.complaints.find(
                    (c) => c.externalCaseId === input.externalCaseId,
                  )
                  show('Complaint persisted and workflow started')
                  if (created) navigate('detail', created.id)
                } catch (error) {
                  show((error as Error).message)
                }
              }}
            />
          )}
          {view === 'detail' && selected && (
            <ComplaintDetail
              complaint={selected}
              state={state}
              onBack={() => navigate('complaints')}
              onAct={(action, data) =>
                api
                  .act(selected.id, action, data)
                  .then((next) => {
                    setState(next)
                    show('Case update persisted')
                  })
                  .catch((error: Error) => show(error.message))
              }
            />
          )}
          {view === 'settings' && (
            <PilotControls
              state={state}
              setState={setState}
              providerReady={providerReady}
              onRun={() =>
                api
                  .processDeadlines(72)
                  .then((next) => {
                    setState(next)
                    show('Persistent deadlines processed')
                  })
                  .catch((error: Error) => show(error.message))
              }
              onSaveConfig={(config) =>
                api
                  .updateConfig(config)
                  .then((next) => {
                    setState(next)
                    show('Safety configuration saved')
                  })
                  .catch((error: Error) => show(error.message))
              }
              onSendTest={(id) =>
                api
                  .sendTest(id)
                  .then((next) => {
                    setState(next)
                    show('Test attempt recorded')
                  })
                  .catch((error: Error) => show(error.message))
              }
              onReconcile={async (providerMessageId) => {
                try {
                  const result = await api.reconcileSignalWire(providerMessageId)
                  const refreshed = await api.bootstrap()
                  setState(refreshed.state)
                  setProviderReady(refreshed.providerReady)
                  show(`Provider reconciliation ${result.result.toLowerCase()}`)
                } catch (error) {
                  show((error as Error).message)
                }
              }}
            />
          )}
        </div>
      </main>
      {toast && (
        <div className="toast">
          <Check />
          {toast}
        </div>
      )}
    </div>
  )
}

function PageTitle({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow?: string
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {action}
    </div>
  )
}

function Dashboard({
  state,
  onOpen,
  onCreate,
}: {
  state: AppState
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  const m = metrics(state)
  const today = state.complaints.filter(
    (c) => new Date(c.receivedAt).toDateString() === new Date().toDateString(),
  ).length
  const stats = [
    {
      label: 'Open complaints',
      value: m.open,
      note: `${m.awaitingAck} awaiting acknowledgment`,
      icon: <FileText />,
      tone: 'navy',
    },
    {
      label: 'Overdue',
      value: m.overdue,
      note: m.overdue ? 'Requires attention' : 'No missed deadlines',
      icon: <AlertTriangle />,
      tone: 'red',
    },
    {
      label: 'Complaints today',
      value: today,
      note: `${state.complaints.length} total recorded`,
      icon: <Clock3 />,
      tone: 'orange',
    },
    {
      label: 'Closed',
      value: m.closed,
      note: 'Ownership reviewed',
      icon: <Check />,
      tone: 'green',
    },
  ]
  return (
    <>
      <PageTitle
        eyebrow="Owner workspace"
        title="Good morning, Father"
        body="Here’s what needs attention across your seven stores."
        action={
          <button className="primary" onClick={onCreate}>
            <Plus />
            New simulated complaint
          </button>
        }
      />
      <section className="stat-grid">
        {stats.map((s) => (
          <div className="stat-card" key={s.label}>
            <span className={`stat-icon ${s.tone}`}>{s.icon}</span>
            <div>
              <span>{s.label}</span>
              <strong>{s.value}</strong>
              <small>{s.note}</small>
            </div>
          </div>
        ))}
      </section>
      <section className="split">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Active complaints</h2>
              <p>Cases currently moving through the resolution workflow.</p>
            </div>
            <button className="text-button">
              View all <ChevronRight />
            </button>
          </div>
          <ComplaintTable state={state} onOpen={onOpen} />
        </div>
        <div className="panel attention">
          <div className="panel-head">
            <div>
              <h2>Needs attention</h2>
              <p>Deadlines and routing exceptions.</p>
            </div>
          </div>
          {m.overdue === 0 && !state.complaints.some((c) => !c.storeId) ? (
            <Empty
              icon={<ShieldCheck />}
              title="Everything is on track"
              body="No overdue or unassigned cases."
            />
          ) : (
            state.complaints
              .filter((c) => c.isAckOverdue || c.isResolutionOverdue || !c.storeId)
              .map((c) => (
                <button className="attention-row" onClick={() => onOpen(c.id)} key={c.id}>
                  <span className="alert-icon">
                    <AlertTriangle />
                  </span>
                  <div>
                    <strong>
                      {!c.storeId
                        ? 'Routing review'
                        : c.isAckOverdue
                          ? 'Manager acknowledgment overdue'
                          : 'Resolution overdue'}
                    </strong>
                    <span>
                      {c.id} · {fmt(c.receivedAt)}
                    </span>
                  </div>
                  <ChevronRight />
                </button>
              ))
          )}
        </div>
      </section>
      <section className="metrics-strip">
        <div>
          <span>Avg. acknowledgment</span>
          <strong>
            {m.avgAckMinutes || '—'}
            <small>{m.avgAckMinutes ? ' min' : ''}</small>
          </strong>
        </div>
        <div>
          <span>Avg. resolution</span>
          <strong>
            {m.avgResolutionHours || '—'}
            <small>{m.avgResolutionHours ? ' hr' : ''}</small>
          </strong>
        </div>
        <div>
          <span>Acknowledgment SLA</span>
          <strong>
            {state.complaints.length
              ? Math.round(
                  (state.complaints.filter((c) => !c.isAckOverdue).length /
                    state.complaints.length) *
                    100,
                )
              : 100}
            <small>%</small>
          </strong>
        </div>
        <div>
          <span>Resolution SLA</span>
          <strong>
            {state.complaints.length
              ? Math.round(
                  (state.complaints.filter((c) => !c.isResolutionOverdue).length /
                    state.complaints.length) *
                    100,
                )
              : 100}
            <small>%</small>
          </strong>
        </div>
      </section>
    </>
  )
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  )
}
function ComplaintTable({ state, onOpen }: { state: AppState; onOpen: (id: string) => void }) {
  if (!state.complaints.length)
    return (
      <Empty
        icon={<FileText />}
        title="No complaints yet"
        body="Use the simulator to create your first case."
      />
    )
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Case</th>
            <th>Store</th>
            <th>Category</th>
            <th>Severity</th>
            <th>Manager</th>
            <th>Status</th>
            <th>Received</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {state.complaints.slice(0, 8).map((c) => {
            const store = state.stores.find((s) => s.id === c.storeId)
            const manager = state.users.find((u) => u.id === c.assignedManagerId)
            return (
              <tr key={c.id} onClick={() => onOpen(c.id)}>
                <td>
                  <strong>{c.id}</strong>
                  <span>{c.externalCaseId}</span>
                </td>
                <td>{store ? `#${store.number}` : <Badge tone="warning">Unassigned</Badge>}</td>
                <td>{c.category}</td>
                <td>
                  <Badge tone={c.severity.toLowerCase()}>{c.severity}</Badge>
                </td>
                <td>{manager?.name ?? '—'}</td>
                <td>
                  <Badge tone={c.isAckOverdue || c.isResolutionOverdue ? 'danger' : 'status'}>
                    {c.isAckOverdue || c.isResolutionOverdue
                      ? 'OVERDUE'
                      : c.status.replaceAll('_', ' ')}
                  </Badge>
                </td>
                <td>{fmt(c.receivedAt)}</td>
                <td>
                  <ChevronRight />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ComplaintList({ state, onOpen }: { state: AppState; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState('ALL')
  const list = useMemo(
    () =>
      state.complaints.filter(
        (c) =>
          (severity === 'ALL' || c.severity === severity) &&
          (c.id + c.subject + c.category).toLowerCase().includes(query.toLowerCase()),
      ),
    [state.complaints, query, severity],
  )
  return (
    <>
      <PageTitle
        eyebrow="Operations"
        title="Complaints"
        body="Track every case from receipt through ownership review."
      />
      <div className="panel">
        <div className="filters">
          <label>
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search complaints"
            />
          </label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="ALL">All severities</option>
            {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <span>{list.length} cases</span>
        </div>
        <ComplaintTable state={{ ...state, complaints: list }} onOpen={onOpen} />
      </div>
    </>
  )
}

function Simulator({
  state,
  onCreate,
}: {
  state: AppState
  onCreate: (input: NewComplaint) => void
}) {
  const [form, setForm] = useState<NewComplaint>({
    externalCaseId: `DKN-${String(state.complaints.length + 1).padStart(3, '0')}`,
    storeNumber: '41001',
    subject: 'Service concern',
    complaintText: 'Customer reports an unhelpful interaction at the counter.',
    category: 'Customer Service',
    severity: 'MEDIUM',
  })
  const load = (f: (typeof fixtures)[number]) =>
    setForm({
      ...form,
      ...f,
      externalCaseId: `DKN-${String(Date.now()).slice(-6)}`,
    } as NewComplaint)
  return (
    <>
      <PageTitle
        eyebrow="Development tool"
        title="Complaint simulator"
        body="Run a realistic complaint through the same domain workflow used by future Gmail ingestion."
      />
      <div className="sim-layout">
        <form
          className="panel form-card"
          onSubmit={(e) => {
            e.preventDefault()
            onCreate(form)
          }}
        >
          <div className="form-section">
            <h2>Incoming Dunkin complaint</h2>
            <p>All fields use fictional development data.</p>
          </div>
          <div className="form-grid">
            <label>
              External case ID
              <input
                required
                value={form.externalCaseId}
                onChange={(e) => setForm({ ...form, externalCaseId: e.target.value })}
              />
            </label>
            <label>
              Store number
              <input
                required
                value={form.storeNumber}
                onChange={(e) => setForm({ ...form, storeNumber: e.target.value })}
              />
            </label>
            <label className="full">
              Subject
              <input
                required
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
            </label>
            <label>
              Category
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {[
                  'Customer Service',
                  'Order Accuracy',
                  'Cleanliness',
                  'Employee Conduct',
                  'Safety',
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              Severity
              <select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}
              >
                {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label className="full">
              Complaint text
              <textarea
                required
                rows={7}
                value={form.complaintText}
                onChange={(e) => setForm({ ...form, complaintText: e.target.value })}
              />
            </label>
          </div>
          <div className="form-actions">
            <span>
              <ShieldCheck /> No external messages will be sent
            </span>
            <button className="primary" type="submit">
              Process complaint <ChevronRight />
            </button>
          </div>
        </form>
        <aside className="fixture-panel">
          <h3>Quick fixtures</h3>
          <p>Load a prepared scenario.</p>
          {fixtures.map((f) => (
            <button key={f.label} onClick={() => load(f)}>
              <span>{f.label}</span>
              <small>
                {f.category} · {f.severity}
              </small>
              <ChevronRight />
            </button>
          ))}
        </aside>
      </div>
    </>
  )
}

function ComplaintDetail({
  complaint: c,
  state,
  onBack,
  onAct,
}: {
  complaint: Complaint
  state: AppState
  onBack: () => void
  onAct: (
    action:
      | 'ACKNOWLEDGE'
      | 'START_INVESTIGATION'
      | 'CONTACT_CUSTOMER'
      | 'SUBMIT_RESOLUTION'
      | 'CLOSE'
      | 'REOPEN',
    data?: Record<string, unknown>,
  ) => void
}) {
  const store = state.stores.find((s) => s.id === c.storeId)
  const manager = state.users.find((u) => u.id === c.assignedManagerId)
  const current = state.users.find((u) => u.id === state.activeUserId)!
  const isManager = current.id === c.assignedManagerId
  const canClose =
    (current.role === 'OWNER' || current.role === 'ADMIN') && c.status === 'RESOLUTION_SUBMITTED'
  const [resolution, setResolution] = useState({
    findings: 'Reviewed the complaint details and spoke with the shift team.',
    correctiveAction: 'Coached the team and reviewed the applicable service standard.',
    resolutionNotes: 'Customer concern addressed and store follow-up completed.',
  })
  return (
    <>
      <button className="back" onClick={onBack}>
        <ArrowLeft />
        All complaints
      </button>
      <div className="detail-title">
        <div>
          <div className="title-badges">
            <Badge tone={c.severity.toLowerCase()}>{c.severity}</Badge>
            <Badge tone={c.isAckOverdue || c.isResolutionOverdue ? 'danger' : 'status'}>
              {c.isAckOverdue || c.isResolutionOverdue ? 'OVERDUE' : c.status.replaceAll('_', ' ')}
            </Badge>
          </div>
          <h1>{c.subject}</h1>
          <p>
            {c.id} · External case {c.externalCaseId}
          </p>
        </div>
        {canClose && (
          <button className="primary" onClick={() => onAct('CLOSE')}>
            <Check />
            Close complaint
          </button>
        )}
      </div>
      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel complaint-copy">
            <span>Customer complaint</span>
            <p>{c.complaintText}</p>
          </section>
          {!c.storeId && (
            <section className="routing-alert">
              <AlertTriangle />
              <div>
                <strong>Manual routing required</strong>
                <span>
                  {c.routingReason}. Ownership should assign this case before manager workflow
                  begins.
                </span>
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Case activity</h2>
                <p>A complete, immutable history of this complaint.</p>
              </div>
            </div>
            <div className="timeline">
              {[...c.events].reverse().map((e, i) => (
                <div className="timeline-row" key={e.id}>
                  <span className={i === 0 ? 'current' : ''}>
                    {e.type === 'COMPLAINT_CLOSED' ? <Check /> : <Clock3 />}
                  </span>
                  <div>
                    <strong>
                      {e.type
                        .replaceAll('_', ' ')
                        .toLowerCase()
                        .replace(/^./, (x) => x.toUpperCase())}
                    </strong>
                    <p>
                      {e.actor} · {fmt(e.timestamp)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {isManager && c.status !== 'CLOSED' && (
            <section className="panel action-card">
              <div className="panel-head">
                <div>
                  <h2>Manager actions</h2>
                  <p>Each step requires an explicit action.</p>
                </div>
              </div>
              {!c.managerAcknowledgedAt ? (
                <button className="primary wide" onClick={() => onAct('ACKNOWLEDGE')}>
                  Acknowledge complaint
                </button>
              ) : !c.investigationStartedAt ? (
                <button className="primary wide" onClick={() => onAct('START_INVESTIGATION')}>
                  Start investigation
                </button>
              ) : !c.customerContacted ? (
                <button
                  className="secondary wide"
                  onClick={() =>
                    onAct('CONTACT_CUSTOMER', {
                      outcome: 'Customer contacted; follow-up discussed.',
                    })
                  }
                >
                  Record customer contact
                </button>
              ) : !c.resolutionSubmittedAt ? (
                <div className="resolution-form">
                  <label>
                    Manager findings
                    <textarea
                      value={resolution.findings}
                      onChange={(e) => setResolution({ ...resolution, findings: e.target.value })}
                    />
                  </label>
                  <label>
                    Corrective action
                    <textarea
                      value={resolution.correctiveAction}
                      onChange={(e) =>
                        setResolution({ ...resolution, correctiveAction: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Resolution notes
                    <textarea
                      value={resolution.resolutionNotes}
                      onChange={(e) =>
                        setResolution({ ...resolution, resolutionNotes: e.target.value })
                      }
                    />
                  </label>
                  <button
                    className="primary"
                    onClick={() => onAct('SUBMIT_RESOLUTION', resolution)}
                  >
                    Submit resolution
                  </button>
                </div>
              ) : (
                <div className="success-box">
                  <Check />
                  Resolution submitted for ownership review.
                </div>
              )}
            </section>
          )}
        </div>
        <aside className="detail-side">
          <section className="panel summary">
            <h3>Case summary</h3>
            <dl>
              <div>
                <dt>Store</dt>
                <dd>{store ? `#${store.number} · ${store.name}` : 'Unassigned'}</dd>
              </div>
              <div>
                <dt>Manager</dt>
                <dd>{manager?.name ?? '—'}</dd>
              </div>
              <div>
                <dt>Category</dt>
                <dd>{c.category}</dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>{fmt(c.receivedAt)}</dd>
              </div>
              <div>
                <dt>Acknowledgment due</dt>
                <dd className={c.isAckOverdue ? 'red-text' : ''}>{fmt(c.ackDeadline)}</dd>
              </div>
              <div>
                <dt>Resolution due</dt>
                <dd>{fmt(c.resolutionDeadline)}</dd>
              </div>
              <div>
                <dt>Routing</dt>
                <dd>
                  {c.routingConfidence} · {c.routingReason}
                </dd>
              </div>
            </dl>
          </section>
          <section className="panel summary">
            <h3>Workflow timestamps</h3>
            <dl>
              {[
                ['Dunkin acknowledged', c.dunkinAcknowledgedAt],
                ['Manager notified', c.managerNotifiedAt],
                ['Manager acknowledged', c.managerAcknowledgedAt],
                ['Investigation started', c.investigationStartedAt],
                ['Resolution submitted', c.resolutionSubmittedAt],
                ['Closed', c.closedAt],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{fmt(v)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="panel notifications">
            <h3>Notification delivery</h3>
            {state.users
              .filter((u) => ['father', 'uncle', 'grandfather', c.assignedManagerId].includes(u.id))
              .map((u) => {
                const n = [...c.notifications].reverse().find((x) => x.recipientUserId === u.id)
                return (
                  <div key={u.id}>
                    <Avatar name={u.name} />
                    <span>
                      <strong>{u.name}</strong>
                      <small>{n?.failureReason ?? n?.provider ?? 'Not created'}</small>
                    </span>
                    <Badge
                      tone={
                        n?.status === 'FAILED'
                          ? 'danger'
                          : n?.status === 'SUPPRESSED'
                            ? 'warning'
                            : 'safe'
                      }
                    >
                      {n?.status ?? 'NONE'}
                    </Badge>
                  </div>
                )
              })}
          </section>
        </aside>
      </div>
    </>
  )
}

function PilotControls({
  state,
  setState,
  onRun,
  providerReady,
  onSaveConfig,
  onSendTest,
  onReconcile,
}: {
  state: AppState
  setState: (s: AppState) => void
  onRun: () => void
  providerReady: boolean
  onSaveConfig: (config: AppState['config']) => void
  onSendTest: (id: 'father' | 'uncle' | 'grandfather' | 'pilot-admin') => void
  onReconcile: (providerMessageId: string) => void
}) {
  const owners = state.users.filter((u) => ['father', 'uncle', 'grandfather'].includes(u.id))
  const pilotAdmin = state.users.find((u) => u.recipientKind === 'PILOT_ADMIN')
  const testRecipients = pilotAdmin ? [...owners, pilotAdmin] : owners
  const [recipient, setRecipient] = useState<'father' | 'uncle' | 'grandfather' | 'pilot-admin'>(
    'pilot-admin',
  )
  const [confirmed, setConfirmed] = useState(false)
  const chosen = testRecipients.find((candidate) => candidate.id === recipient)
  const recentTests = state.testNotifications
    .filter((notification) => notification.recipientUserId === recipient)
    .slice(-3)
    .reverse()
  return (
    <>
      <PageTitle
        eyebrow="Administration"
        title="Pilot controls"
        body="Guardrails for the staged external notification rollout."
      />
      <div className="settings-grid">
        <section className="panel settings-card">
          <h2>Notification safety</h2>
          <label>
            Rollout mode
            <select
              value={state.config.mode}
              onChange={(e) =>
                onSaveConfig({
                  ...state.config,
                  mode: e.target.value as AppState['config']['mode'],
                })
              }
            >
              {['MOCK', 'FAMILY_PILOT', 'SINGLE_STORE_PILOT', 'FULL'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <small>
              MOCK is the safe default. Family pilot allows only configured ownership recipients.
            </small>
          </label>
          <label className="toggle-row">
            <span>
              <strong>External notifications</strong>
              <small>Master backend kill switch</small>
            </span>
            <button
              className={cx('toggle', state.config.externalNotificationsEnabled && 'on')}
              onClick={() =>
                onSaveConfig({
                  ...state.config,
                  externalNotificationsEnabled: !state.config.externalNotificationsEnabled,
                })
              }
            >
              <i />
            </button>
          </label>
          <div className="danger-note">
            <ShieldCheck />
            <span>
              <strong>
                {state.config.externalNotificationsEnabled
                  ? 'External sending eligibility enabled'
                  : 'External communication is blocked'}
              </strong>
              Every attempted message is still independently recorded.
            </span>
          </div>
        </section>
        <section className="panel settings-card">
          <h2>Ownership recipients</h2>
          <p>Contact values live only in D1 and are returned masked.</p>
          {owners.map((owner) => (
            <OwnerContact key={owner.id} owner={owner} onSaved={setState} />
          ))}
        </section>
        <section className="panel settings-card">
          <h2>Controlled test recipient</h2>
          <p>
            This PILOT_ADMIN destination is only for a manual FAMILY_PILOT test. It is never an
            ownership, complaint-fanout, or escalation recipient.
          </p>
          {state.config.mode !== 'FAMILY_PILOT' ? (
            <div className="danger-note">
              <ShieldCheck />
              <span>
                <strong>Unavailable outside FAMILY_PILOT</strong>
                Switch modes before securely configuring this destination.
              </span>
            </div>
          ) : pilotAdmin ? (
            <OwnerContact owner={pilotAdmin} onSaved={setState} />
          ) : (
            <p>PILOT_ADMIN migration is not available.</p>
          )}
        </section>
        <section className="panel settings-card">
          <h2>Deadline test clock</h2>
          <p>
            Advance the effective clock by three days to exercise acknowledgment and resolution
            escalation idempotently.
          </p>
          <button className="secondary" onClick={onRun}>
            <Clock3 />
            Advance 3 days & process
          </button>
        </section>
        <section className="panel settings-card">
          <h2>Test notification</h2>
          <p>
            Select exactly one controlled recipient. PILOT_ADMIN is manual-test-only and can never
            receive complaint or escalation messages.
          </p>
          <select
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value as typeof recipient)
              setConfirmed(false)
            }}
          >
            {testRecipients.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.name} · {candidate.phone}
              </option>
            ))}
          </select>
          <div className="readiness-list">
            <span>
              Rollout mode <strong>{state.config.mode}</strong>
            </span>
            <span>
              External notifications{' '}
              <strong>{state.config.externalNotificationsEnabled ? 'ENABLED' : 'DISABLED'}</strong>
            </span>
            <span>
              SignalWire provider <strong>{providerReady ? 'READY' : 'NOT READY'}</strong>
            </span>
            <span>
              Destination <strong>{chosen?.phone ?? 'Not configured'}</strong>
            </span>
          </div>
          <label className="confirm-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            I confirm one harmless test to {chosen?.name ?? 'the selected recipient'}
          </label>
          <button
            className="secondary"
            disabled={
              !confirmed ||
              !chosen ||
              state.config.mode !== 'FAMILY_PILOT' ||
              !state.config.externalNotificationsEnabled ||
              !providerReady ||
              !chosen.active ||
              !chosen.smsEnabled ||
              !chosen.phone
            }
            onClick={() => {
              onSendTest(recipient)
              setConfirmed(false)
            }}
          >
            Send one confirmed test
          </button>
          <small>
            No manager or send-to-all target exists. The server rechecks every safety gate and
            permanently excludes PILOT_ADMIN from complaint delivery.
          </small>
          {recentTests.length > 0 && (
            <div className="test-results">
              <strong>Recent delivery state</strong>
              {recentTests.map((notification) => (
                <div key={notification.id}>
                  <span>{fmt(notification.createdAt)}</span>
                  <Badge
                    tone={
                      notification.status === 'DELIVERED'
                        ? 'safe'
                        : notification.status === 'FAILED' || notification.status === 'UNDELIVERED'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {notification.status}
                  </Badge>
                  {recipient === 'pilot-admin' &&
                    notification.provider === 'SIGNALWIRE' &&
                    notification.providerMessageId &&
                    state.config.mode === 'FAMILY_PILOT' &&
                    !state.config.externalNotificationsEnabled && (
                      <button
                        className="secondary"
                        onClick={() => onReconcile(notification.providerMessageId!)}
                      >
                        Reconcile provider state
                      </button>
                    )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function OwnerContact({
  owner,
  onSaved,
}: {
  owner: AppState['users'][number]
  onSaved: (state: AppState) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({
    name: owner.name,
    email: '',
    phone: '',
    smsEnabled: owner.smsEnabled,
    active: owner.active,
  })
  if (!editing)
    return (
      <div className="recipient">
        <Avatar name={owner.name} />
        <div>
          <strong>{owner.name}</strong>
          <span>
            {owner.phone} · {owner.email}
          </span>
        </div>
        <Badge tone={owner.smsEnabled ? 'safe' : 'warning'}>
          {owner.smsEnabled ? 'SMS ON' : 'SMS OFF'}
        </Badge>
        <button className="text-button" onClick={() => setEditing(true)}>
          Configure
        </button>
      </div>
    )
  return (
    <div className="contact-editor">
      <label>
        Name
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label>
        New email
        <input
          type="email"
          placeholder="name@example.com"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
      </label>
      <label>
        New phone
        <input
          placeholder="+15551234567"
          value={draft.phone}
          onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.smsEnabled}
          onChange={(e) => setDraft({ ...draft, smsEnabled: e.target.checked })}
        />{' '}
        SMS enabled
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
        />{' '}
        Active
      </label>
      <div>
        <button className="secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button
          className="primary"
          onClick={() =>
            api.updateContact(owner.id, draft).then((state) => {
              onSaved(state)
              setEditing(false)
            })
          }
        >
          Save securely
        </button>
      </div>
    </div>
  )
}

// Phase C — family review queue UI.
// Lists OPEN mail_review_items, shows detail (source message, extraction,
// model signals, disagreement codes), and offers resolve/assign actions.
// Resolve/link never fabricates identity: linking requires an existing
// complaint id; dismissal just closes the item.

import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Inbox, UserPlus, X } from 'lucide-react'
import { api, type ReviewQueueDetail, type ReviewQueueItem } from './lib/api'
import type { User } from './lib/types'

const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const flagsOf = (item: ReviewQueueItem): string[] => {
  const parsed = parseJson(item.disagreement_flags_json)
  return Array.isArray(parsed) ? parsed.map(String) : []
}

// Plain-language translations of review reason codes for family reviewers.
// The codes stay in the database; humans see these.
const REASON_COPY: Record<string, { badge: string; why: string }> = {
  STORE_UNVERIFIED: {
    badge: 'Check the store',
    why: "We couldn't confirm which store this is about — please verify before acting.",
  },
  SEVERITY_MISMATCH: {
    badge: 'Check the urgency',
    why: 'Our read of how urgent this is needs a second look.',
  },
  NEEDS_RUN: {
    badge: 'Not read yet',
    why: "This message hasn't been reviewed by the system yet.",
  },
  STORE_NOT_CONFIGURED: {
    badge: 'Store not set up',
    why: 'The store mentioned here is not in the system.',
  },
  IDENTITY_UNRESOLVED: {
    badge: 'Unknown sender',
    why: "We couldn't tell who sent this.",
  },
}

const plainReason = (code: unknown): string => {
  const key = String(code ?? '')
  return (
    REASON_COPY[key]?.badge ??
    key
      .toLowerCase()
      .split('_')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ')
  )
}

const reasonWhy = (code: unknown): string =>
  REASON_COPY[String(code ?? '')]?.why ?? 'This needs a human to take a look.'

const formatWhen = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return ''
  const d = new Date(String(value))
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function DetailView({
  detail,
  users,
  isAdmin,
  onDone,
  show,
}: {
  detail: ReviewQueueDetail
  users: User[]
  isAdmin: boolean
  onDone: () => void
  show: (message: string) => void
}) {
  const [note, setNote] = useState('')
  const [linkId, setLinkId] = useState('')
  const [assignee, setAssignee] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      show(done)
      onDone()
    } catch (error) {
      show(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }
  const interp = parseJson(detail.interpretation_json) as Record<string, unknown> | null
  const normalized = parseJson(detail.normalized_output_json)
  const evidence = parseJson(detail.deterministic_evidence_json)
  const kv = (label: string, value: unknown) =>
    value === null || value === undefined || value === '' ? null : (
      <div className="kv">
        <span>{label}</span>
        <strong>{String(value)}</strong>
      </div>
    )
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h3>{String(detail.subject ?? '(no subject)')}</h3>
          <span className="muted">
            {String(detail.sender_address ?? '')} · {formatWhen(detail.received_at)}
          </span>
        </div>
        <span className="badge warning">{plainReason(detail.reason_code)}</span>
      </div>
      {typeof interp?.summary === 'string' && interp.summary.trim() !== '' && (
        <p className="review-summary">{String(interp.summary)}</p>
      )}
      <div className="kv-grid">
        <h4>Our read — please verify</h4>
        {kv('Store', interp?.storeNumber)}
        {kv('Category', interp?.issueCategory)}
        {kv('Urgency', interp?.urgency)}
      </div>
      <p className="muted review-why">
        <strong>Why you're seeing this:</strong> {reasonWhy(detail.reason_code)}
      </p>
      {isAdmin && (
        <div className="action-row">
          <input
            placeholder="Resolution note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <input
            placeholder="Link to complaint ID"
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
            disabled={busy}
          />
          <button
            className="primary"
            disabled={busy || !linkId.trim()}
            onClick={() =>
              run(
                () =>
                  api.resolveReviewItem(String(detail.id), {
                    action: 'link',
                    complaintId: linkId.trim(),
                    note: note.trim() || undefined,
                  }),
                'Review item linked',
              )
            }
          >
            <Check size={14} /> Link
          </button>
          <button
            className="secondary danger-btn"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api.resolveReviewItem(String(detail.id), {
                    action: 'dismiss',
                    note: note.trim() || undefined,
                  }),
                'Review item dismissed',
              )
            }
          >
            <X size={14} /> Dismiss
          </button>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={busy}>
            <option value="">Assign to…</option>
            {users
              .filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
          </select>
          <button
            className="primary"
            disabled={busy || !assignee}
            onClick={() => run(() => api.assignReviewItem(String(detail.id), assignee), 'Assigned')}
          >
            <UserPlus size={14} /> Assign
          </button>
        </div>
      )}
      <details className="tech-details">
        <summary>Technical details</summary>
        <div className="kv-grid">
          {kv('Message ID', detail.provider_message_id)}
          {kv('Conversation', detail.conversation_id)}
          {kv('Internet message ID', detail.internet_message_id)}
          {kv('Suggested case ID', interp?.externalCaseId)}
          {kv('Model', detail.interpretation_model)}
          {kv('Model confidence', detail.interpretation_confidence)}
          {kv('Run status', detail.run_status)}
        </div>
        <pre className="json">{JSON.stringify(evidence ?? normalized ?? {}, null, 2)}</pre>
      </details>
    </div>
  )
}

export default function ReviewQueue({
  users,
  isAdmin,
  show,
}: {
  users: User[]
  isAdmin: boolean
  show: (message: string) => void
}) {
  const [items, setItems] = useState<ReviewQueueItem[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<ReviewQueueDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = async () => {
    setLoading(true)
    try {
      const { items } = await api.reviewQueue()
      setItems(items)
      if (selectedId && !items.some((i) => i.id === selectedId)) {
        setSelectedId(undefined)
        setDetail(null)
      }
    } catch (error) {
      show(error instanceof Error ? error.message : 'Failed to load review queue')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const open = async (id: string) => {
    setSelectedId(id)
    try {
      const { item } = await api.reviewItem(id)
      setDetail(item)
    } catch (error) {
      show(error instanceof Error ? error.message : 'Failed to load item')
    }
  }
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>
            <Inbox size={18} /> Review queue
          </h2>
          <p className="muted">
            Mail that needs a human: unidentified senders, model/deterministic disagreements, and
            provisional intakes. Nothing here sends anything.
          </p>
        </div>
        <span className="badge">{items.length} open</span>
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <div className="panel">
          <p className="muted">Queue is clear. No open review items.</p>
        </div>
      ) : (
        <div className="review-layout">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Reason</th>
                  <th>Flags</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => void open(item.id)}
                    className={selectedId === item.id ? 'selected' : ''}
                  >
                    <td>
                      <strong>{item.subject}</strong>
                      <span>{item.sender_address}</span>
                    </td>
                    <td>
                      <span className="badge warning">{plainReason(item.reason_code)}</span>
                    </td>
                    <td>
                      {flagsOf(item).length > 0 ? (
                        <span className="flag-list">
                          <AlertTriangle size={12} /> {flagsOf(item).join(', ')}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{formatWhen(item.received_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail && (
            <DetailView
              detail={detail}
              users={users}
              isAdmin={isAdmin}
              show={show}
              onDone={() => {
                void refresh()
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

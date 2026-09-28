// Phase C — family review queue UI.
// Lists OPEN mail_review_items, shows detail (source message, extraction,
// model signals, disagreement codes), and offers resolve/assign actions.
// Resolve/link never fabricates identity: linking requires an existing
// complaint id; dismissal just closes the item.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Inbox, UserPlus } from 'lucide-react'
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
  const readEntries = (
    [
      ['Store', interp?.storeNumber],
      ['Category', interp?.issueCategory],
      ['Urgency', interp?.urgency],
    ] as [string, unknown][]
  ).filter(([, value]) => value !== null && value !== undefined && value !== '')
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
      <p className="review-why">{reasonWhy(detail.reason_code)}</p>
      {readEntries.length > 0 && (
        <div className="kv-grid">
          <h4>
            Our read <span className="muted">— please verify</span>
          </h4>
          {readEntries.map(([label, value]) => kv(label, value))}
        </div>
      )}
      {isAdmin && (
        <div className="review-actions">
          <input
            placeholder="Add a note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <button
            className="primary wide"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api.resolveReviewItem(String(detail.id), {
                    action: 'dismiss',
                    note: note.trim() || undefined,
                  }),
                'Marked done',
              )
            }
          >
            <Check size={16} /> Mark done
          </button>
          <details className="more-actions">
            <summary>More actions</summary>
            <div className="action-row">
              <input
                placeholder="Link to complaint ID"
                value={linkId}
                onChange={(e) => setLinkId(e.target.value)}
                disabled={busy}
              />
              <button
                className="secondary"
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
                Link to complaint
              </button>
            </div>
            <div className="action-row">
              <select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                disabled={busy}
              >
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
                className="secondary"
                disabled={busy || !assignee}
                onClick={() =>
                  run(() => api.assignReviewItem(String(detail.id), assignee), 'Assigned')
                }
              >
                <UserPlus size={14} /> Assign
              </button>
            </div>
          </details>
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
  const detailRef = useRef<HTMLDivElement>(null)
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
  // On narrow screens the detail renders below the list — bring it into view
  // once it has committed.
  useEffect(() => {
    if (detail && window.matchMedia('(max-width: 1100px)').matches) {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [detail])
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
          <div className="review-list">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => void open(item.id)}
                className={`review-card${selectedId === item.id ? ' selected' : ''}`}
              >
                <span className="review-card-main">
                  <strong>{item.subject}</strong>
                  <span className="muted">
                    {item.sender_address} · {formatWhen(item.received_at)}
                  </span>
                </span>
                <span className="badge warning">{plainReason(item.reason_code)}</span>
                <ChevronRight size={16} className="review-card-chevron" />
              </button>
            ))}
          </div>
          {detail && (
            <div ref={detailRef} className="review-detail-anchor">
              <DetailView
                detail={detail}
                users={users}
                isAdmin={isAdmin}
                show={show}
                onDone={() => {
                  void refresh()
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

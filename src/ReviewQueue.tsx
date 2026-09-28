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
            {String(detail.sender_address ?? '')} · {String(detail.received_at ?? '')}
          </span>
        </div>
        <span className="badge warning">{String(detail.reason_code ?? "")}</span>
      </div>
      <div className="kv-grid">
        {kv('Message ID', detail.provider_message_id)}
        {kv('Conversation', detail.conversation_id)}
        {kv('Internet message ID', detail.internet_message_id)}
        {kv('Model', detail.interpretation_model)}
        {kv('Prompt', detail.interpretation_prompt_version)}
        {kv('Model confidence', detail.interpretation_confidence)}
        {kv('Run status', detail.run_status)}
      </div>
      {interp && typeof interp === 'object' && (
        <div className="kv-grid">
          <h4>Model extraction (review-only — never identity)</h4>
          {kv('Suggested case ID', interp.externalCaseId)}
          {kv('Suggested store', interp.storeNumber)}
          {kv('Category', interp.issueCategory)}
          {kv('Urgency', interp.urgency)}
          {kv('Summary', interp.summary)}
        </div>
      )}
      <div className="kv-grid">
        <h4>Deterministic evidence</h4>
        <pre className="json">{JSON.stringify(evidence ?? normalized ?? {}, null, 2)}</pre>
      </div>
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
                      <span className="badge warning">{item.reason_code}</span>
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
                    <td>{item.received_at}</td>
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

import { useState } from 'react'
import { marked } from 'marked'
import { STATUSES, TYPES, PRIORITIES, type Ticket } from '../../shared/constants.js'

type FormState = Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body'>

type Props = {
  ticket: Ticket | null
  onSave: (data: FormState) => void
  onDelete: (id: string) => void
  onClose: () => void
}

// Create (ticket=null) and edit (ticket=object) share one form. The body is
// Markdown with a live preview toggle.
export default function TicketModal({ ticket, onSave, onDelete, onClose }: Props) {
  const [form, setForm] = useState<FormState>({
    title: ticket?.title ?? '',
    type: ticket?.type ?? 'task',
    priority: ticket?.priority ?? 'medium',
    status: ticket?.status ?? 'backlog',
    body: ticket?.body ?? '',
  })
  const [preview, setPreview] = useState(false)

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return
    onSave(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <input
            className="title-input"
            placeholder="Ticket title"
            value={form.title}
            onChange={set('title')}
            autoFocus
          />

          <div className="row">
            <label>
              Type
              <select value={form.type} onChange={set('type')}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>
              Priority
              <select value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Status
              <select value={form.status} onChange={set('status')}>
                {STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="body-head">
            <span>Description</span>
            <button
              type="button"
              className="link"
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
          </div>

          {preview ? (
            <div
              className="md-preview"
              dangerouslySetInnerHTML={{
                __html: marked.parse(form.body || '_No description_') as string,
              }}
            />
          ) : (
            <textarea
              className="body-input"
              rows={10}
              value={form.body}
              onChange={set('body')}
              placeholder="Markdown supported…"
            />
          )}

          <div className="modal-actions">
            {ticket && (
              <button
                type="button"
                className="btn danger"
                onClick={() => onDelete(ticket.id)}
              >
                Delete
              </button>
            )}
            <div className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              {ticket ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

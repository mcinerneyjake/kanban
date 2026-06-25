import { useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { STATUSES, BOARD_STATUSES, TYPES, PRIORITIES, type Ticket, type StatusId } from '../../shared/constants.js';
import { useRelatedTickets } from '../useRelatedTickets.js';

type FormState = Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>

type Props = {
  ticket: Ticket | null
  allTickets: Ticket[]
  projects: string[]
  assignees: string[]
  onSave: (data: FormState) => void
  onDelete: (id: string) => void
  onOpen: (ticket: Ticket) => void
  onClose: () => void
}

const BOARD_STATUS_SET = new Set<StatusId>(BOARD_STATUSES.map((s) => s.id));

function getDescendantIds(id: string, all: Ticket[]): Set<string> {
  const ids = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const t of all) {
      if (t.parent === cur && !ids.has(t.id)) {
        ids.add(t.id);
        queue.push(t.id);
      }
    }
  }
  return ids;
}

// Create (ticket=null) and edit (ticket=object) share one form. The body is
// Markdown with a live preview toggle.
export default function TicketModal({ ticket, allTickets, projects, assignees, onSave, onDelete, onOpen, onClose }: Props) {
  const [form, setForm] = useState<FormState>({
    title: ticket?.title ?? '',
    type: ticket?.type ?? 'task',
    priority: ticket?.priority ?? 'medium',
    status: ticket?.status ?? 'backlog',
    body: ticket?.body ?? '',
    project: ticket?.project ?? null,
    blockers: (ticket?.blockers ?? []).filter((id) => {
      const t = allTickets.find((bt) => bt.id === id);
      return t && t.status !== 'archived';
    }),
    parent: (() => {
      const id = ticket?.parent ?? null;
      if (!id) return null;
      const p = allTickets.find((t) => t.id === id);
      return p && p.status !== 'archived' ? id : null;
    })(),
    dueDate: ticket?.dueDate ?? null,
    assignee: ticket?.assignee ?? null,
  });
  const [preview, setPreview] = useState(false);
  // Create mode only: live "related tickets" dedup as the title is typed.
  const related = useRelatedTickets(form.title, ticket === null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const setProject = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const project = e.target.value || null;
    setForm((f) => ({
      ...f,
      project,
      // When a specific project is chosen, clear selections that don't belong to it.
      // When clearing back to None, leave existing selections intact.
      blockers: project === null
        ? f.blockers
        : f.blockers.filter((id) => allTickets.find((t) => t.id === id)?.project === project),
      parent: project === null
        ? f.parent
        : (allTickets.find((t) => t.id === f.parent)?.project === project ? f.parent : null),
    }));
  };

  const setParent = (e: React.ChangeEvent<HTMLSelectElement>) =>
    setForm((f) => ({ ...f, parent: e.target.value || null }));

  const addBlocker = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id || form.blockers.includes(id)) return;
    setForm((f) => ({ ...f, blockers: [...f.blockers, id] }));
    e.target.value = '';
  };

  const removeBlocker = (id: string) =>
    setForm((f) => ({ ...f, blockers: f.blockers.filter((b) => b !== id) }));

  // children: direct children only, used for the sub-tickets display section
  // descendantIds: full subtree — excludes all descendants from parent options to prevent cycles
  const children = ticket ? allTickets.filter((t) => t.parent === ticket.id) : [];
  const descendantIds = ticket ? getDescendantIds(ticket.id, allTickets) : new Set<string>();
  const sameProject = (t: Ticket) => form.project === null || t.project === form.project;
  const parentOptions = allTickets.filter(
    (t) =>
      t.id !== ticket?.id &&
      !descendantIds.has(t.id) &&
      BOARD_STATUS_SET.has(t.status) &&
      sameProject(t) &&
      // Always include the current parent so it's visible and clearable, even if done.
      (t.status !== 'done' || t.id === form.parent),
  );

  const availableBlockers = allTickets.filter(
    (t) => t.id !== ticket?.id && !form.blockers.includes(t.id) && t.status !== 'done' && BOARD_STATUS_SET.has(t.status) && sameProject(t),
  );
  const blockerTickets = form.blockers.map((id) => allTickets.find((t) => t.id === id)).filter((t): t is Ticket => t !== undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSave(form);
  };

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

          {/* Dedup: semantic matches as you type a new ticket. Click one to
              edit it instead of creating a duplicate. */}
          {ticket === null && (related.loading || related.matches.length > 0) && (
            <div className="subtasks-section">
              <div className="subtasks-head">
                <span>Related tickets</span>
                {related.loading && <span className="subtasks-count">…</span>}
              </div>
              {related.matches.length > 0 ? (
                <div className="subtask-list">
                  {related.matches.map((m) => {
                    const full = allTickets.find((t) => t.id === m.id);
                    return full ? (
                      <button key={m.id} type="button" className="subtask-item" onClick={() => onOpen(full)}>
                        <span className={`subtask-dot prio-${full.priority}`} />
                        <span className="subtask-title">{m.title}</span>
                        <span className="subtask-status">{Math.round(m.score * 100)}% · {m.status}</span>
                      </button>
                    ) : null;
                  })}
                </div>
              ) : (
                <span className="blockers-empty">Searching…</span>
              )}
            </div>
          )}

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
                {(ticket?.status === 'archived' ? STATUSES : BOARD_STATUSES).map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="row">
            <label className="solo">
              Project
              <select value={form.project ?? ''} onChange={setProject}>
                <option value="">None</option>
                {projects.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="solo">
              Parent ticket
              <select value={form.parent ?? ''} onChange={setParent}>
                <option value="">None</option>
                {parentOptions.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="row">
            <label className="solo">
              Due date
              <input
                type="date"
                value={form.dueDate ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value || null }))}
              />
            </label>
            <label className="solo">
              Assignee
              <input
                type="text"
                list="assignee-suggestions"
                placeholder="Unassigned"
                value={form.assignee ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, assignee: e.target.value.trim() || null }))}
              />
              <datalist id="assignee-suggestions">
                {assignees.map((a) => <option key={a} value={a} />)}
              </datalist>
            </label>
          </div>

          {/* Sub-tickets — only shown when editing an existing ticket that has children */}
          {ticket && children.length > 0 && (
            <div className="subtasks-section">
              <div className="subtasks-head">
                <span>Sub-tickets</span>
                <span className="subtasks-count">{children.length}</span>
              </div>
              <div className="subtask-list">
                {children.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    className="subtask-item"
                    onClick={() => onOpen(child)}
                  >
                    <span className={`subtask-dot prio-${child.priority}`} />
                    <span className="subtask-title">{child.title}</span>
                    <span className="subtask-status">{child.status}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="blockers-section">
            <div className="blockers-head">
              <span>Blockers</span>
              {availableBlockers.length > 0 && (
                <select className="blocker-add-select" onChange={addBlocker} defaultValue="">
                  <option value="" disabled>+ Add blocker</option>
                  {availableBlockers.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              )}
            </div>
            {blockerTickets.length > 0 ? (
              <div className="blocker-tags">
                {blockerTickets.map((t) => (
                  <span key={t.id} className="blocker-tag">
                    {t.title}
                    <button type="button" className="blocker-remove" onClick={() => removeBlocker(t.id)}>×</button>
                  </span>
                ))}
              </div>
            ) : (
              <span className="blockers-empty">None</span>
            )}
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
                __html: DOMPurify.sanitize(String(marked.parse(form.body || '_No description_'))),
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
  );
}

import { useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';
import { STATUSES, BOARD_STATUSES, TYPES, PRIORITIES, type Ticket, type StatusId } from '../../shared/constants.js';
import { useRelatedTickets } from '../useRelatedTickets.js';
import { relatedStripState } from '../lib/relatedStripState.js';
import { proposalToPrefill, proposalTargetId, type Prefill } from '../lib/proposalPrefill.js';
import Spinner from './Spinner.js';

type FormState = Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>

type Props = {
  ticket: Ticket | null
  allTickets: Ticket[]
  projects: string[]
  assignees: string[]
  onSave: (data: FormState) => void
  onDelete: (id: string) => void
  onOpen: (ticket: Ticket, initial?: Prefill) => void
  onClose: () => void
  initial?: Prefill
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
export default function TicketModal({ ticket, initial, allTickets, projects, assignees, onSave, onDelete, onOpen, onClose }: Props) {
  const [form, setForm] = useState<FormState>({
    title: initial?.title ?? ticket?.title ?? '',
    type: initial?.type ?? ticket?.type ?? 'task',
    priority: initial?.priority ?? ticket?.priority ?? 'medium',
    status: initial?.status ?? ticket?.status ?? 'backlog',
    body: initial?.body ?? ticket?.body ?? '',
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
  const relatedState = relatedStripState(related.matches.length > 0, related.loading, related.error);

  // Create mode: the AI "draft from a note" step is the primary create path. We
  // probe the chat model on open; when it isn't running we fall back to the
  // manual form. A successful draft fills the form for review.
  const [note, setNote] = useState('');
  const [draftPhase, setDraftPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [drafted, setDrafted] = useState(false);
  const [noProposal, setNoProposal] = useState(false);
  const [updateSuggestion, setUpdateSuggestion] = useState<{ ticket: Ticket; prefill: Prefill } | null>(null);
  const [modelStatus, setModelStatus] = useState<'checking' | 'up' | 'down'>(ticket === null ? 'checking' : 'up');

  useEffect(() => {
    if (ticket !== null) return;
    let alive = true;
    api.intake.health()
      .then((h) => { if (alive) setModelStatus(h.available ? 'up' : 'down'); })
      .catch(() => { if (alive) setModelStatus('down'); });
    return () => { alive = false; };
  }, [ticket]);

  const draft = async () => {
    if (!note.trim()) return;
    setDraftPhase('loading');
    setNoProposal(false);
    setUpdateSuggestion(null);
    try {
      const result = await api.intake.propose(note.trim());
      const proposal = result.proposal;
      if (!proposal) { setNoProposal(true); setDraftPhase('idle'); return; }
      const prefill = proposalToPrefill(proposal.args);
      const targetId = proposalTargetId(proposal);
      const target = targetId ? allTickets.find((t) => t.id === targetId) : undefined;
      if (target) {
        setUpdateSuggestion({ ticket: target, prefill });
      } else {
        setForm((f) => ({ ...f, ...prefill }));
        setDrafted(true);
      }
      setDraftPhase('idle');
    } catch {
      setDraftPhase('error');
    }
  };

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

  // Create flow has three faces: probing the model, the draft-from-note step
  // (model up), and the editable form (model down, or after a successful draft).
  const showChecking = ticket === null && modelStatus === 'checking' && !drafted;
  const showDraftPanel = ticket === null && modelStatus === 'up' && !drafted;
  const showForm = ticket !== null || modelStatus === 'down' || drafted;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${showForm ? '' : ' modal--draft'}`} onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          {showChecking && (
            <div className="draft-checking">
              <Spinner />
              <span>Checking for the drafting model…</span>
              <button type="button" className="link" onClick={onClose}>Cancel</button>
            </div>
          )}

          {showDraftPanel && (
            <section className="draft-panel">
              <div className="draft-head">✨ Draft from a note</div>
              <textarea
                className="draft-input"
                placeholder="Describe it here — the agent drafts a ticket for this board…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
              />
              {draftPhase === 'error' && (
                <p className="draft-error">
                  Couldn't draft a ticket — is the model running?{' '}
                  <button type="button" className="link" onClick={() => setModelStatus('down')}>Enter manually</button>
                </p>
              )}
              {noProposal && (
                <div className="draft-notice">
                  <span>
                    The agent didn't suggest a ticket — add more detail and try again, or{' '}
                    <button type="button" className="link" onClick={() => setModelStatus('down')}>enter manually</button>.
                  </span>
                </div>
              )}
              {updateSuggestion && (
                <div className="draft-notice">
                  <span>Looks like this updates an existing ticket: <strong>“{updateSuggestion.ticket.title}”</strong>.</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpen(updateSuggestion.ticket, updateSuggestion.prefill)}
                  >
                    Open &amp; apply →
                  </button>
                </div>
              )}
              <div className="draft-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void draft()}
                  disabled={draftPhase === 'loading' || note.trim() === ''}
                >
                  {draftPhase === 'loading' ? <span>Drafting…</span> : 'Draft ticket'}
                </button>
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
              </div>
            </section>
          )}

          {showForm && (
          <>
          <input
            className="title-input"
            placeholder="Ticket title"
            value={form.title}
            onChange={set('title')}
            autoFocus
          />

          {/* Dedup: semantic matches as you type a new ticket. Click one to
              edit it instead of creating a duplicate. */}
          {relatedState !== 'hidden' && (
            <div className="subtasks-section">
              {relatedState === 'list' ? (
                <>
                  <div className="subtasks-head">
                    <span>Related tickets</span>
                    {related.loading && <Spinner />}
                  </div>
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
                </>
              ) : relatedState === 'searching' ? (
                <div className="subtasks-head">
                  <Spinner />
                  <span>Searching related tickets…</span>
                </div>
              ) : (
                <div className="subtasks-head">
                  <span>Couldn't search related tickets — is the model running?</span>
                </div>
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
          </>
          )}
        </form>
      </div>
    </div>
  );
}

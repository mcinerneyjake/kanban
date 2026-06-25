import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api, type IntakeProposal } from './api.js';
import Board from './components/Board.jsx';
import ArchiveLane from './components/ArchiveLane.jsx';
import TicketModal from './components/TicketModal.jsx';
import TriageModal from './components/TriageModal.jsx';
import FilterPopover, { type FilterState } from './components/FilterPopover.jsx';
import { encode, decode } from './lib/filterParams.js';
import { proposalToPrefill, proposalTargetId, type Prefill } from './lib/proposalPrefill.js';
import { computeChildCounts } from './lib/childCounts.js';
import { useTheme } from './useTheme.js';
import type { Ticket } from '../shared/constants.js';

// Single source of UI state. Tickets are reloaded from the server after every
// mutation (the files are the source of truth), except drag-moves which apply
// optimistically for snappy reordering.
export default function App() {
  const { theme, toggle } = useTheme();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null);
  // Optional agent-triage prefill carried into the create/edit modal.
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [filter, setFilter] = useState<FilterState>(() => decode(new URLSearchParams(location.search)));
  const [showArchive, setShowArchive] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const params = encode(filter);
    const search = params.toString();
    history.replaceState(null, '', search ? `?${search}` : location.pathname);
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    api.list().then(setTickets).catch((e: Error) => setError(e.message));
  }, []);

  const projects = useMemo(
    () => [...new Set(tickets.map((t) => t.project).filter((p): p is string => Boolean(p)))].sort(),
    [tickets],
  );

  const assignees = useMemo(
    () => [...new Set(tickets.map((t) => t.assignee).filter((a): a is string => Boolean(a)))].sort(),
    [tickets],
  );

  const archivedTickets = useMemo(() => tickets.filter((t) => t.status === 'archived'), [tickets]);

  const filteredTickets = useMemo(() => {
    let result = tickets.filter((t) => t.status !== 'archived');
    if (filter.types.length > 0) result = result.filter((t) => filter.types.includes(t.type));
    if (filter.priority) result = result.filter((t) => t.priority === filter.priority);
    if (filter.project) result = result.filter((t) => t.project === filter.project);
    if (filter.assignee) result = result.filter((t) => t.assignee === filter.assignee);
    if (filter.dateFrom || filter.dateTo) {
      result = result.filter((t) => {
        const d = t[filter.dateField].slice(0, 10);
        if (filter.dateFrom && d < filter.dateFrom) return false;
        if (filter.dateTo && d > filter.dateTo) return false;
        return true;
      });
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (t) => t.title.toLowerCase().includes(term) || t.body.toLowerCase().includes(term),
      );
    }
    return result;
  }, [tickets, filter, searchTerm]);

  // Keyed by parent id → sub-ticket count shown on the card, computed from all
  // tickets (not filtered). Done children drop off an open parent's count;
  // a done parent shows its full original count. See computeChildCounts.
  const childCounts = useMemo(() => computeChildCounts(tickets), [tickets]);

  // ticketsRef lets stable callbacks read the current ticket list without listing
  // tickets as a dependency. Synced in an effect (not during render) so the ref is
  // current before any user interaction fires.
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);

  useEffect(() => {
    load();
  }, [load]);

  // Open the modal — create ('new') or edit (a ticket) — with an optional prefill
  // (the agent's triage proposal). Always (re)sets prefill so a normal open never
  // inherits a stale one.
  const openTicket = useCallback((target: Ticket | 'new', initial: Prefill | null = null) => {
    setPrefill(initial);
    setEditing(target);
  }, []);

  const closeTicket = useCallback(() => {
    setEditing(null);
    setPrefill(null);
  }, []);

  const handleTriageApprove = useCallback((proposal: IntakeProposal) => {
    setTriaging(false);
    const id = proposalTargetId(proposal);
    const target = id ? ticketsRef.current.find((t) => t.id === id) : undefined;
    openTicket(target ?? 'new', proposalToPrefill(proposal.args));
  }, [openTicket]);

  const handleSave = useCallback(async (data: Partial<Ticket>) => {
    try {
      if (editing === 'new') await api.create(data);
      else if (editing) await api.update(editing.id, data);
      closeTicket();
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [editing, load, closeTicket]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.remove(id);
      closeTicket();
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [load, closeTicket]);

  const handleReparent = useCallback(async (id: string, newParentId: string) => {
    if (id === newParentId) return;
    // Guard against cycles: reject if newParentId is a descendant of id.
    const current = ticketsRef.current;
    const descendants = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === undefined) break;
      for (const t of current) {
        if (t.parent === cur && !descendants.has(t.id)) {
          descendants.add(t.id);
          queue.push(t.id);
        }
      }
    }
    if (descendants.has(newParentId)) return;
    const originalParent = current.find((t) => t.id === id)?.parent ?? null;
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, parent: newParentId } : t)));
    try {
      await api.update(id, { parent: newParentId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, parent: originalParent } : t)));
    }
  }, []);

  const handleArchiveAll = useCallback(async () => {
    const doneTickets = ticketsRef.current.filter((t) => t.status === 'done');
    try {
      await Promise.all(doneTickets.map((t) => api.update(t.id, { status: 'archived' })));
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); load(); }
  }, [load]);

  // Optimistic move: patch local state first, persist, reload on failure.
  const handleMove = useCallback(async (id: string, status: Ticket['status'], order: number) => {
    setTickets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status, order } : t)));
    try {
      await api.update(id, { status, order });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [load]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Kanban</h1>
        <div className="topbar-actions">
          <button className="theme-toggle" onClick={toggle} title="Toggle theme">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <input
            className="search-input"
            type="search"
            placeholder="Search tickets…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <FilterPopover filter={filter} projects={projects} assignees={assignees} onChange={setFilter} />
          <button className="btn" onClick={() => setTriaging(true)} title="Let the agent triage a report into a ticket">
            ✨ Triage
          </button>
          <button className="btn primary" onClick={() => openTicket('new')}>
            + New ticket
          </button>
        </div>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error} — click to dismiss
        </div>
      )}

      <Board tickets={filteredTickets} sort={filter.sort} childCounts={childCounts} onMove={handleMove} onReparent={handleReparent} onOpen={openTicket} onArchiveAll={handleArchiveAll} />
      <ArchiveLane tickets={archivedTickets} show={showArchive} onToggle={() => setShowArchive((v) => !v)} onOpen={openTicket} />

      {triaging && (
        <TriageModal onApprove={handleTriageApprove} onClose={() => setTriaging(false)} />
      )}

      {editing && (
        <TicketModal
          key={editing === 'new' ? 'new' : editing.id}
          ticket={editing === 'new' ? null : editing}
          initial={prefill ?? undefined}
          allTickets={tickets}
          projects={projects}
          assignees={assignees}
          onSave={handleSave}
          onDelete={handleDelete}
          onOpen={openTicket}
          onClose={closeTicket}
        />
      )}
    </div>
  );
}

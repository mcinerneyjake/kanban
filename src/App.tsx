import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api } from './api.js';
import Board from './components/Board.jsx';
import ArchiveLane from './components/ArchiveLane.jsx';
import TicketModal from './components/TicketModal.jsx';
import FilterPopover, { type FilterState } from './components/FilterPopover.jsx';
import { encode, decode } from './lib/filterParams.js';
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

  // Derived from tickets already in state — avoids a separate /api/projects
  // HTTP round-trip and a second full filesystem scan on every board refresh.
  const projects = useMemo(
    () => [...new Set(tickets.map((t) => t.project).filter((p): p is string => Boolean(p)))].sort(),
    [tickets],
  );

  const archivedTickets = useMemo(() => tickets.filter((t) => t.status === 'archived'), [tickets]);

  const filteredTickets = useMemo(() => {
    let result = tickets.filter((t) => t.status !== 'archived');
    if (filter.types.length > 0) result = result.filter((t) => filter.types.includes(t.type));
    if (filter.priority) result = result.filter((t) => t.priority === filter.priority);
    if (filter.project) result = result.filter((t) => t.project === filter.project);
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

  // Keyed by parent id → count of children, computed from all tickets (not filtered)
  const childCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tickets) {
      if (t.parent) counts[t.parent] = (counts[t.parent] ?? 0) + 1;
    }
    return counts;
  }, [tickets]);

  // ticketsRef lets handleReparent read the current ticket list for cycle
  // detection without listing tickets as a dependency — keeping the callback
  // stable so Card's memo is not busted on every board mutation. Synced in an
  // effect (not during render) to satisfy the react-hooks/refs lint rule; the
  // effect always commits before the browser paints so the ref is current by
  // the time any user interaction fires.
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);

  useEffect(() => {
    load();
  }, [load]);

  // editing is listed as a dep here because handleSave is only passed to
  // TicketModal, which already remounts (via key) whenever editing changes —
  // so re-creating this callback on editing change causes no extra renders.
  const handleSave = useCallback(async (data: Partial<Ticket>) => {
    try {
      if (editing === 'new') await api.create(data);
      else if (editing) await api.update(editing.id, data);
      setEditing(null);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [editing, load]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.remove(id);
      setEditing(null);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [load]);

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
    const doneTickets = filteredTickets.filter((t) => t.status === 'done');
    try {
      await Promise.all(doneTickets.map((t) => api.update(t.id, { status: 'archived' })));
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [filteredTickets, load]);

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
          <FilterPopover filter={filter} projects={projects} onChange={setFilter} />
          <button className="btn primary" onClick={() => setEditing('new')}>
            + New ticket
          </button>
        </div>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error} — click to dismiss
        </div>
      )}

      <Board tickets={filteredTickets} sort={filter.sort} childCounts={childCounts} onMove={handleMove} onReparent={handleReparent} onOpen={setEditing} onArchiveAll={handleArchiveAll} />
      <ArchiveLane tickets={archivedTickets} show={showArchive} onToggle={() => setShowArchive((v) => !v)} onOpen={setEditing} />

      {editing && (
        <TicketModal
          key={editing === 'new' ? 'new' : editing.id}
          ticket={editing === 'new' ? null : editing}
          allTickets={tickets}
          projects={projects}
          onSave={handleSave}
          onDelete={handleDelete}
          onOpen={setEditing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

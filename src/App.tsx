import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api } from './api.js';
import Board from './components/Board.jsx';
import Dashboard from './components/Dashboard.jsx';
import Sidebar, { type View } from './components/Sidebar.jsx';
import ArchiveLane from './components/ArchiveLane.jsx';
import TicketModal from './components/TicketModal.jsx';
import FilterPopover, { type FilterState } from './components/FilterPopover.jsx';
import DashboardConfigPopover from './components/DashboardConfigPopover.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { encode, decode } from './lib/filterParams.js';
import { type Prefill } from './lib/proposalPrefill.js';
import { computeChildCounts } from './lib/childCounts.js';
import { computeActiveBlockerCounts } from './lib/blockers.js';
import { resolveTicket } from './lib/resolveTicket.js';
import { useTheme } from './useTheme.js';
import { useDashboardConfig } from './useDashboardConfig.js';
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
  const [filter, setFilter] = useState<FilterState>(() => decode(new URLSearchParams(location.search)));
  const [showArchive, setShowArchive] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [view, setView] = useState<View>('board');
  const dash = useDashboardConfig();
  // Bumped on every ticket reload so the dashboard re-fetches its aggregates.
  const [refreshKey, setRefreshKey] = useState(0);

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
    api.list()
      .then((t) => { setTickets(t); setRefreshKey((k) => k + 1); })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Suppress the echo of our OWN writes: a local mutation persists to a file,
  // chokidar sees it, and the server broadcasts `refresh` back ~100ms later.
  // Reloading on that echo would clobber the optimistic drag/reparent state
  // (which skips reloading on success by design), so mute refresh-driven reloads
  // briefly after each local write. Genuinely external changes (Claude / the MCP
  // process) land outside this window and still refresh instantly.
  const muteRefreshUntil = useRef(0);
  const markLocalWrite = useCallback(() => { muteRefreshUntil.current = Date.now() + 500; }, []);

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

  // Keyed by ticket id → count of *active* blockers behind the ⛔ card badge.
  // Computed from all tickets (not filtered) so a blocker in a hidden column
  // still counts; done/archived/dangling blockers drop off. See computeActiveBlockerCounts.
  const activeBlockerCounts = useMemo(() => computeActiveBlockerCounts(tickets), [tickets]);

  // ticketsRef lets stable callbacks read the current ticket list without listing
  // tickets as a dependency. Synced in an effect (not during render) so the ref is
  // current before any user interaction fires.
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);

  useEffect(() => {
    load();
  }, [load]);

  // Live board sync: the server broadcasts a bare `refresh` over SSE whenever a
  // ticket file changes (API, direct edit, or the separate MCP process). load()
  // re-syncs the board and the dashboard aggregates.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    // Skip refreshes that are the echo of our own just-persisted write (see
    // markLocalWrite) so they don't clobber optimistic state.
    const onRefresh = () => { if (Date.now() >= muteRefreshUntil.current) load(); };
    // The initial connect is already covered by the mount load(); only refetch
    // on a genuine RE-connect, to catch changes missed while disconnected
    // (EventSource auto-reconnects but does not replay events).
    let connectedOnce = false;
    const onOpen = () => {
      if (!connectedOnce) { connectedOnce = true; return; }
      load();
    };
    es.addEventListener('refresh', onRefresh);
    es.addEventListener('open', onOpen);
    return () => {
      es.removeEventListener('refresh', onRefresh);
      es.removeEventListener('open', onOpen);
      es.close();
    };
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

  // Navigating between views (board ↔ dashboard) closes any open modal — an
  // edit/create modal is scoped to the view it was opened from and should not
  // linger over a different view. Wrapping setView keeps this tied to the
  // navigation action itself rather than a reactive effect.
  const handleViewChange = useCallback((next: View) => {
    setView(next);
    closeTicket();
  }, [closeTicket]);

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
    markLocalWrite();
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, parent: newParentId } : t)));
    try {
      await api.update(id, { parent: newParentId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, parent: originalParent } : t)));
    }
  }, [markLocalWrite]);

  const handleArchiveAll = useCallback(async () => {
    const doneTickets = ticketsRef.current.filter((t) => t.status === 'done');
    try {
      await Promise.all(doneTickets.map((t) => api.update(t.id, { status: 'archived' })));
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); load(); }
  }, [load]);

  // Optimistic move: patch local state first, persist, reload on failure.
  const handleMove = useCallback(async (id: string, status: Ticket['status'], order: number) => {
    markLocalWrite();
    setTickets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status, order } : t)));
    try {
      await api.update(id, { status, order });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [load, markLocalWrite]);

  return (
    <div className="layout">
      <Sidebar
        view={view}
        onViewChange={handleViewChange}
        theme={theme}
        onToggleTheme={toggle}
      />

      <div className="app">
        <header className="topbar">
          <h1>Kanban</h1>
          <div className="topbar-actions">
            {view === 'board' ? (
              <>
                <input
                  className="search-input"
                  type="search"
                  placeholder="Search tickets…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <FilterPopover filter={filter} projects={projects} assignees={assignees} onChange={setFilter} />
              </>
            ) : (
              <DashboardConfigPopover projects={projects} dash={dash} />
            )}
            <button className="btn primary" onClick={() => openTicket('new')}>
              + New ticket
            </button>
          </div>
        </header>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {view === 'board' ? (
          <>
            <Board tickets={filteredTickets} sort={filter.sort} childCounts={childCounts} activeBlockerCounts={activeBlockerCounts} onMove={handleMove} onReparent={handleReparent} onOpen={openTicket} onArchiveAll={handleArchiveAll} />
            <ArchiveLane tickets={archivedTickets} activeBlockerCounts={activeBlockerCounts} show={showArchive} onToggle={() => setShowArchive((v) => !v)} onOpen={openTicket} />
          </>
        ) : (
          <Dashboard
            project={dash.project}
            visible={dash.visible}
            autoRefresh={dash.autoRefresh}
            refreshKey={refreshKey}
            onOpen={(id) => {
              // The dashboard can surface tickets (via polling/project filter)
              // that aren't in App's list yet, so fall back to a fetch rather
              // than dead-clicking when the id isn't found locally.
              resolveTicket(id, ticketsRef.current, api.get)
                .then(openTicket)
                .catch((e) => setError(e instanceof Error ? e.message : String(e)));
            }}
          />
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
    </div>
  );
}

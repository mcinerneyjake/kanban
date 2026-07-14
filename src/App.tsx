import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { api } from './api.js';
import Board from './components/Board.jsx';
import Dashboard from './components/Dashboard.jsx';
import EconomicsDashboard from './components/EconomicsDashboard.jsx';
import EconomicsRunDetail from './components/EconomicsRunDetail.jsx';
import Sidebar, { type View } from './components/Sidebar.jsx';
import ArchiveLane from './components/ArchiveLane.jsx';
import TicketModal from './components/TicketModal.jsx';
import FilterPopover, { type FilterState } from './components/FilterPopover.jsx';
import DashboardConfigPopover from './components/DashboardConfigPopover.jsx';
import ErrorBanner from './components/ui/ErrorBanner.jsx';
import { encode, decode } from './lib/filterParams.js';
import { type Prefill } from './lib/proposalPrefill.js';
import { computeChildCounts } from './lib/childCounts.js';
import { computeActiveBlockerCounts } from './lib/blockers.js';
import { resolveTicket } from './lib/resolveTicket.js';
import { useTheme } from './useTheme.js';
import { useDashboardConfig } from './useDashboardConfig.js';
import type { Ticket } from '../shared/constants.js';

export default function App() {
  const { theme, toggle } = useTheme();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  // Non-null → Save routes through intake-apply (provenance + metering), not the human route.
  const [draftRunId, setDraftRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>(() => decode(new URLSearchParams(location.search)));
  const [showArchive, setShowArchive] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  // Ephemeral peek from the ticket editor — no URL coupling; reload won't reopen it.
  const [runId, setRunId] = useState<string | null>(null);
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

  // Mute refresh-driven reloads briefly after a local write so the chokidar echo can't clobber optimistic drag state; external changes land outside the window.
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

  // parent id → sub-ticket count, from all tickets not filtered (see computeChildCounts).
  const childCounts = useMemo(() => computeChildCounts(tickets), [tickets]);

  // ticket id → active blocker count; from all tickets so hidden-column blockers still count (see computeActiveBlockerCounts).
  const activeBlockerCounts = useMemo(() => computeActiveBlockerCounts(tickets), [tickets]);

  // Lets stable callbacks read current tickets without a dep; synced in an effect, not during render.
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);

  useEffect(() => {
    load();
  }, [load]);

  // Live board sync: server broadcasts a bare `refresh` over SSE on any ticket-file change.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    // Skip the echo of our own write (see markLocalWrite).
    const onRefresh = () => { if (Date.now() >= muteRefreshUntil.current) load(); };
    // Only refetch on a genuine RE-connect (mount load covers first connect); EventSource doesn't replay missed events.
    let connectedOnce = false;
    const onOpen = () => {
      if (!connectedOnce) { connectedOnce = true; return; }
      load();
    };
    // CLOSED = permanent failure (no auto-reconnect); log so a dead stream is diagnosable.
    const onError = () => {
      if (es.readyState === EventSource.CLOSED)
        console.warn('[sse] live updates unavailable — the event stream is closed and will not reconnect');
    };
    es.addEventListener('refresh', onRefresh);
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    return () => {
      es.removeEventListener('refresh', onRefresh);
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.close();
    };
  }, [load]);

  // Always (re)sets prefill so a normal open doesn't inherit a stale one.
  const openTicket = useCallback((target: Ticket | 'new', initial: Prefill | null = null, runId: string | null = null) => {
    setPrefill(initial);
    setDraftRunId(runId);
    setEditing(target);
  }, []);

  const closeTicket = useCallback(() => {
    setEditing(null);
    setPrefill(null);
    setDraftRunId(null);
  }, []);

  // Nav between views closes any open modal (scoped to the view it opened from).
  const handleViewChange = useCallback((next: View) => {
    setView(next);
    // Sidebar sits above the backdrop, so a nav must dismiss open overlays itself.
    closeTicket();
    setRunId(null);
  }, [closeTicket]);

  // Stacks over the ticket editor (a peek); closing returns to it with edits intact.
  const openRun = useCallback((rid: string) => {
    setRunId(rid);
  }, []);

  // Ids from the dashboard/run lists may not be in the current list — fall back to a fetch (see resolveTicket).
  const openTicketById = useCallback((id: string) => {
    resolveTicket(id, ticketsRef.current, api.get)
      .then(openTicket)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [openTicket]);

  const handleSave = useCallback(async (data: Partial<Ticket>, runId?: string) => {
    const target = editing !== 'new' ? editing : null;
    try {
      if (runId) {
        // Agent draft: apply via provenance/metering endpoint (🤖 Assisted badge + run link).
        await api.intake.apply({
          action: target ? 'update_ticket' : 'create_ticket',
          runId,
          args: target ? { ...data, id: target.id } : data,
        });
      } else if (target) await api.update(target.id, data);
      else await api.create(data);
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
    // Guard cycles: reject if newParentId is a descendant of id.
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
            ) : view === 'dashboard' ? (
              <DashboardConfigPopover projects={projects} dash={dash} />
            ) : null}
            <button className="btn primary" onClick={() => openTicket('new')}>
              + New ticket
            </button>
          </div>
        </header>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {view === 'board' ? (
          <>
            <Board tickets={filteredTickets} allTickets={tickets} sort={filter.sort} childCounts={childCounts} activeBlockerCounts={activeBlockerCounts} onMove={handleMove} onReparent={handleReparent} onOpen={openTicket} onArchiveAll={handleArchiveAll} />
            <ArchiveLane tickets={archivedTickets} activeBlockerCounts={activeBlockerCounts} show={showArchive} onToggle={() => setShowArchive((v) => !v)} onOpen={openTicket} />
          </>
        ) : view === 'economics' ? (
          <EconomicsDashboard refreshKey={refreshKey} />
        ) : (
          <Dashboard
            project={dash.project}
            visible={dash.visible}
            autoRefresh={dash.autoRefresh}
            refreshKey={refreshKey}
            onOpen={openTicketById}
          />
        )}

        {editing && (
          <TicketModal
            key={editing === 'new' ? 'new' : editing.id}
            ticket={editing === 'new' ? null : editing}
            initial={prefill ?? undefined}
            initialRunId={draftRunId ?? undefined}
            allTickets={tickets}
            projects={projects}
            assignees={assignees}
            onSave={handleSave}
            onDelete={handleDelete}
            onOpen={openTicket}
            onOpenRun={openRun}
            onClose={closeTicket}
          />
        )}

        {/* Single-run economics peek, stacked over the ticket editor. */}
        {runId && (
          <EconomicsRunDetail
            runId={runId}
            onClose={() => setRunId(null)}
            // Close this peek as the ticket opens so the two don't stack.
            onOpen={(id) => { setRunId(null); openTicketById(id); }}
          />
        )}
      </div>
    </div>
  );
}

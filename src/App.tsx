import { useEffect, useState, useCallback, useMemo } from 'react'
import { api } from './api.js'
import Board from './components/Board.jsx'
import ArchiveLane from './components/ArchiveLane.jsx'
import TicketModal from './components/TicketModal.jsx'
import FilterPopover, { defaultFilter, type FilterState } from './components/FilterPopover.jsx'
import { useTheme } from './useTheme.js'
import type { Ticket } from '../shared/constants.js'

// Single source of UI state. Tickets are reloaded from the server after every
// mutation (the files are the source of truth), except drag-moves which apply
// optimistically for snappy reordering.
export default function App() {
  const { theme, toggle } = useTheme()
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null)
  const [filter, setFilter] = useState<FilterState>(defaultFilter)
  const [showArchive, setShowArchive] = useState(false)

  const [projects, setProjects] = useState<string[]>([])

  const load = useCallback(() => {
    api.list().then(setTickets).catch((e: Error) => setError(e.message))
    api.projects().then(setProjects).catch(() => {})
  }, [])

  const archivedTickets = useMemo(() => tickets.filter((t) => t.status === 'archived'), [tickets])

  const filteredTickets = useMemo(() => {
    let result = tickets.filter((t) => t.status !== 'archived')
    if (filter.types.length > 0) result = result.filter((t) => filter.types.includes(t.type))
    if (filter.priority) result = result.filter((t) => t.priority === filter.priority)
    if (filter.project) result = result.filter((t) => t.project === filter.project)
    if (filter.dateFrom || filter.dateTo) {
      result = result.filter((t) => {
        const d = t[filter.dateField].slice(0, 10)
        if (filter.dateFrom && d < filter.dateFrom) return false
        if (filter.dateTo && d > filter.dateTo) return false
        return true
      })
    }
    return result
  }, [tickets, filter])

  // Keyed by parent id → count of children, computed from all tickets (not filtered)
  const childCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of tickets) {
      if (t.parent) counts[t.parent] = (counts[t.parent] ?? 0) + 1
    }
    return counts
  }, [tickets])

  useEffect(() => {
    load()
  }, [load])

  const handleSave = async (data: Partial<Ticket>) => {
    try {
      if (editing === 'new') await api.create(data)
      else if (editing) await api.update(editing.id, data)
      setEditing(null)
      load()
    } catch (e) { setError((e as Error).message) }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.remove(id)
      setEditing(null)
      load()
    } catch (e) { setError((e as Error).message) }
  }

  const handleReparent = async (id: string, newParentId: string) => {
    if (id === newParentId) return
    // Guard against cycles: reject if newParentId is a descendant of id.
    const descendants = new Set<string>()
    const queue = [id]
    while (queue.length) {
      const cur = queue.shift()!
      for (const t of tickets) {
        if (t.parent === cur && !descendants.has(t.id)) {
          descendants.add(t.id)
          queue.push(t.id)
        }
      }
    }
    if (descendants.has(newParentId)) return
    try {
      await api.update(id, { parent: newParentId })
      load()
    } catch (e) { setError((e as Error).message) }
  }

  // Optimistic move: patch local state first, persist, reload on failure.
  const handleMove = async (id: string, status: Ticket['status'], order: number) => {
    setTickets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status, order } : t)))
    try {
      await api.update(id, { status, order })
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Kanban</h1>
        <div className="topbar-actions">
          <button className="theme-toggle" onClick={toggle} title="Toggle theme">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
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
      <Board tickets={filteredTickets} sort={filter.sort} childCounts={childCounts} onMove={handleMove} onReparent={handleReparent} onOpen={setEditing} />
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
  )
}

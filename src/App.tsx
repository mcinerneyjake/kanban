import { useEffect, useState, useCallback } from 'react'
import { api } from './api.js'
import Board from './components/Board.jsx'
import TicketModal from './components/TicketModal.jsx'
import type { Ticket } from '../shared/constants.js'

// Single source of UI state. Tickets are reloaded from the server after every
// mutation (the files are the source of truth), except drag-moves which apply
// optimistically for snappy reordering.
export default function App() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Ticket | 'new' | null>(null)

  const load = useCallback(() => {
    api.list().then(setTickets).catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

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
        <button className="btn primary" onClick={() => setEditing('new')}>
          + New ticket
        </button>
      </header>

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error} — click to dismiss
        </div>
      )}

      <Board tickets={tickets} onMove={handleMove} onOpen={setEditing} />

      {editing && (
        <TicketModal
          ticket={editing === 'new' ? null : editing}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

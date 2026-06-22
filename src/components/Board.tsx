import { STATUSES, type Ticket, type Priority } from '../../shared/constants.js'
import Column from './Column.jsx'
import type { SortBy } from './FilterBar.jsx'

const PRIO_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

type Props = {
  tickets: Ticket[]
  sort: SortBy
  onMove: (id: string, status: Ticket['status'], order: number) => void
  onOpen: (ticket: Ticket) => void
}

// Owns the drop math. Cards carry a fractional `order`; inserting between two
// cards just takes the midpoint of their orders, so a move rewrites exactly
// ONE ticket file instead of renumbering the whole column.
export default function Board({ tickets, sort, onMove, onOpen }: Props) {
  // Always order-based — used for drag-drop insertion math.
  const inColumn = (status: Ticket['status']) =>
    tickets
      .filter((t) => t.status === status)
      .sort((a, b) => a.order - b.order)

  // Applied only for display; drag math always uses inColumn.
  const displayColumn = (status: Ticket['status']): Ticket[] => {
    const base = inColumn(status)
    switch (sort) {
      case 'priority': return [...base].sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority])
      case 'created':  return [...base].sort((a, b) => b.created.localeCompare(a.created))
      case 'title':    return [...base].sort((a, b) => a.title.localeCompare(b.title))
      default:         return base
    }
  }

  // beforeId === null  -> append to end of column
  // beforeId === <id>  -> insert immediately above that card
  const handleDrop = (id: string, status: Ticket['status'], beforeId: string | null) => {
    if (beforeId === id) return // dropped onto itself: no-op
    const column = inColumn(status).filter((t) => t.id !== id)

    let order: number
    if (!beforeId) {
      const last = column[column.length - 1]
      order = last ? last.order + 1 : 1
    } else {
      const idx = column.findIndex((t) => t.id === beforeId)
      const next = column[idx]
      const prev = column[idx - 1]
      const lo = prev ? prev.order : next.order - 1
      order = (lo + next.order) / 2
    }
    onMove(id, status, order)
  }

  return (
    <div className="board">
      {STATUSES.map((col) => (
        <Column
          key={col.id}
          column={col}
          tickets={displayColumn(col.id)}
          onDrop={handleDrop}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

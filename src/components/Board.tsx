import { STATUSES, type Ticket } from '../../shared/constants.js'
import Column from './Column.jsx'

type Props = {
  tickets: Ticket[]
  onMove: (id: string, status: Ticket['status'], order: number) => void
  onOpen: (ticket: Ticket) => void
}

// Owns the drop math. Cards carry a fractional `order`; inserting between two
// cards just takes the midpoint of their orders, so a move rewrites exactly
// ONE ticket file instead of renumbering the whole column.
export default function Board({ tickets, onMove, onOpen }: Props) {
  const inColumn = (status: Ticket['status']) =>
    tickets
      .filter((t) => t.status === status)
      .sort((a, b) => a.order - b.order)

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
          tickets={inColumn(col.id)}
          onDrop={handleDrop}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

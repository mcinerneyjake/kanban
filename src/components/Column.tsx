import type { Ticket } from '../../shared/constants.js'
import Card from './Card.jsx'

type Status = { id: Ticket['status']; label: string }

type Props = {
  column: Status
  tickets: Ticket[]
  onDrop: (id: string, status: Ticket['status'], beforeId: string | null) => void
  onOpen: (ticket: Ticket) => void
}

// A drop target. Dropping on the column's empty space appends; dropping on a
// card (handled in Card) inserts above that card.
export default function Column({ column, tickets, onDrop, onOpen }: Props) {
  const onColumnDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/ticket-id')
    if (id) onDrop(id, column.id, null)
  }

  return (
    <div
      className="column"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onColumnDrop}
    >
      <div className="column-header">
        <span>{column.label}</span>
        <span className="count">{tickets.length}</span>
      </div>
      <div className="column-body">
        {tickets.map((t) => (
          <Card
            key={t.id}
            ticket={t}
            columnId={column.id}
            onDrop={onDrop}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  )
}

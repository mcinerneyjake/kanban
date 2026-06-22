import type { Ticket, TicketType } from '../../shared/constants.js'

const TYPE_ICON: Record<TicketType, string> = { bug: '🐞', feature: '✨', task: '📋', chore: '🧹' }

const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`

type Props = {
  ticket: Ticket
  columnId: Ticket['status']
  depth: number
  childCount: number
  onDrop: (id: string, status: Ticket['status'], beforeId: string | null) => void
  onOpen: (ticket: Ticket) => void
}

export default function Card({ ticket, columnId, depth, childCount, onDrop, onOpen }: Props) {
  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('text/ticket-id', ticket.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  // stopPropagation so the parent Column's "append" drop doesn't also fire.
  const onCardDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const id = e.dataTransfer.getData('text/ticket-id')
    if (id) onDrop(id, columnId, ticket.id)
  }

  return (
    <div
      className={`card prio-${ticket.priority}${depth > 0 ? ' card--child' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onCardDrop}
      onClick={() => onOpen(ticket)}
    >
      <div className="card-title">{ticket.title}</div>
      <div className="card-meta">
        <span className="badge type">
          {TYPE_ICON[ticket.type] || ''} {ticket.type}
        </span>
        <span className={`badge prio prio-${ticket.priority}`}>
          {ticket.priority}
        </span>
        {childCount > 0 && (
          <span className="badge subtasks" title={plural(childCount, 'sub-ticket')}>
            ▸ {childCount}
          </span>
        )}
        {ticket.blockers.length > 0 && (
          <span className="badge blocked" title={`Blocked by ${plural(ticket.blockers.length, 'ticket')}`}>
            ⛔ {ticket.blockers.length}
          </span>
        )}
      </div>
    </div>
  )
}

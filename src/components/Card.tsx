import { memo, useState } from 'react'
import type { Ticket, TicketType } from '../../shared/constants.js'

const TYPE_ICON: Record<TicketType, string> = { bug: '🐞', feature: '✨', task: '📋', chore: '🧹' }

const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`

type DropMode = 'before' | 'child' | null

// Module-level: tracks the source column of the card currently being dragged.
// Drag operations are single-touch so module scope is safe; this lets dragover
// handlers know whether a re-parent zone is applicable without reading
// dataTransfer (whose values are security-locked to drop handlers only).
let _dragSrcStatus = ''

type Props = {
  ticket: Ticket
  onOpen: (ticket: Ticket) => void
  columnId?: Ticket['status']
  depth?: number
  childCount?: number
  isCollapsed?: boolean
  onDrop?: (id: string, status: Ticket['status'], beforeId: string | null) => void
  onReparent?: (id: string, newParentId: string) => void
  onToggleCollapse?: (id: string) => void
}

function Card({ ticket, onOpen, columnId, depth = 0, childCount = 0, isCollapsed = false, onDrop, onReparent, onToggleCollapse }: Props) {
  const draggable = !!(columnId && onDrop)
  const [dropMode, setDropMode] = useState<DropMode>(null)

  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    _dragSrcStatus = columnId ?? ''
    e.dataTransfer.setData('text/ticket-id', ticket.id)
    e.dataTransfer.setData('text/ticket-status', columnId ?? '')
    e.dataTransfer.effectAllowed = 'move'
  }

  const onCardDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const inChildZone = (e.clientY - rect.top) / rect.height >= 0.35
    // Re-parent zone only makes sense within the same column.
    const sameColumn = _dragSrcStatus === columnId
    const mode: DropMode = inChildZone && sameColumn ? 'child' : 'before'
    setDropMode(mode)
  }

  // Defined only when draggable — TypeScript narrows onDrop and columnId as
  // non-undefined inside the ternary branch, eliminating the need for guards
  // or non-null assertions at the call site.
  // stopPropagation so the parent Column's "append" drop doesn't also fire.
  const onCardDrop = onDrop && columnId
    ? (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault()
        e.stopPropagation()
        const id = e.dataTransfer.getData('text/ticket-id')
        const srcStatus = e.dataTransfer.getData('text/ticket-status')
        if (!id || id === ticket.id) { setDropMode(null); return }
        // Only re-parent when both cards are in the same column; cross-column drops
        // always move the ticket to the target column (insert before the hovered card).
        if (dropMode === 'child' && srcStatus === columnId) {
          onReparent?.(id, ticket.id)
        } else {
          onDrop(id, columnId, ticket.id)
        }
        setDropMode(null)
      }
    : undefined

  const dropClass = dropMode === 'before' ? ' card--drop-before'
    : dropMode === 'child' ? ' card--drop-child'
    : ''

  return (
    <div
      className={`card prio-${ticket.priority}${depth > 0 ? ' card--child' : ''}${dropClass}`}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? onCardDragOver : undefined}
      onDragLeave={draggable ? () => setDropMode(null) : undefined}
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
          <span
            className="badge subtasks"
            title={isCollapsed ? `Show ${plural(childCount, 'sub-ticket')}` : `Hide ${plural(childCount, 'sub-ticket')}`}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(ticket.id) }}
          >
            {isCollapsed ? '▸' : '▾'} {childCount}
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

export default memo(Card)

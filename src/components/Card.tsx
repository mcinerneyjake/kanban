import { memo, useState } from 'react';
import type { Ticket, TicketType } from '../../shared/constants.js';
import CardProgress from './CardProgress.js';
import ProvenanceBadge from './ProvenanceBadge.js';
import { ticketProvenance } from '../lib/provenance.js';

const TYPE_ICON: Record<TicketType, string> = { bug: '🐞', feature: '✨', task: '📋', chore: '🧹' };

function formatDueDate(iso: string): string {
  const [, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

const AVATAR_COLORS = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`;

type DropMode = 'before' | 'child' | null

// Module-level: tracks the source column of the card currently being dragged.
// Drag operations are single-touch so module scope is safe; this lets dragover
// handlers know whether a re-parent zone is applicable without reading
// dataTransfer (whose values are security-locked to drop handlers only).
let _dragSrcStatus = '';

type Props = {
  ticket: Ticket
  onOpen: (ticket: Ticket) => void
  columnId?: Ticket['status']
  depth?: number
  childCount?: number
  activeBlockerCount?: number
  isCollapsed?: boolean
  onDrop?: (id: string, status: Ticket['status'], beforeId: string | null) => void
  onReparent?: (id: string, newParentId: string) => void
  onToggleCollapse?: (id: string) => void
}

function Card({ ticket, onOpen, columnId, depth = 0, childCount = 0, activeBlockerCount = 0, isCollapsed = false, onDrop, onReparent, onToggleCollapse }: Props) {
  const draggable = !!(columnId && onDrop);
  const [dropMode, setDropMode] = useState<DropMode>(null);
  // A passive marker on agent-authored tickets (like the type/priority badges).
  // The run's economics deep-link lives in the ticket modal (ProvenanceNote), so
  // the card stays a single click target — the badge just bubbles to onOpen.
  const provenance = ticketProvenance(ticket);

  const onDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    _dragSrcStatus = columnId ?? '';
    e.dataTransfer.setData('text/ticket-id', ticket.id);
    e.dataTransfer.setData('text/ticket-status', columnId ?? '');
    e.dataTransfer.effectAllowed = 'move';
  };

  const onCardDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const inChildZone = (e.clientY - rect.top) / rect.height >= 0.35;
    // Re-parent zone only makes sense within the same column.
    const sameColumn = _dragSrcStatus === columnId;
    const mode: DropMode = inChildZone && sameColumn ? 'child' : 'before';
    setDropMode(mode);
  };

  // Defined only when draggable — TypeScript narrows onDrop and columnId as
  // non-undefined inside the ternary branch, eliminating the need for guards
  // or non-null assertions at the call site.
  // stopPropagation so the parent Column's "append" drop doesn't also fire.
  const onCardDrop = onDrop && columnId
    ? (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const id = e.dataTransfer.getData('text/ticket-id');
        const srcStatus = e.dataTransfer.getData('text/ticket-status');
        if (!id || id === ticket.id) { setDropMode(null); return; }
        // Only re-parent when both cards are in the same column; cross-column drops
        // always move the ticket to the target column (insert before the hovered card).
        if (dropMode === 'child' && srcStatus === columnId) {
          onReparent?.(id, ticket.id);
        } else {
          onDrop(id, columnId, ticket.id);
        }
        setDropMode(null);
      }
    : undefined;

  const dropClass = dropMode === 'before' ? ' card--drop-before'
    : dropMode === 'child' ? ' card--drop-child'
    : '';

  // Keyboard access: the card is the primary "open ticket" target, so it acts as
  // a button. Enter/Space open it; the guard ignores keys bubbling up from nested
  // controls (the collapse toggle) so they don't also open the ticket.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(ticket);
    }
  };

  return (
    <div
      className={`card prio-${ticket.priority}${depth > 0 ? ' card--child' : ''}${dropClass}`}
      role="button"
      tabIndex={0}
      // No aria-label: let the accessible name derive from the card's contents so
      // the type/priority/due/blocker badges stay announced to assistive tech. A
      // cleaner title-as-button refactor is tracked as a follow-up (tkt below).
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? onCardDragOver : undefined}
      onDragLeave={draggable ? () => setDropMode(null) : undefined}
      onDrop={onCardDrop}
      onClick={() => onOpen(ticket)}
      onKeyDown={onKeyDown}
    >
      <div className="card-title">{ticket.title}</div>
      <div className="card-meta">
        <span className="badge type">
          {TYPE_ICON[ticket.type] || ''} {ticket.type}
        </span>
        <span className={`badge prio prio-${ticket.priority}`}>
          {ticket.priority}
        </span>
        {provenance && <ProvenanceBadge source={provenance.source} title="Authored via the intake agent" />}
        {childCount > 0 && (
          <button
            type="button"
            className="badge subtasks"
            title={isCollapsed ? `Show ${plural(childCount, 'sub-ticket')}` : `Hide ${plural(childCount, 'sub-ticket')}`}
            onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(ticket.id); }}
          >
            {isCollapsed ? '▸' : '▾'} {childCount}
          </button>
        )}
        {activeBlockerCount > 0 && (
          <span className="badge blocked" title={`Blocked by ${plural(activeBlockerCount, 'ticket')}`}>
            ⛔ {activeBlockerCount}
          </span>
        )}
        {ticket.assignee && (
          <span
            className="assignee-avatar"
            style={{ background: avatarColor(ticket.assignee) }}
            title={ticket.assignee}
          >
            {initials(ticket.assignee)}
          </span>
        )}
        {ticket.dueDate && ticket.status !== 'done' && ticket.status !== 'archived' && (() => {
          // Local "today", not UTC: toISOString() would flip to tomorrow in the
          // evening at negative UTC offsets (e.g. 8pm EDT), lighting the overdue
          // badge hours early. dueDate is a bare YYYY-MM-DD, so compare in local time.
          const now = new Date();
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const cls = ticket.dueDate < today ? ' overdue' : ticket.dueDate === today ? ' due-today' : '';
          return (
            <span className={`badge due-date${cls}`} title={`Due ${ticket.dueDate}`}>
              📅 {formatDueDate(ticket.dueDate)}
            </span>
          );
        })()}
      </div>
      {(ticket.status === 'in-progress' || ticket.status === 'qa') && (
        <CardProgress ticketId={ticket.id} status={ticket.status} />
      )}
    </div>
  );
}

export default memo(Card);

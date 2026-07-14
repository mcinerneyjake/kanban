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

// Source column of the dragged card. Drag is single-touch so module scope is safe; lets dragover read it without dataTransfer (values security-locked to drop handlers).
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
  // Passive marker; the run's economics deep-link lives in the modal (ProvenanceNote).
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

  // Ternary narrows onDrop/columnId to non-undefined (no guards needed). stopPropagation so the Column's append drop doesn't also fire.
  const onCardDrop = onDrop && columnId
    ? (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const id = e.dataTransfer.getData('text/ticket-id');
        const srcStatus = e.dataTransfer.getData('text/ticket-status');
        if (!id || id === ticket.id) { setDropMode(null); return; }
        // Re-parent only within the same column; cross-column always moves + inserts before.
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

  // Card acts as a button (Enter/Space open); guard ignores keys bubbling from nested controls.
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
      // No aria-label: accessible name derives from card contents so badges stay announced.
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
          // Local "today", not UTC: toISOString() flips to tomorrow at negative offsets, lighting overdue early.
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

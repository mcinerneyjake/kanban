import { useState, useRef } from 'react';
import { useDismiss } from '../useDismiss.js';
import type { Ticket, BoardTicket } from '../../shared/constants.js';
import Card from './Card.jsx';

type Status = { id: Ticket['status']; label: string }

type Props = {
  column: Status
  tickets: BoardTicket[]
  now: number
  // Done column only. Counts completions across done AND archived, so Archive all does not zero the
  // day's record, and respects the active filter so the number predicts what clicking gives you —
  // deliberately unlike ArchiveLane's totalCount, which is unfiltered for a different reason
  // (distinguishing an empty lane from a filtered-out one). tkt-17dbc816e247.
  todayCount?: number
  onShowToday?: () => void
  depths: Record<string, number>
  childCounts: Record<string, number>
  activeBlockerCounts: Record<string, number>
  staleBlockerCounts: Record<string, number>
  collapsed: Set<string>
  onDrop: (id: string, status: Ticket['status'], beforeId: string | null) => void
  onReparent: (id: string, newParentId: string) => void
  onOpen: (ticket: Ticket) => void
  onToggleCollapse: (id: string) => void
  onArchiveAll?: () => void
}

// Drop on empty space appends; drop on a card (in Card) inserts above it.
export default function Column({ column, tickets, now, todayCount, onShowToday, depths, childCounts, activeBlockerCounts, staleBlockerCounts, collapsed, onDrop, onReparent, onOpen, onToggleCollapse, onArchiveAll }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useDismiss(menuRef, () => setMenuOpen(false), { enabled: menuOpen });

  const onColumnDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/ticket-id');
    if (id) onDrop(id, column.id, null);
  };

  return (
    <div
      className="column"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onColumnDrop}
    >
      <div className="column-header">
        <div className="column-header-left">
          <span>{column.label}</span>
          {todayCount !== undefined && onShowToday && (
            // Rendered at zero too: hiding it would make "nothing finished yet" and "the count is
            // broken" look identical.
            <button
              className="column-today"
              onClick={onShowToday}
              title="Show tickets completed today"
            >
              {todayCount} today
            </button>
          )}
        </div>
        <div className="column-header-right">
          {onArchiveAll && (
            <div className="column-menu" ref={menuRef}>
              <button
                className="column-menu-btn"
                aria-label="Column actions"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="column-menu-dropdown">
                  <button
                    className="column-menu-item"
                    disabled={tickets.length === 0}
                    onClick={() => { onArchiveAll(); setMenuOpen(false); }}
                  >
                    Archive all{tickets.length > 0 ? ` (${tickets.length})` : ''}
                  </button>
                </div>
              )}
            </div>
          )}
          <span className="count">{tickets.length}</span>
        </div>
      </div>
      <div className="column-body">
        {tickets.map((t) => (
          <Card
            key={t.id}
            ticket={t}
            now={now}
            columnId={column.id}
            depth={depths[t.id] ?? 0}
            childCount={childCounts[t.id] ?? 0}
            activeBlockerCount={activeBlockerCounts[t.id] ?? 0}
            staleBlockerCount={staleBlockerCounts[t.id] ?? 0}
            isCollapsed={collapsed.has(t.id)}
            onDrop={onDrop}
            onReparent={onReparent}
            onOpen={onOpen}
            onToggleCollapse={onToggleCollapse}
          />
        ))}
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from 'react';
import type { Ticket } from '../../shared/constants.js';
import Card from './Card.jsx';

type Status = { id: Ticket['status']; label: string }

type Props = {
  column: Status
  tickets: Ticket[]
  depths: Record<string, number>
  childCounts: Record<string, number>
  collapsed: Set<string>
  onDrop: (id: string, status: Ticket['status'], beforeId: string | null) => void
  onReparent: (id: string, newParentId: string) => void
  onOpen: (ticket: Ticket) => void
  onToggleCollapse: (id: string) => void
  onArchiveAll?: () => void
}

// A drop target. Dropping on the column's empty space appends; dropping on a
// card (handled in Card) inserts above that card.
export default function Column({ column, tickets, depths, childCounts, collapsed, onDrop, onReparent, onOpen, onToggleCollapse, onArchiveAll }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouse = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

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
        <span>{column.label}</span>
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
            columnId={column.id}
            depth={depths[t.id] ?? 0}
            childCount={childCounts[t.id] ?? 0}
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { BOARD_STATUSES, type Ticket, type Priority } from '../../shared/constants.js';
import Column from './Column.jsx';
import type { SortBy } from './FilterPopover.jsx';
import { computeDropOrder } from '../lib/orderMath.js';
import { doneParentsWithChildren, reconcileDoneCollapse } from '../lib/collapseDefaults.js';

const PRIO_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type Props = {
  tickets: Ticket[]
  sort: SortBy
  childCounts: Record<string, number>
  activeBlockerCounts: Record<string, number>
  onMove: (id: string, status: Ticket['status'], order: number) => void
  onReparent: (id: string, newParentId: string) => void
  onOpen: (ticket: Ticket) => void
  onArchiveAll: () => void
}

export default function Board({ tickets, sort, childCounts, activeBlockerCounts, onMove, onReparent, onOpen, onArchiveAll }: Props) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  // The subset of `collapsed` we collapsed automatically because the parent is
  // done — kept in a ref so a user expanding a done parent isn't undone, and so
  // a parent leaving `done` can have its auto-collapse reverted. See reconcileDoneCollapse.
  const autoCollapsedRef = useRef(new Set<string>());

  // Collapse a done parent's children by default. Runs whenever the board (or a
  // child count) changes; `collapsed` is a dependency so the reconcile sees the
  // user's latest manual toggles and leaves them intact (the reconcile is a pure,
  // idempotent function of these inputs, so this settles in one extra render).
  useEffect(() => {
    const doneParents = doneParentsWithChildren(tickets, childCounts);
    const result = reconcileDoneCollapse(
      { collapsed, autoCollapsed: autoCollapsedRef.current },
      doneParents,
    );
    autoCollapsedRef.current = result.autoCollapsed;
    if (result.changed) setCollapsed(result.collapsed);
  }, [tickets, childCounts, collapsed]);

  const toggleCollapse = useCallback((id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);
  // Always order-based — used for drag-drop insertion math.
  const inColumn = (status: Ticket['status']) =>
    tickets
      .filter((t) => t.status === status)
      .sort((a, b) => a.order - b.order);

  // Applied only for display; drag math always uses inColumn.
  // Children are grouped directly under their parent when both share the same column.
  const displayColumn = (status: Ticket['status']): { ordered: Ticket[]; depths: Record<string, number> } => {
    const base = inColumn(status);
    const sorted = (() => {
      switch (sort) {
        case 'priority': return [...base].sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
        case 'created':  return [...base].sort((a, b) => b.created.localeCompare(a.created));
        case 'title':    return [...base].sort((a, b) => a.title.localeCompare(b.title));
        default:         return base;
      }
    })();

    const columnIds = new Set(base.map((t) => t.id));

    // Build parent→children map in one pass (children inherit sorted order).
    const childrenOf = new Map<string, Ticket[]>();
    for (const t of sorted) {
      if (t.parent && columnIds.has(t.parent)) {
        const siblings = childrenOf.get(t.parent) ?? [];
        siblings.push(t);
        childrenOf.set(t.parent, siblings);
      }
    }

    const roots = sorted.filter((t) => !t.parent || !columnIds.has(t.parent));
    const depths: Record<string, number> = {};
    const ordered: Ticket[] = [];

    // DFS walk so each subtree is contiguous in the output (parent → children → grandchildren).
    const walk = (t: Ticket, depth: number) => {
      depths[t.id] = depth;
      ordered.push(t);
      if (!collapsed.has(t.id)) {
        for (const child of childrenOf.get(t.id) ?? []) walk(child, depth + 1);
      }
    };
    for (const root of roots) walk(root, 0);

    return { ordered, depths };
  };

  // beforeId === null  -> append to end of column
  // beforeId === <id>  -> insert immediately above that card
  const handleDrop = (id: string, status: Ticket['status'], beforeId: string | null) => {
    if (beforeId === id) return; // dropped onto itself: no-op
    const column = inColumn(status).filter((t) => t.id !== id);
    onMove(id, status, computeDropOrder(column, beforeId));
  };

  return (
    <div className="board">
      {BOARD_STATUSES.map((col) => {
        const { ordered, depths } = displayColumn(col.id);
        return (
          <Column
            key={col.id}
            column={col}
            tickets={ordered}
            depths={depths}
            childCounts={childCounts}
            activeBlockerCounts={activeBlockerCounts}
            collapsed={collapsed}
            onDrop={handleDrop}
            onReparent={onReparent}
            onOpen={onOpen}
            onToggleCollapse={toggleCollapse}
            onArchiveAll={col.id === 'done' ? onArchiveAll : undefined}
          />
        );
      })}
    </div>
  );
}

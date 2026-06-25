import type { Ticket } from '../../shared/constants.js';

// Parent ids that should collapse their children by default: a ticket that is
// `done` AND actually has children. (A done ticket with no children is a no-op.)
export function doneParentsWithChildren(
  tickets: readonly Ticket[],
  childCounts: Record<string, number>,
): Set<string> {
  const ids = new Set<string>();
  for (const t of tickets) {
    if (t.status === 'done' && (childCounts[t.id] ?? 0) > 0) ids.add(t.id);
  }
  return ids;
}

export interface CollapseState {
  collapsed: ReadonlySet<string>;     // parent ids whose children are hidden
  autoCollapsed: ReadonlySet<string>; // the subset we collapsed automatically (because done)
}

export interface CollapseReconcileResult {
  collapsed: Set<string>;
  autoCollapsed: Set<string>;
  changed: boolean; // did `collapsed` change? — drives whether React state updates
}

// Reconcile the "collapse children by default when the parent is done" rule
// against the current collapse state.
//
//   - A parent that is newly done-with-children is collapsed once and remembered
//     in `autoCollapsed`. Because we only auto-collapse ids we haven't already
//     auto-collapsed, a later user *expand* of a done parent is not undone on the
//     next render.
//   - When a parent is no longer done-with-children, its automatic collapse is
//     reverted (the children reappear) and it is forgotten — so returning to
//     `done` later collapses it again.
//
// User toggles on non-done parents are never touched: those ids never enter
// `autoCollapsed`, so this function leaves them exactly as the user set them.
export function reconcileDoneCollapse(
  state: CollapseState,
  doneParents: ReadonlySet<string>,
): CollapseReconcileResult {
  const collapsed = new Set(state.collapsed);
  const autoCollapsed = new Set(state.autoCollapsed);
  let changed = false;

  // Auto-collapse each done-with-children parent once.
  for (const id of doneParents) {
    if (!autoCollapsed.has(id)) {
      autoCollapsed.add(id);
      if (!collapsed.has(id)) {
        collapsed.add(id);
        changed = true;
      }
    }
  }

  // Revert the automatic collapse once a parent is no longer done-with-children.
  for (const id of autoCollapsed) {
    if (!doneParents.has(id)) {
      autoCollapsed.delete(id);
      if (collapsed.delete(id)) changed = true;
    }
  }

  return { collapsed, autoCollapsed, changed };
}

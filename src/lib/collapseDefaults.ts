import type { Ticket } from '../../shared/constants.js';

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

// Auto-collapse each newly done-with-children parent once (remembered in autoCollapsed, so a user expand isn't undone); revert + forget when it leaves that state. User toggles on non-done parents never enter autoCollapsed, so they're untouched.
export function reconcileDoneCollapse(
  state: CollapseState,
  doneParents: ReadonlySet<string>,
): CollapseReconcileResult {
  const collapsed = new Set(state.collapsed);
  const autoCollapsed = new Set(state.autoCollapsed);
  let changed = false;

  for (const id of doneParents) {
    if (!autoCollapsed.has(id)) {
      autoCollapsed.add(id);
      if (!collapsed.has(id)) {
        collapsed.add(id);
        changed = true;
      }
    }
  }

  for (const id of autoCollapsed) {
    if (!doneParents.has(id)) {
      autoCollapsed.delete(id);
      if (collapsed.delete(id)) changed = true;
    }
  }

  return { collapsed, autoCollapsed, changed };
}

import { useEffect, useRef, type RefObject } from 'react';

// Shared "dismiss this transient UI" behaviour for popovers and menus: invokes
// `onDismiss` on an outside mousedown or on Escape, while `enabled`. Consolidates
// the byte-identical effects previously hand-rolled in FilterPopover,
// DashboardConfigPopover, and Column — so a future change (touch/pointer
// handling, capture phase) lands in one place instead of silently diverging.
//
// Escape is ignored when the event target is a native <select> so dismissing an
// open dropdown doesn't also close the container (see tkt-6d56cfd9908e); this is
// a no-op where the container has no <select>, so it's safe to apply uniformly.
//
// `onDismiss` is read through a ref so an inline closure doesn't re-bind the
// document listeners on every render: the effect re-runs only when `enabled`
// (or the ref identity) changes, matching the original `[open]`-gated effects.
export function useDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onDismiss: () => void,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  useEffect(() => {
    if (!enabled) return;
    const onMouse = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onDismissRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLSelectElement)) onDismissRef.current();
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, enabled]);
}

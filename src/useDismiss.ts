import { useEffect, useRef, type RefObject } from 'react';

// Dismiss on outside mousedown or Escape while enabled. Escape ignores a native <select> so closing its dropdown doesn't close the container (tkt-6d56cfd9908e). onDismiss read via ref so an inline closure doesn't re-bind the listeners each render.
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

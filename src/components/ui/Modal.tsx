import { useEffect, useRef, useState, type ReactNode } from 'react';

// A11y contract: role=dialog + aria-modal, Tab focus-trap, focus-restore on close (tkt-3d41293158f8).
// Escape ignores an open native <select> so its own Escape doesn't tear down the modal (losing unsaved edits).

// Stack of open modals so only the TOPMOST handles Escape / the Tab trap (two can be open — a run-detail peek over the editor); push on mount, splice on unmount.
const modalStack: symbol[] = [];

// Tab-trap query; excludes tabindex=-1/disabled (visibility filtered via offsetParent at call time).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

type Props = {
  onClose: () => void;
  className?: string;
  children: ReactNode;
  label?: string;
};

export default function Modal({ onClose, className, children, label }: Props) {
  // Read onClose via a ref so the mount-only keydown effect never re-binds (which would reorder the stack).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  // Capture the trigger during first render (before a child autoFocus steals focus) so we can restore it on close; useState initializer runs once and is lint-clean.
  const [restoreEl] = useState<Element | null>(() =>
    typeof document !== 'undefined' ? document.activeElement : null,
  );
  // Only close when the press STARTED on the backdrop: click fires on the mousedown/up common ancestor, so a text-drag released outside would else close the modal and lose edits.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const id = Symbol('modal');
    modalStack.push(id);
    const isTop = () => modalStack[modalStack.length - 1] === id;

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        if (!(e.target instanceof HTMLSelectElement)) onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = focusableWithin(panelRef.current);
        if (focusables.length === 0) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const outside = !panelRef.current.contains(active);
        if (e.shiftKey && (active === first || outside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || outside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    // Move focus into the dialog on open, but only if a child autoFocus hasn't already (runs post-commit).
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const focusables = focusableWithin(panel);
      (focusables[0] ?? panel).focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(id);
      if (i !== -1) modalStack.splice(i, 1);
      // Restore focus to the trigger; a detached node's focus() no-ops.
      if (restoreEl instanceof HTMLElement) restoreEl.focus();
    };
  }, [restoreEl]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        // Close only when BOTH press ends landed on the backdrop; guarding one end still loses edits on the mirror gesture (click fires on the common ancestor).
        if (pressedBackdrop.current && e.target === e.currentTarget) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? 'Dialog'}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

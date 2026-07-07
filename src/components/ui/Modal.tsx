import { useEffect, useRef, useState, type ReactNode } from 'react';

// Generic modal shell: a full-screen backdrop wrapping a centered dialog panel,
// with Escape-to-close, backdrop-click-to-close, a focus trap, and focus restore.
// Body content and any header/footer are the caller's — pass a variant via
// `className` (e.g. 'modal--run', 'modal--draft') and an accessible name via
// `label` (becomes the dialog's aria-label).
//
// Accessibility contract (tkt-3d41293158f8):
//   - role="dialog" + aria-modal so assistive tech announces it as a modal and
//     scopes the user inside it.
//   - Focus trap: Tab / Shift+Tab cycle within the panel instead of walking out
//     onto the board behind it.
//   - Focus restore: on close, focus returns to whatever triggered the modal.
//
// The Escape handler ignores events whose target is an open native <select>: a
// dropdown's own Escape shouldn't also tear down the modal (and lose unsaved form
// edits). This is a safe no-op for modals without a <select>, so the one guarded
// handler serves every modal.

// Module-level stack of the currently-open modals so only the TOPMOST responds to
// Escape (and drives the Tab trap). Two modals can be open at once — a run-detail
// modal peeked from the ticket editor stacks over it — and each registers a
// document keydown listener; without this, a single Escape would fire every
// listener and close them all. Push on mount / splice on unmount, so stack order
// tracks mount order (the later-opened modal is on top).
const modalStack: symbol[] = [];

// Tab-order query for the focus trap. Excludes tabindex="-1" (programmatic-only)
// and disabled controls; visibility is filtered at call time via offsetParent.
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
  // Read onClose through a ref so the mount-only keydown effect never re-binds
  // (which would reorder the stack) when an inline onClose closure changes
  // identity between renders — same pattern as useDismiss.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  // Capture the trigger element during the FIRST render — before any child
  // autoFocus (applied at commit) steals focus — so we can restore it on close.
  // A useState initializer runs once, during that first render, and (unlike a
  // ref written in render) is lint-clean.
  const [restoreEl] = useState<Element | null>(() =>
    typeof document !== 'undefined' ? document.activeElement : null,
  );
  // Guards the backdrop close: browsers dispatch `click` on the common ancestor
  // of mousedown/mouseup, so selecting text in a textarea and releasing outside
  // the panel would otherwise close the modal and destroy unsaved edits. Only
  // close when the press actually STARTED on the backdrop.
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

    // Move focus into the dialog on open so screen-reader/keyboard users land
    // inside it. A newly-mounted modal is always the new top. This runs after
    // commit, so any autoFocus child has already taken focus — act only when
    // focus is still outside (e.g. EconomicsRunDetail, which has no autoFocus).
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const focusables = focusableWithin(panel);
      (focusables[0] ?? panel).focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(id);
      if (i !== -1) modalStack.splice(i, 1);
      // Restore focus to the trigger so keyboard users aren't dumped at the top
      // of the document when the modal closes. A detached node's focus() no-ops.
      if (restoreEl instanceof HTMLElement) restoreEl.focus();
    };
  }, [restoreEl]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        // Close only when BOTH ends of the press landed on the backdrop itself.
        // Guarding one end alone still loses unsaved edits on the mirror gesture
        // (press on the backdrop, release inside the panel — or vice-versa),
        // because the browser dispatches `click` on the common ancestor.
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

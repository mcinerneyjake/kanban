import { useEffect, useRef, type ReactNode } from 'react';

// Generic modal shell: a full-screen backdrop (click to close) wrapping a
// centered container (which stops propagation so an in-modal click doesn't
// dismiss), plus Escape-to-close. Body content and any header/footer are the
// caller's — pass a variant via `className` (e.g. 'modal--run', 'modal--draft').
//
// The Escape handler ignores events whose target is an open native <select>: a
// dropdown's own Escape shouldn't also tear down the modal (and lose unsaved form
// edits). This is a safe no-op for modals without a <select>, so the one guarded
// handler serves every modal.

// Module-level stack of the currently-open modals so only the TOPMOST responds to
// Escape. Two modals can be open at once — a run-detail modal peeked from the
// ticket editor stacks over it — and each registers a document keydown listener;
// without this, a single Escape would fire every listener and close them all.
// Push on mount / splice on unmount, so stack order tracks mount order (the
// later-opened modal is on top).
const modalStack: symbol[] = [];

type Props = {
  onClose: () => void;
  className?: string;
  children: ReactNode;
};

export default function Modal({ onClose, className, children }: Props) {
  // Read onClose through a ref so the mount-only keydown effect never re-binds
  // (which would reorder the stack) when an inline onClose closure changes
  // identity between renders — same pattern as useDismiss.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const id = Symbol('modal');
    modalStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLSelectElement) return;
      if (modalStack[modalStack.length - 1] === id) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(id);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={className ? `modal ${className}` : 'modal'} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

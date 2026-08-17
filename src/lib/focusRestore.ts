// Where focus goes when a modal closes (tkt-75ac08441da5).
//
// The captured trigger is the right answer for an ordinary open/close, but not after in-modal
// ticket→ticket navigation: `TicketModal` is keyed by ticket id, so following a subtask link unmounts the
// old modal and mounts a new one, whose capture is the link that is being unmounted with it. Calling
// focus() on a detached node silently no-ops and focus falls to <body>, stranding a keyboard user at the
// top of the document — the failure this decides against.
//
// Only the two fields used are required, so the decision is testable without a DOM (vitest here is
// node-env) and cannot drift from what it actually reads.
export interface Focusable {
  readonly isConnected: boolean
  focus(): void
}

export type FocusRestoreOutcome = 'trigger' | 'fallback' | 'none'

/**
 * Focus the captured trigger while it is still in the document, else the fallback. Returns which branch
 * ran so a caller — or a test — can tell "restored" from "could not restore"; a void function here would
 * make the no-op case indistinguishable from success, which is how this defect stayed invisible.
 *
 * The fallback is a thunk, not an element: it is resolved only when needed, so a caller can query the DOM
 * at close time rather than holding a reference that may itself have gone stale.
 */
export function restoreFocus(
  trigger: Focusable | null | undefined,
  fallback?: () => Focusable | null,
): FocusRestoreOutcome {
  if (trigger?.isConnected) {
    trigger.focus();
    return 'trigger';
  }
  const target = fallback?.();
  if (target?.isConnected) {
    target.focus();
    return 'fallback';
  }
  return 'none';
}

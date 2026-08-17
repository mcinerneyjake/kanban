import { MAX_INPUT_CHARS } from '../../shared/terminalProtocol.js';

// Bounded input queue for the embedded terminal (tkt-13d218c7749d). Keystrokes typed while the socket is
// not OPEN — and, less obviously, while a reattach's fresh pty is still being created — were sent to a
// closed socket and discarded with no queue and no signal. A CONFIRMED paste took the same path, so the
// user could read a security warning, click Paste, and have nothing at all happen.
//
// Frames, not one blob: the server drops an oversized `{t:'i',d}` frame WHOLE (parseClientFrame), so a
// flush that concatenated a 50k paste with buffered typing into one frame would trade dropped keystrokes
// for dropped everything. Derived from the server's own constant rather than a copied number, so the two
// cannot drift.
// A function, not an inline expression, so a test can prove the cap TRACKS the server's rather than
// merely equalling it today: asserting `MAX_FRAME_CHARS === MAX_INPUT_CHARS / 4` is also satisfied by a
// hand-copied 50_000, which is the drift the derivation exists to prevent (found by mutation).
export function frameCapFor(maxInputChars: number): number {
  return Math.floor(maxInputChars / 4);
}

export const MAX_FRAME_CHARS = frameCapFor(MAX_INPUT_CHARS);

// Comfortably above one maximum paste (MAX_PASTE_CHARS = 50_000) plus a burst of typing, and far below
// the server cap. A disconnect long enough to overflow this is not a case worth holding more input for.
export const MAX_BUFFERED_CHARS = 64_000;

export interface TerminalInputBuffer {
  /** Queue input. Returns false when the cap refused it — NOTHING was queued, and the caller must say so. */
  queue(data: string): boolean
  /** Frames to send in order, each within the server's per-frame limit. Empties the buffer. */
  drain(): string[]
  readonly size: number
  clear(): void
}

export function terminalInputBuffer(
  { maxBuffered = MAX_BUFFERED_CHARS, maxFrame = MAX_FRAME_CHARS } = {},
): TerminalInputBuffer {
  let queued = '';
  return {
    queue(data) {
      if (data === '') return true; // nothing to hold; not a rejection
      // Reject the NEWEST rather than evicting the oldest: a coherent prefix of what the user typed is
      // recoverable, whereas silently dropping from the middle re-creates this bug inside the fix.
      if (queued.length + data.length > maxBuffered) return false;
      queued += data;
      return true;
    },
    drain() {
      const frames: string[] = [];
      for (let at = 0; at < queued.length; at += maxFrame) frames.push(queued.slice(at, at + maxFrame));
      queued = '';
      return frames;
    },
    get size() {
      return queued.length;
    },
    clear() {
      queued = '';
    },
  };
}

// WebSocket.readyState values, spelled out because this module must not depend on the DOM global (the
// suite runs in node) — and because the interesting case is CONNECTING, which is easy to read as
// "nearly open" and is not sendable at all.
const WS_OPEN = 1;

/**
 * Whether input can go on the wire right now. `ptyPending` is true from a reattach's onopen until the
 * first byte proves the fresh pty exists: the socket is OPEN in that window, but the server-side pty is
 * still being created and anything sent is dropped — the same race that loses the onopen resize
 * (tkt-13d218c7749d). readyState alone is therefore not enough.
 */
export function canSendInput(readyState: number | undefined, ptyPending: boolean): boolean {
  return readyState === WS_OPEN && !ptyPending;
}

// Clipboard policy for the embedded terminal (tkt-fe2ead98fd65) — pure, so the security-relevant
// decisions are testable without a DOM or a pty.

export const MAX_PASTE_CHARS = 50_000;

export type KeyChord = {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

export type ClipboardIntent = 'copy' | 'paste' | null;

// Cmd and Ctrl+Shift are both accepted everywhere rather than sniffed per-OS: they can't collide
// (Cmd doesn't exist off mac, Ctrl+Shift+C isn't a mac terminal chord), so one rule set covers every
// platform. Plain Ctrl+C/Ctrl+V stay unclaimed — SIGINT and literal-next belong to the pty.
function isChord(e: KeyChord, letter: string): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return key === letter && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey && !e.metaKey));
}

function isInsertChord(e: KeyChord, modifier: 'ctrlKey' | 'shiftKey'): boolean {
  const other = modifier === 'ctrlKey' ? 'shiftKey' : 'ctrlKey';
  return e.key === 'Insert' && e[modifier] && !e[other] && !e.metaKey;
}

export function clipboardIntent(e: KeyChord, ctx: { hasSelection: boolean }): ClipboardIntent {
  if (e.type !== 'keydown' || e.altKey) return null;
  // Copy is only ours when there's something to copy; otherwise the chord still reaches the app.
  if (isChord(e, 'c') || isInsertChord(e, 'ctrlKey')) return ctx.hasSelection ? 'copy' : null;
  if (isChord(e, 'v') || isInsertChord(e, 'shiftKey')) return 'paste';
  return null;
}

// ESC is the one that matters: a payload carrying ESC[201~ would close bracketed paste early and the
// rest would land as typed input. Every member here is content-free, so deleting it loses nothing.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// U+2028/U+2029 are line SEPARATORS carrying real content, so they are normalized, not deleted —
// deleting them spliced two pasted commands into one token that then had no [\r\n] left to trip the
// confirmation bar at all (tkt-9e3fd0da8398 review). Normalizing makes the browser's rendering, the
// line count and the bytes sent to the pty agree.
export function sanitizePaste(text: string): string {
  return text.replace(/[\u2028\u2029]/g, '\n').replace(UNSAFE_CHARS, '');
}

export type PasteDecision =
  | { kind: 'send'; text: string }
  | { kind: 'confirm'; text: string; lines: number }
  | { kind: 'reject'; reason: string };

/**
 * Decide what happens to a paste before any byte reaches the pty.
 *
 * Trailing line breaks are always dropped: a pasted command lands in the prompt for the user to send,
 * which kills the canonical paste-jacking payload (one hijacked command ending in \n) without a prompt
 * — and without trusting `bracketedPaste`, which terminal output alone can set. What's left needing
 * consent is an *embedded* line break with no bracketing to make it inert.
 *
 * The embedded-newline guard below DOES key on `bracketedPaste`, knowingly (tkt-ec1daaf94f96, folded
 * into tkt-9e3fd0da8398). A `/security-review` accepted it: this terminal's workload is Claude Code,
 * which enables bracketed paste, so confirming unconditionally would prompt on every routine paste and
 * train the user to click through the bar — costing more than the narrow case it covers, where a
 * foreground app sets the mode bit without honoring the wrapper.
 */
export function decidePaste(raw: string, ctx: { bracketedPaste: boolean }): PasteDecision {
  const text = sanitizePaste(raw).replace(/[\r\n]+$/, '');
  if (!text) return { kind: 'reject', reason: 'Nothing to paste.' };
  if (text.length > MAX_PASTE_CHARS) {
    return { kind: 'reject', reason: `Paste is too large (${text.length.toLocaleString()} characters, max ${MAX_PASTE_CHARS.toLocaleString()}).` };
  }
  if (!ctx.bracketedPaste && /[\r\n]/.test(text)) {
    return { kind: 'confirm', text, lines: text.split(/\r\n|[\r\n]/).length };
  }
  return { kind: 'send', text };
}

// No pastePreview: the bar renders the pending text verbatim in a read-only <textarea>, which needs
// no truncation and therefore no counts. Three attempts at a truncating preview each found a new way
// to hide content without reporting it — a CSS fold, zero-height blank lines, surrogate-split counts
// (tkt-9e3fd0da8398). A textarea holds the whole paste and scrolls it natively.

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
// rest would land as typed input. Bidi/zero-width go too, so the confirmation preview can't render
// differently from the bytes it authorizes.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizePaste(text: string): string {
  return text.replace(UNSAFE_CHARS, '');
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

/** First line of a pending paste, clipped for the confirmation bar. */
export function pastePreview(text: string, maxChars = 60): string {
  const [first = ''] = text.split(/\r\n|[\r\n]/);
  return first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
}

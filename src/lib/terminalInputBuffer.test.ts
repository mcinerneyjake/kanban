import { describe, it, expect } from 'vitest';
import { terminalInputBuffer, canSendInput, frameCapFor, MAX_FRAME_CHARS, MAX_BUFFERED_CHARS } from './terminalInputBuffer.js';
import { MAX_PASTE_CHARS } from './terminalClipboard.js';
import { MAX_INPUT_CHARS } from '../../shared/terminalProtocol.js';
import { parseClientFrame } from '../../server/terminalAuth.js';

describe('terminalInputBuffer', () => {
  it('queues in order and flushes once', () => {
    const buf = terminalInputBuffer();
    expect(buf.queue('l')).toBe(true);
    expect(buf.queue('s')).toBe(true);
    expect(buf.queue('\r')).toBe(true);
    expect(buf.drain()).toEqual(['ls\r']);
    expect(buf.size).toBe(0);
  });

  // Avoiding double-application: a second flush must send nothing, or a reconnect that fires both the
  // onopen and first-byte flush paths would replay the input.
  it('drains empty on a second flush', () => {
    const buf = terminalInputBuffer();
    buf.queue('x');
    expect(buf.drain()).toEqual(['x']);
    expect(buf.drain()).toEqual([]);
  });

  it('drains nothing when nothing was queued', () => {
    expect(terminalInputBuffer().drain()).toEqual([]);
  });

  it('treats empty input as queued, not rejected', () => {
    const buf = terminalInputBuffer();
    expect(buf.queue('')).toBe(true);
    expect(buf.size).toBe(0);
  });

  it('clear() discards without sending', () => {
    const buf = terminalInputBuffer();
    buf.queue('secret');
    buf.clear();
    expect(buf.drain()).toEqual([]);
  });

  describe('the cap', () => {
    it('refuses the NEWEST input and reports it, keeping the coherent prefix', () => {
      const buf = terminalInputBuffer({ maxBuffered: 10, maxFrame: 100 });
      expect(buf.queue('0123456789')).toBe(true);
      expect(buf.queue('z')).toBe(false); // rejected — the caller must surface this
      expect(buf.drain()).toEqual(['0123456789']); // nothing evicted from the middle
    });

    it('accepts input exactly at the cap', () => {
      const buf = terminalInputBuffer({ maxBuffered: 4, maxFrame: 100 });
      expect(buf.queue('abcd')).toBe(true);
      expect(buf.size).toBe(4);
    });

    it('holds a maximum-size paste plus room to type', () => {
      const buf = terminalInputBuffer();
      expect(buf.queue('p'.repeat(MAX_PASTE_CHARS))).toBe(true);
      expect(buf.queue('and some typing')).toBe(true);
    });
  });

  describe('framing against the server cap', () => {
    it('splits a drain into frames the server will accept', () => {
      const buf = terminalInputBuffer({ maxBuffered: MAX_BUFFERED_CHARS, maxFrame: 10 });
      buf.queue('abcdefghij');
      buf.queue('klmno');
      expect(buf.drain()).toEqual(['abcdefghij', 'klmno']);
    });

    it('preserves the exact byte stream across the split', () => {
      const buf = terminalInputBuffer({ maxBuffered: 1000, maxFrame: 7 });
      const stream = 'abcdefghijklmnopqrstuvwxyz';
      for (const ch of stream) buf.queue(ch);
      expect(buf.drain().join('')).toBe(stream);
    });

    // The round trip the ticket asked to pin: every frame a full buffer produces must survive the
    // server's REAL parser. A single concatenated blob would too (64k < 200k), but the framing is what
    // keeps that true if either cap moves.
    it('every frame of a full buffer is accepted by the server\'s parser', () => {
      const buf = terminalInputBuffer();
      buf.queue('p'.repeat(MAX_PASTE_CHARS));
      buf.queue('k'.repeat(MAX_BUFFERED_CHARS - MAX_PASTE_CHARS));
      const frames = buf.drain();
      expect(frames.length).toBeGreaterThan(1); // the split is real, not vacuous
      for (const d of frames) {
        expect(parseClientFrame(JSON.stringify({ t: 'i', d })), `frame of ${d.length}`).toEqual({ t: 'i', d });
      }
    });

    // Mutation-driven: an earlier version of this test asserted only
    // `MAX_FRAME_CHARS === Math.floor(MAX_INPUT_CHARS / 4)`, and replacing the derivation with a literal
    // 50_000 kept it green — the two are equal today, so it could not detect the very drift it claimed to
    // guard. Asserting the FUNCTION at a different input is what a copied constant cannot satisfy.
    it('derives the frame cap from the server\'s, and tracks it if it moves', () => {
      expect(MAX_FRAME_CHARS).toBe(frameCapFor(MAX_INPUT_CHARS));
      expect(frameCapFor(400_000)).toBe(100_000);
      expect(frameCapFor(9)).toBe(2); // floors rather than producing a fractional cap
    });

    it('keeps the buffer cap between one max paste and the server frame cap', () => {
      expect(MAX_BUFFERED_CHARS).toBeGreaterThan(MAX_PASTE_CHARS);
      expect(MAX_BUFFERED_CHARS).toBeLessThan(MAX_INPUT_CHARS);
    });
  });
});

// The gate that decides buffer-vs-send. Extracted from the widget so the one line authorising a write to
// the wire is assertable at all — the widget itself needs a DOM this suite does not have.
describe('canSendInput', () => {
  const [CONNECTING, OPEN, CLOSING, CLOSED] = [0, 1, 2, 3];

  it('sends only on an OPEN socket with a live pty', () => {
    expect(canSendInput(OPEN, false)).toBe(true);
  });

  it('buffers while the socket is not OPEN', () => {
    for (const state of [CONNECTING, CLOSING, CLOSED]) {
      expect(canSendInput(state, false), `readyState ${state}`).toBe(false);
    }
  });

  it('buffers while a reattach\'s pty is still being created, even though the socket is OPEN', () => {
    // The non-obvious half: readyState alone would send here, into the same race that loses the resize.
    expect(canSendInput(OPEN, true)).toBe(false);
  });

  it('buffers when there is no socket at all', () => {
    expect(canSendInput(undefined, false)).toBe(false);
  });
});

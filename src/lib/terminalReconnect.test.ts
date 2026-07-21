import { describe, it, expect } from 'vitest';
import { classifyClose, reconnectDelayMs, RECONNECT } from './terminalReconnect';

describe('classifyClose', () => {
  const base = { wasOpen: true, hasEverOpened: true, attempts: 0, maxAttempts: 8 };

  it('an intentional server close (1000 or 1005) on an opened socket dismisses the widget', () => {
    // 1005 is the real-world code: the server bare-closes (ws.close() with no code) on session end.
    expect(classifyClose({ ...base, code: 1000 })).toBe('dismiss');
    expect(classifyClose({ ...base, code: 1005 })).toBe('dismiss');
  });

  it('an intentional close that never opened is an error, not a silent dismiss', () => {
    expect(classifyClose({ ...base, code: 1000, wasOpen: false })).toBe('error');
    expect(classifyClose({ ...base, code: 1005, wasOpen: false })).toBe('error');
  });

  it('a genuine claude exit (server bare-close ⇒ 1005) does NOT reconnect/respawn a container', () => {
    // Regression guard: treating 1005 as abnormal would reconnect to a disposed session, which the
    // server routes to the NEW-session path — silently spawning a fresh container on every exit.
    expect(classifyClose({ ...base, code: 1005, wasOpen: true, hasEverOpened: true, attempts: 0 })).toBe('dismiss');
  });

  it('an abnormal drop (1006) after the session opened reconnects while attempts remain', () => {
    expect(classifyClose({ ...base, code: 1006, attempts: 0 })).toBe('reconnect');
    expect(classifyClose({ ...base, code: 1006, attempts: 7, maxAttempts: 8 })).toBe('reconnect');
  });

  it('reconnects on an abnormal drop even when THIS socket never opened, as long as one did before', () => {
    // The Express-restart case: the container survives, but a retry can fail to open while the
    // server is still down — that must keep retrying, not error out immediately.
    expect(classifyClose({ ...base, code: 1006, wasOpen: false, hasEverOpened: true, attempts: 2 })).toBe('reconnect');
  });

  it('errors once the retry budget is exhausted', () => {
    expect(classifyClose({ ...base, code: 1006, attempts: 8, maxAttempts: 8 })).toBe('error');
    expect(classifyClose({ ...base, code: 1006, attempts: 9, maxAttempts: 8 })).toBe('error');
  });

  it('an abnormal drop on an initial connect that never opened is an error (no retry storm)', () => {
    expect(classifyClose({ ...base, code: 1006, wasOpen: false, hasEverOpened: false, attempts: 0 })).toBe('error');
  });

  it('treats a proxy-translated abnormal code (1001/1011) as a death → reconnect', () => {
    // A restart behind a proxy may surface as 1001/1011 rather than 1006; those still reconnect.
    for (const code of [1001, 1006, 1011]) {
      expect(classifyClose({ ...base, code, hasEverOpened: true, attempts: 0 })).toBe('reconnect');
    }
  });
});

describe('reconnectDelayMs', () => {
  it('grows exponentially from the base and clamps to the cap', () => {
    const opts = { baseMs: 500, capMs: 5000 };
    expect(reconnectDelayMs(0, opts)).toBe(500);
    expect(reconnectDelayMs(1, opts)).toBe(1000);
    expect(reconnectDelayMs(2, opts)).toBe(2000);
    expect(reconnectDelayMs(3, opts)).toBe(4000);
    expect(reconnectDelayMs(4, opts)).toBe(5000); // 8000 clamped
    expect(reconnectDelayMs(10, opts)).toBe(5000); // stays clamped
  });

  it('guards a negative attempt to the base delay', () => {
    expect(reconnectDelayMs(-3, { baseMs: 500, capMs: 5000 })).toBe(500);
  });

  it('the shipped RECONNECT budget covers a multi-second restart (~27s total)', () => {
    const total = Array.from({ length: RECONNECT.maxAttempts }, (_, i) => reconnectDelayMs(i, RECONNECT))
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(20_000); // comfortably longer than a tsx-watch Express restart
  });
});

import { describe, it, expect } from 'vitest';
import { classifyClose, reconnectDelayMs, RECONNECT, overlayFor, liveMessageFor } from './terminalReconnect';
import { TERMINAL_STARTUP_FAILURE_CODE, TERMINAL_REATTACH_FAILED_CODE } from '../../shared/constants';

describe('classifyClose', () => {
  const base = { hasEverOpened: true, attempts: 0, maxAttempts: 8 };

  it('the server startup-failure code keeps the widget as an error, not a silent dismiss (tkt-171759eb29f6)', () => {
    // The server closes with TERMINAL_STARTUP_FAILURE_CODE when the container never started (docker
    // down / image missing / dtach never ready). This is decided by the CODE, not by client timing —
    // so a slow startup failure (>2.5s) surfaces an error instead of silently self-dismissing.
    expect(classifyClose({ ...base, code: TERMINAL_STARTUP_FAILURE_CODE })).toBe('error');
    // Even with a full retry budget and a long-lived prior connection, a startup failure never retries.
    expect(classifyClose({ ...base, code: TERMINAL_STARTUP_FAILURE_CODE, hasEverOpened: true, attempts: 0 })).toBe('error');
  });

  it('the reattach-failed code keeps the widget as an error, and never retries (tkt-42a6d95a92d1)', () => {
    // The server signals TERMINAL_REATTACH_FAILED_CODE when it can't rejoin an existing session (dead
    // adopted container / spawn failure / disposed mid-reattach). Show an error, not a silent dismiss —
    // and not a reconnect: it must be 'error' even with a full retry budget, since the server already
    // waited for the container and retrying would only spin.
    expect(classifyClose({ ...base, code: TERMINAL_REATTACH_FAILED_CODE })).toBe('error');
    expect(classifyClose({ ...base, code: TERMINAL_REATTACH_FAILED_CODE, attempts: 0, maxAttempts: 8 })).toBe('error');
  });

  it('an intentional server close (1000 or 1005) dismisses the widget', () => {
    // 1005 is the real-world code: the server bare-closes (ws.close() with no code) on a clean end.
    expect(classifyClose({ ...base, code: 1000 })).toBe('dismiss');
    expect(classifyClose({ ...base, code: 1005 })).toBe('dismiss');
  });

  it('a genuine claude exit (server bare-close ⇒ 1005) does NOT reconnect/respawn a container', () => {
    // Regression guard: treating 1005 as abnormal would reconnect to a disposed session, which the
    // server routes to the NEW-session path — silently spawning a fresh container on every exit.
    expect(classifyClose({ ...base, code: 1005, hasEverOpened: true, attempts: 0 })).toBe('dismiss');
  });

  it('an abnormal drop (1006) after the session opened reconnects while attempts remain', () => {
    expect(classifyClose({ ...base, code: 1006, attempts: 0 })).toBe('reconnect');
    expect(classifyClose({ ...base, code: 1006, attempts: 7, maxAttempts: 8 })).toBe('reconnect');
  });

  it('reconnects on an abnormal drop as long as a socket opened before', () => {
    // The Express-restart case: the container survives, but a retry can fail to open while the
    // server is still down — that must keep retrying, not error out immediately.
    expect(classifyClose({ ...base, code: 1006, hasEverOpened: true, attempts: 2 })).toBe('reconnect');
  });

  it('errors once the retry budget is exhausted', () => {
    expect(classifyClose({ ...base, code: 1006, attempts: 8, maxAttempts: 8 })).toBe('error');
    expect(classifyClose({ ...base, code: 1006, attempts: 9, maxAttempts: 8 })).toBe('error');
  });

  it('an abnormal drop on an initial connect that never opened is an error (no retry storm)', () => {
    expect(classifyClose({ ...base, code: 1006, hasEverOpened: false, attempts: 0 })).toBe('error');
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

describe('overlayFor', () => {
  it('keeps the initial pre-boot connect showing "Loading terminal…"', () => {
    expect(overlayFor('connecting', false)).toBe('Loading terminal…');
    expect(overlayFor('open', false)).toBe('Loading terminal…'); // opened but no frame settled yet
  });

  it('shows NO overlay for a booted reconnect — the whole point (frozen frame stays visible)', () => {
    expect(overlayFor('connecting', true)).toBeNull();
  });

  it('shows no overlay for a booted, connected session', () => {
    expect(overlayFor('open', true)).toBeNull();
    expect(overlayFor('closed', true)).toBeNull();
  });

  it('shows "Terminal unavailable" on error regardless of booted (failure wins over a stale frame)', () => {
    expect(overlayFor('error', true)).toBe('Terminal unavailable');
    expect(overlayFor('error', false)).toBe('Terminal unavailable');
  });
});

describe('liveMessageFor', () => {
  it('stays silent for the initial pre-boot connect (the Loading overlay already conveys it)', () => {
    expect(liveMessageFor('connecting', false)).toBe('');
    expect(liveMessageFor('open', false)).toBe('');
  });

  it('announces a booted drop and recovery so SR users learn of the now-silent reconnect', () => {
    expect(liveMessageFor('connecting', true)).toBe('Reconnecting to terminal');
    expect(liveMessageFor('open', true)).toBe('Terminal connected');
  });

  it('announces failure', () => {
    expect(liveMessageFor('error', true)).toBe('Terminal unavailable');
    expect(liveMessageFor('error', false)).toBe('Terminal unavailable');
  });

  it('says nothing for a booted "closed" (no such transition is set, but must not throw/announce)', () => {
    expect(liveMessageFor('closed', true)).toBe('');
  });
});

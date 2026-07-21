// Client reconnect policy for the embedded terminal (tkt-af8e94856264).
//
// When the terminal WebSocket drops we must tell three cases apart: the session genuinely ended
// (claude exited / the user terminated), the server restarted but the container survives (S3a — so a
// reconnect will reattach), or the container failed to START. The decision keys off the WS close code
// alone, and is a pure function so it's unit-tested without a real socket. The component owns the
// timers and side effects.

import { TERMINAL_STARTUP_FAILURE_CODE } from '../../shared/constants.js';

export interface CloseContext {
  code: number;           // WS close code (see classifyClose)
  hasEverOpened: boolean; // has ANY socket for this mount opened (⇒ a container exists to reattach to)
  attempts: number;       // reconnect attempts already spent
  maxAttempts: number;
}

export type CloseAction = 'dismiss' | 'reconnect' | 'error';

// Decide the fate of a dropped terminal socket from its close code:
//   • TERMINAL_STARTUP_FAILURE_CODE (4500) — the server's explicit signal that the container/session
//     failed to start. The WS handshake completes before `docker run` fails, so we CANNOT infer this
//     from a bare-close 1005 by client-side timing (that heuristic silently self-dismissed on slow
//     startup failures — tkt-171759eb29f6). Surface an error and KEEP the widget so the failure shows.
//   • 1005 ("no status received", the browser's report of a codeless `ws.close()`) or 1000 — an
//     INTENTIONAL close of a session that actually ran (claude exited / the client sent a terminate
//     frame). Dismiss the widget.
//   • Anything else — notably 1006 (NO close frame ⇒ the Express process died on a restart), or a
//     proxy-translated abnormal code (1001/1011/…) — is a socket DEATH while the container may still
//     live (S3a): reconnect while attempts remain. A never-opened death is an initial-connect failure
//     and an exhausted retry budget is a real outage — both surface an error.
export function classifyClose(ctx: CloseContext): CloseAction {
  if (ctx.code === TERMINAL_STARTUP_FAILURE_CODE) return 'error';
  const intentional = ctx.code === 1000 || ctx.code === 1005;
  if (intentional) return 'dismiss';
  if (ctx.hasEverOpened && ctx.attempts < ctx.maxAttempts) return 'reconnect';
  return 'error';
}

// Exponential backoff with a ceiling: baseMs * 2^attempt, clamped to capMs. `attempt` is 0-based
// (the first reconnect waits baseMs). Guards a negative attempt to baseMs.
export function reconnectDelayMs(attempt: number, opts: { baseMs: number; capMs: number }): number {
  const raw = opts.baseMs * 2 ** Math.max(0, attempt);
  return Math.min(raw, opts.capMs);
}

export const RECONNECT = { maxAttempts: 8, baseMs: 500, capMs: 5000 } as const;

// ── Overlay + screen-reader announcements (seamless reconnect, tkt-83e3d9a107a5) ─────────────────
//
// Connection state the widget derives its UI from. `booted` = at least one frame has rendered (so a
// last frame is sitting in the preserved xterm buffer). The reconnect UX hinges on ONE decision:
// once booted, a `connecting` state shows NO overlay — we keep the frozen last frame visible and let
// the header status dot carry the signal, so an Express-restart reconnect looks like Claude simply
// kept thinking. Pure so it's unit-tested (the component can't be — vitest runs in node, no DOM).

export type TerminalStatus = 'connecting' | 'open' | 'closed' | 'error';

// The body overlay text, or null for "show the terminal frame". Precedence: a real failure wins
// (opaque "Terminal unavailable" over a now-stale frame); then the initial pre-boot connect shows
// "Loading terminal…" (no frame yet to preserve); otherwise null — including a BOOTED reconnect,
// which is the whole point (keep the last frame, no "Reconnecting…" curtain).
export function overlayFor(status: TerminalStatus, booted: boolean): 'Terminal unavailable' | 'Loading terminal…' | null {
  if (status === 'error') return 'Terminal unavailable';
  if (!booted) return 'Loading terminal…';
  return null;
}

// Polite live-region text so screen-reader users still learn of a reconnect once the visual cue is
// only a dot. Empty ⇒ announce nothing. Keyed on `booted` so the initial connect stays silent (the
// "Loading terminal…" overlay already conveys it) and only a booted session announces drop/recovery.
export function liveMessageFor(status: TerminalStatus, booted: boolean): string {
  if (status === 'error') return 'Terminal unavailable';
  if (!booted) return '';
  if (status === 'connecting') return 'Reconnecting to terminal';
  if (status === 'open') return 'Terminal connected';
  return '';
}

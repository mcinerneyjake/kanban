// Client reconnect policy for the embedded terminal (tkt-af8e94856264).
//
// When the terminal WebSocket drops we must tell three cases apart: the session genuinely ended
// (claude exited / the user terminated), the server restarted but the container survives (S3a — so a
// reconnect will reattach), or an initial connect never succeeded. The decision keys off the WS close
// code + whether the socket had ever opened, and is a pure function so it's unit-tested without a
// real socket. The component owns the timers and side effects.

export interface CloseContext {
  code: number;           // WS close code — 1000 = a clean server-initiated close
  wasOpen: boolean;       // did THIS socket reach onopen before closing
  hasEverOpened: boolean; // has ANY socket for this mount opened (⇒ a container exists to reattach to)
  attempts: number;       // reconnect attempts already spent
  maxAttempts: number;
}

export type CloseAction = 'dismiss' | 'reconnect' | 'error';

// Distinguish an INTENTIONAL server close from a socket DEATH by the close code:
//   • 1005 ("no status received") is what the browser reports when the server bare-closes with
//     `ws.close()` and no code — which is exactly how this server ends a session (claude exited /
//     the client sent a terminate frame). A close FRAME arrived, so the server meant it.
//   • 1000 is the explicit-normal equivalent (belt-and-suspenders if the server ever sets a code).
//   • Anything else — notably 1006 (NO close frame at all ⇒ the Express process died on a restart),
//     or a proxy-translated abnormal code (1001/1011/…) — means the socket dropped while the
//     server-side container may still live (S3a). That is the reconnect trigger.
// Intentional → dismiss the widget (or error if it never opened). Death → reconnect while attempts
// remain (the container survives a restart); a never-opened death is an initial connect failure, and
// an exhausted retry budget is a real outage — both surface an error.
export function classifyClose(ctx: CloseContext): CloseAction {
  const intentional = ctx.code === 1000 || ctx.code === 1005;
  if (intentional) return ctx.wasOpen ? 'dismiss' : 'error';
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

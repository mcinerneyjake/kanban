// Health of the board's SSE stream, derived from the EventSource events the browser hands us
// (tkt-ea0d1ed1d5d2).
//
// `error` is NOT a failure signal on its own: EventSource fires it on every transient blip while it
// is still auto-reconnecting, and only a readyState of CLOSED means the browser has given up for
// good. Reacting to the bare event would cry wolf on every network hiccup; ignoring readyState
// entirely — what the board did before this — leaves a permanently dead stream rendering stale
// tickets with no sign at all.
//
// Pure so it is unit-tested: vitest runs `environment: 'node'`, where there is no DOM and no global
// EventSource, so the component itself cannot be. Same constraint and same split as
// terminalReconnect.ts — the decision lives here, the side effects live in the component.

// WHATWG readyState values. Spelled out rather than read off `EventSource` because this module is
// imported by a node-hosted test suite where that global does not exist. Fixed by the standard.
export const SSE_CONNECTING = 0;
export const SSE_OPEN = 1;
export const SSE_CLOSED = 2;

export type StreamHealth = 'live' | 'dead';

export type StreamEvent = 'open' | 'error';

// An observed `open` is the ONLY thing that clears a dead stream — never the mere fact that a new
// EventSource was constructed, which would render "I can't tell yet" as "the stream is fine".
export function nextStreamHealth(current: StreamHealth, event: StreamEvent, readyState: number): StreamHealth {
  if (event === 'open') return 'live';
  if (readyState === SSE_CLOSED) return 'dead';
  return current;
}

import { describe, it, expect } from 'vitest';
import {
  nextStreamHealth,
  SSE_CONNECTING,
  SSE_OPEN,
  SSE_CLOSED,
  type StreamHealth,
} from './streamHealth';

describe('nextStreamHealth', () => {
  it('marks the stream dead when an error arrives with the connection CLOSED (tkt-ea0d1ed1d5d2)', () => {
    // The repro. CLOSED means EventSource has stopped retrying, so the board is rendering tickets
    // that will never update again. Before the fix this returned 'live' and the UI said nothing.
    expect(nextStreamHealth('live', 'error', SSE_CLOSED)).toBe('dead');
  });

  it('stays live on an error while the browser is still auto-reconnecting', () => {
    // CONNECTING = a transient blip with a retry already scheduled. Banner-ing here would fire on
    // every laptop sleep and every proxy hiccup, which is how a real warning gets tuned out.
    expect(nextStreamHealth('live', 'error', SSE_CONNECTING)).toBe('live');
  });

  it('stays live on an error that arrives while the connection is still OPEN', () => {
    expect(nextStreamHealth('live', 'error', SSE_OPEN)).toBe('live');
  });

  it('clears back to live only on an observed open', () => {
    expect(nextStreamHealth('dead', 'open', SSE_OPEN)).toBe('live');
  });

  it('is idempotent on a repeated open', () => {
    expect(nextStreamHealth('live', 'open', SSE_OPEN)).toBe('live');
  });

  it('does NOT clear a dead stream on a non-dispositive error', () => {
    // The fail-open case: once dead, only an `open` may clear it. An error carrying a readyState
    // that is not CLOSED must leave the warning standing rather than quietly withdrawing it.
    expect(nextStreamHealth('dead', 'error', SSE_CONNECTING)).toBe('dead');
    expect(nextStreamHealth('dead', 'error', SSE_OPEN)).toBe('dead');
  });

  it('leaves health unchanged on a readyState outside the spec, in both directions', () => {
    // readyState is spec-constrained to 0|1|2, so this is unreachable in a conforming browser. It is
    // pinned anyway so the behaviour is a decision rather than an accident: an unrecognised value is
    // "still trying", never a reason to raise a banner and never a reason to withdraw one.
    expect(nextStreamHealth('live', 'error', 99)).toBe('live');
    expect(nextStreamHealth('dead', 'error', 99)).toBe('dead');
    expect(nextStreamHealth('live', 'error', -1)).toBe('live');
  });

  it('survives a full drop-and-recover cycle', () => {
    // Ordering matters as much as the individual verdicts: the sequence a real outage produces is
    // blip → give up → come back, and the banner must appear once and clear once.
    let health: StreamHealth = 'live';
    health = nextStreamHealth(health, 'error', SSE_CONNECTING);
    expect(health).toBe('live');
    health = nextStreamHealth(health, 'error', SSE_CLOSED);
    expect(health).toBe('dead');
    health = nextStreamHealth(health, 'error', SSE_CLOSED);
    expect(health).toBe('dead');
    health = nextStreamHealth(health, 'open', SSE_OPEN);
    expect(health).toBe('live');
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  registerClient, broadcast, streamClientCount, closeAllStreamClients,
  type SseClient,
} from './stream.js';

// A minimal SseClient that records what the hub writes to it. The hub only ever
// calls writeHead/write/end (+ reads `destroyed`), so this fully stands in for
// an Express Response without opening a socket.
function fakeClient(opts: { throwOnWrite?: boolean; destroyed?: boolean } = {}) {
  const writes: string[] = [];
  const headers: Record<string, string>[] = [];
  let ended = false;
  const client: SseClient = {
    writeHead: (_status, h) => { headers.push(h); },
    write: (chunk) => {
      // Model a socket that dies AFTER connecting: the opening comment succeeds,
      // but a later broadcast frame (event:/heartbeat) fails.
      if (opts.throwOnWrite && chunk.startsWith('event:')) throw new Error('socket gone');
      writes.push(chunk);
      return true;
    },
    end: () => { ended = true; },
    destroyed: opts.destroyed,
  };
  return {
    client, headers, writes,
    isEnded: () => ended,
    refreshes: () => writes.filter((w) => w.startsWith('event: refresh')),
    pings: () => writes.filter((w) => w.startsWith(': ping')),
  };
}

// The hub holds module-level state; reset it between tests.
afterEach(() => closeAllStreamClients());

describe('SSE hub', () => {
  it('registers a client: sends stream headers + opening comment, counts it', () => {
    const c = fakeClient();
    registerClient(c.client);
    expect(streamClientCount()).toBe(1);
    expect(c.headers[0]?.['Content-Type']).toBe('text/event-stream');
    expect(c.headers[0]?.['Cache-Control']).toBe('no-cache');
    expect(c.writes[0]).toBe(': connected\n\n');
  });

  it('broadcasts a refresh event to every registered client', () => {
    const a = fakeClient();
    const b = fakeClient();
    registerClient(a.client);
    registerClient(b.client);
    broadcast('refresh');
    expect(a.refreshes()).toEqual(['event: refresh\ndata: {}\n\n']);
    expect(b.refreshes()).toEqual(['event: refresh\ndata: {}\n\n']);
  });

  it('unregister removes the client (no leak) and stops it receiving broadcasts', () => {
    const c = fakeClient();
    const unregister = registerClient(c.client);
    expect(streamClientCount()).toBe(1);
    unregister();
    expect(streamClientCount()).toBe(0);
    broadcast('refresh');
    expect(c.refreshes()).toEqual([]);
  });

  it('drops a client whose write throws (dead socket) instead of throwing', () => {
    const good = fakeClient();
    const dead = fakeClient({ throwOnWrite: true });
    registerClient(good.client);
    registerClient(dead.client);
    expect(streamClientCount()).toBe(2);
    expect(() => broadcast('refresh')).not.toThrow();
    expect(streamClientCount()).toBe(1);       // dead one reaped
    expect(good.refreshes()).toHaveLength(1);   // live one still served
  });

  it('closeAllStreamClients ends every response and clears the set', () => {
    const a = fakeClient();
    const b = fakeClient();
    registerClient(a.client);
    registerClient(b.client);
    closeAllStreamClients();
    expect(streamClientCount()).toBe(0);
    expect(a.isEnded()).toBe(true);
    expect(b.isEnded()).toBe(true);
  });
});

describe('SSE heartbeat + dead-client sweep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { closeAllStreamClients(); vi.useRealTimers(); });

  it('sends a `: ping` to clients on each heartbeat interval', () => {
    const c = fakeClient();
    registerClient(c.client);
    expect(c.pings()).toHaveLength(0);        // opening ': connected' only, no ping yet
    vi.advanceTimersByTime(25_000);
    expect(c.pings()).toHaveLength(1);
    vi.advanceTimersByTime(25_000);
    expect(c.pings()).toHaveLength(2);
  });

  it('stops the heartbeat once the last client unregisters (no further pings)', () => {
    const c = fakeClient();
    const unregister = registerClient(c.client);
    vi.advanceTimersByTime(25_000);
    const before = c.pings().length;
    unregister();
    vi.advanceTimersByTime(75_000);           // three more intervals would elapse
    expect(c.pings()).toHaveLength(before);   // but the heartbeat was stopped
  });

  it('reaps a `destroyed` client on the next heartbeat tick (past close/error)', () => {
    const live = fakeClient();
    const dead = fakeClient({ destroyed: true }); // socket gone, listeners missed it
    registerClient(live.client);
    registerClient(dead.client);
    expect(streamClientCount()).toBe(2);
    vi.advanceTimersByTime(25_000);           // heartbeat sweeps the destroyed one
    expect(streamClientCount()).toBe(1);
    expect(live.pings()).toHaveLength(1);
  });

  it('broadcast also drops a destroyed client without writing to it', () => {
    const dead = fakeClient({ destroyed: true });
    registerClient(dead.client);
    broadcast('refresh');
    expect(streamClientCount()).toBe(0);
    expect(dead.refreshes()).toHaveLength(0);
  });
});

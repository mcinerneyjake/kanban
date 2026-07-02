import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleFsEvent, startTicketWatcher, stopTicketWatcher } from './ticketWatcher.js';
import { registerClient, closeAllStreamClients, type SseClient } from './stream.js';

// Observe broadcasts by registering a real hub client and counting the refresh
// frames it receives — this exercises handleFsEvent -> debounce -> broadcast end
// to end without mocking the hub.
function fakeClient() {
  const writes: string[] = [];
  const client: SseClient = {
    writeHead: () => { /* headers ignored */ },
    write: (chunk) => { writes.push(chunk); return true; },
    end: () => { /* nothing to clean up */ },
  };
  return { client, refreshes: () => writes.filter((w) => w.startsWith('event: refresh')) };
}

describe('handleFsEvent (filter + debounce)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    closeAllStreamClients();
    vi.useRealTimers();
  });

  it('broadcasts one refresh for a .md change after the debounce window', () => {
    const c = fakeClient();
    registerClient(c.client);
    handleFsEvent('/tickets/tkt-abc.md');
    expect(c.refreshes()).toHaveLength(0);   // debounced, not yet fired
    vi.advanceTimersByTime(100);
    expect(c.refreshes()).toHaveLength(1);
  });

  it('coalesces a burst of .md writes into a single refresh', () => {
    const c = fakeClient();
    registerClient(c.client);
    handleFsEvent('/tickets/a.md');
    handleFsEvent('/tickets/b.md');
    handleFsEvent('/tickets/c.md');
    vi.advanceTimersByTime(100);
    expect(c.refreshes()).toHaveLength(1);
  });

  it('ignores non-.md paths — the atomic-write .tmp files and anything else', () => {
    const c = fakeClient();
    registerClient(c.client);
    handleFsEvent('/tickets/tkt-abc.md.12345.uuid.tmp');
    handleFsEvent('/tickets/notes.json');
    vi.advanceTimersByTime(100);
    expect(c.refreshes()).toHaveLength(0);
  });
});

describe('stopTicketWatcher lifecycle', () => {
  it('resolves without throwing when the watcher was never started', async () => {
    await expect(stopTicketWatcher()).resolves.toBeUndefined();
  });

  it('starts then stops cleanly, and a second stop is a no-op', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-watch-test-'));
    process.env.TICKETS_DIR_OVERRIDE = dir;
    try {
      startTicketWatcher();
      startTicketWatcher();                     // idempotent: second start is a no-op
      await expect(stopTicketWatcher()).resolves.toBeUndefined();
      await expect(stopTicketWatcher()).resolves.toBeUndefined();
    } finally {
      delete process.env.TICKETS_DIR_OVERRIDE;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

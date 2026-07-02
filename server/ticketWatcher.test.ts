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
  afterEach(async () => {
    await stopTicketWatcher();   // cancel any pending debounce timer before restoring clocks
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

  it('stopTicketWatcher cancels a pending debounce (no late broadcast)', async () => {
    const c = fakeClient();
    registerClient(c.client);
    handleFsEvent('/tickets/tkt-abc.md');       // schedules the debounced broadcast
    await stopTicketWatcher();                  // must clear the pending timer
    vi.advanceTimersByTime(1000);
    expect(c.refreshes()).toHaveLength(0);
  });
});

// Real chokidar + real fs events (no fake timers) — proves the wiring the unit
// tests stub: options, on('all'), the mkdir-on-start fix, and restart.
describe('startTicketWatcher (integration, real fs)', () => {
  let base: string | null = null;

  afterEach(async () => {
    await stopTicketWatcher();
    closeAllStreamClients();
    delete process.env.TICKETS_DIR_OVERRIDE;
    if (base) { await fs.rm(base, { recursive: true, force: true }); base = null; }
  });

  // Re-touch the ticket file until the debounced broadcast reaches the client —
  // no fixed sleeps; tolerates chokidar's initial settle + the 100ms debounce.
  async function expectRefreshOnWrite(dir: string, name: string, c: ReturnType<typeof fakeClient>) {
    await vi.waitFor(async () => {
      await fs.writeFile(path.join(dir, name), '---\ntitle: X\n---\n');
      expect(c.refreshes().length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000, interval: 100 });
  }

  it('creates a missing tickets dir on start and broadcasts on a real .md write', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-watch-int-'));
    const dir = path.join(base, 'tickets');     // deliberately does NOT exist yet
    process.env.TICKETS_DIR_OVERRIDE = dir;

    const c = fakeClient();
    registerClient(c.client);
    startTicketWatcher();                        // must mkdir(dir), else the watch is dead
    await expectRefreshOnWrite(dir, 'tkt-int.md', c);
  });

  it('re-attaches after a stop — restart is not wedged', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-watch-int2-'));
    process.env.TICKETS_DIR_OVERRIDE = base;

    const c = fakeClient();
    registerClient(c.client);
    startTicketWatcher();
    await stopTicketWatcher();
    startTicketWatcher();                        // must attach a fresh watcher
    await expectRefreshOnWrite(base, 'tkt-int2.md', c);
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

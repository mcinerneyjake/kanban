import { mkdirSync } from 'node:fs';
import { watch, type FSWatcher } from 'chokidar';
import { getTicketsDir } from './tickets.js';
import { broadcast } from './stream.js';

// Filesystem watcher: any change under tickets/ → one debounced 'refresh'
// broadcast. Watching the fs (not emitting from writeTicket) is REQUIRED: the MCP
// server is a separate process, so the filesystem is the only channel both share.

// Coalesce a burst of writes into one broadcast — bulk ops (archive, delete
// cleanup) Promise.all many writes; without this each fans out a full refetch.
const DEBOUNCE_MS = 100;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBroadcast(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; broadcast('refresh'); }, DEBOUNCE_MS);
  // unref so a pending broadcast doesn't hold the event loop open — a shutdown between write and fire exits cleanly.
  if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
}

// Testable core: only .md ticket files trigger a refresh — skips atomic-write
// temp files (*.tmp) as a second line behind chokidar's ignored option.
export function handleFsEvent(filePath: string): void {
  if (!filePath.endsWith('.md')) return;
  scheduleBroadcast();
}

let watcher: FSWatcher | null = null;

// Start watching the tickets dir. No-op if already running; uses getTicketsDir() so the override is honoured.
export function startTicketWatcher(): void {
  if (watcher) return;
  const dir = getTicketsDir();
  // chokidar silently no-ops on a missing dir. tickets/ is gitignored (absent on a
  // fresh clone, created lazily), so the watcher would attach to nothing until restart — mkdir first.
  mkdirSync(dir, { recursive: true });
  watcher = watch(dir, {
    ignoreInitial: true,                          // don't fire for existing files at boot
    ignored: (p: string) => p.endsWith('.tmp'),   // skip atomic-write temp files
    depth: 0,                                      // flat dir; no recursion
  });
  watcher.on('all', (_event, filePath) => handleFsEvent(filePath));
  // Tear down on a fatal error so the `if (watcher) return` guard can't wedge recovery — a restart re-attaches a fresh watcher.
  watcher.on('error', (err) => {
    console.error('[watch] error', err);
    void stopTicketWatcher();
  });
}

// Stop the watcher + cancel any pending debounce. Idempotent.
export async function stopTicketWatcher(): Promise<void> {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) {
    const w = watcher;
    watcher = null;
    await w.close();
  }
}

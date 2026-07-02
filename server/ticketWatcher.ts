import { watch, type FSWatcher } from 'chokidar';
import { getTicketsDir } from './tickets.js';
import { broadcast } from './stream.js';

// ---------------------------------------------------------------------------
// Filesystem watcher: turns any change under tickets/ into a single debounced
// `refresh` broadcast. Watching the fs (rather than emitting from writeTicket)
// is REQUIRED, not just convenient: the MCP server runs as a separate process
// (npx tsx mcp/server.ts over stdio), so its writes never reach this process's
// memory — the filesystem is the only channel both share. See the ticket.
// ---------------------------------------------------------------------------

// Coalesce a burst of writes into one broadcast. Bulk ops (archiveStaleTickets,
// deleteTicket's blocker cleanup) Promise.all many writes at once; without this
// each would fan out a full board refetch to every client.
const DEBOUNCE_MS = 100;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBroadcast(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; broadcast('refresh'); }, DEBOUNCE_MS);
  // Don't let a pending broadcast hold the event loop open (mirrors the
  // heartbeat interval in stream.ts) — a shutdown between write and fire exits
  // cleanly instead of hanging for the debounce window.
  if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
}

// The testable core: decide whether a changed path warrants a refresh, then
// debounce. Only `.md` ticket files count — this skips the atomic-write temp
// files (`*.tmp`, see writeTicket) as a second line of defence behind chokidar's
// `ignored` option, and anything else that lands in the dir.
export function handleFsEvent(filePath: string): void {
  if (!filePath.endsWith('.md')) return;
  scheduleBroadcast();
}

let watcher: FSWatcher | null = null;

// Start watching the tickets dir. No-op if already running. Reads the dir via
// getTicketsDir() so TICKETS_DIR_OVERRIDE is honoured.
export function startTicketWatcher(): void {
  if (watcher) return;
  watcher = watch(getTicketsDir(), {
    ignoreInitial: true,                          // don't fire for existing files at boot
    ignored: (p: string) => p.endsWith('.tmp'),   // skip atomic-write temp files
    depth: 0,                                      // flat dir; no recursion
  });
  watcher.on('all', (_event, filePath) => handleFsEvent(filePath));
  watcher.on('error', (err) => console.error('[watch] error', err));
}

// Stop the watcher and cancel any pending debounce. Idempotent and safe to call
// when never started (mirrors stopArchiveScheduler).
export async function stopTicketWatcher(): Promise<void> {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) {
    const w = watcher;
    watcher = null;
    await w.close();
  }
}

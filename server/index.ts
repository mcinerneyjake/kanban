import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app } from './app.js';
import { scheduleWeeklyArchive, stopArchiveScheduler, msUntilNextSundayEvening } from './archiveScheduler.js';
import { startTicketWatcher, stopTicketWatcher } from './ticketWatcher.js';
import { closeAllStreamClients } from './stream.js';
import { getTicketIndex } from '../agent/retrieval/indexCache.js';

// Process entrypoint. Assembly moved to app.ts and the archive scheduler to
// archiveScheduler.ts; these re-exports keep ./index.js a stable import surface
// for tests and tooling.
export { app, scheduleWeeklyArchive, stopArchiveScheduler, msUntilNextSundayEvening, stopTicketWatcher };

// Only bind port and start the scheduler when run directly, not when imported in tests.
/* v8 ignore start -- process-entry bootstrap, not reachable under test */
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Load local model config if present; tolerate its absence (defaults apply).
  try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }
  scheduleWeeklyArchive();
  // Watch tickets/ so MCP-process and direct-file writes push a live refresh to
  // the board. Started here (not on import) so tests never spin up a real watcher.
  startTicketWatcher();
  // Clean shutdown: stop the timers/watcher and end open SSE responses so a
  // restart doesn't leak a watcher or hang on live connections.
  const shutdown = () => {
    stopArchiveScheduler();
    closeAllStreamClients();
    void stopTicketWatcher().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Kanban API → http://localhost:${PORT}`);
    // Best-effort warm so the first intake search is instant. Free locally; if
    // the embedder is down it silently falls back to a lazy build on first use.
    // Before keeping this on a paid (cloud) embedder, see the cloud-migration
    // notes in agent/indexCache.ts — it re-embeds the whole board on each boot.
    getTicketIndex()
      .then((ix) => console.log(`[intake] index warmed (${ix.size} tickets)`))
      .catch((e: unknown) => console.warn(`[intake] index warm skipped: ${e instanceof Error ? e.message : String(e)}`));
  });
}
/* v8 ignore stop */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app } from './app.js';
import { scheduleWeeklyArchive, stopArchiveScheduler, msUntilNextSundayEvening } from './archiveScheduler.js';
import { startTicketWatcher, stopTicketWatcher } from './ticketWatcher.js';
import { closeAllStreamClients } from './stream.js';
import { getTicketIndex } from '../agent/retrieval/indexCache.js';

// Process entrypoint. Assembly in app.ts, scheduler in archiveScheduler.ts; these
// re-exports keep ./index.js a stable import surface for tests and tooling.
export { app, scheduleWeeklyArchive, stopArchiveScheduler, msUntilNextSundayEvening, stopTicketWatcher };

// Only bind port and start the scheduler when run directly, not when imported in tests.
/* v8 ignore start -- process-entry bootstrap, not reachable under test */
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Load local model config if present; tolerate its absence (defaults apply).
  try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }
  scheduleWeeklyArchive();
  // Watch tickets/ so MCP + direct-file writes push a live refresh. Started here (not on import) so tests never spin up a real watcher.
  startTicketWatcher();
  // Clean shutdown: stop timers/watcher and end open SSE responses so a restart doesn't leak or hang.
  const shutdown = () => {
    stopArchiveScheduler();
    closeAllStreamClients();
    void stopTicketWatcher().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const PORT = process.env.PORT || 3001;
  const server = app.listen(PORT, () => {
    console.log(`Kanban API → http://localhost:${PORT}`);
    // Best-effort warm so the first intake search is instant. Free locally; embedder
    // down → lazy build on first use. On a paid embedder this re-embeds the whole
    // board each boot (see agent/indexCache.ts).
    getTicketIndex()
      .then((ix) => console.log(`[intake] index warmed (${ix.size} tickets)`))
      .catch((e: unknown) => console.warn(`[intake] index warm skipped: ${e instanceof Error ? e.message : String(e)}`));
  });
  // Dev-only embedded terminal (tkt-be809dd2b7fb). Dynamic import so node-pty/ws never load
  // in prod or tests — only under `npm run dev`, which sets KANBAN_TERMINAL=1.
  if (process.env.KANBAN_TERMINAL === '1') {
    const { attachTerminal } = await import('./terminal.js');
    attachTerminal(server);
    console.log('[terminal] embedded terminal enabled → ws /terminal-ws');
  }
}
/* v8 ignore stop */

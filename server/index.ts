import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express, { Request, Response, NextFunction } from 'express';
import {
  listTickets,
  searchTickets,
  listProjects,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
  archiveStaleTickets,
  HttpError,
} from './tickets.js';
import { getTicketIndex } from '../agent/indexCache.js';

// Thin routing layer: parse the request, call the service, shape the response.
// No business logic or file IO lives here.
export const app = express();
app.use(express.json({ limit: '256kb' }));

type AsyncHandler = (req: Request, res: Response) => Promise<void>

// Centralised async error funnel so each handler stays a one-liner and every
// thrown HttpError maps to the right status code.
const wrap = (fn: AsyncHandler) => (req: Request, res: Response, _next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(status).json({ error: message });
  });
};

app.get('/api/projects', wrap(async (_req, res) => {
  res.json(await listProjects());
}));

app.get('/api/tickets', wrap(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  res.json(q ? await searchTickets(q) : await listTickets());
}));

app.get('/api/tickets/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid :id parameter');
  res.json(await getTicket(id));
}));

app.post('/api/tickets', wrap(async (req, res) => {
  res.status(201).json(await createTicket(req.body));
}));

app.patch('/api/tickets/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid :id parameter');
  res.json(await updateTicket(id, req.body));
}));

app.delete('/api/tickets/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid :id parameter');
  await deleteTicket(id);
  res.status(204).end();
}));

app.post('/api/archive', wrap(async (_req, res) => {
  const count = await archiveStaleTickets();
  res.json({ archived: count });
}));

// Semantic search over the board for the Intake UI. Read-only; the embedding
// index is cached server-side. Returns 503 when the embeddings runtime is down.
app.post('/api/intake/search', wrap(async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) throw new HttpError(400, 'query is required');
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : 5;
  try {
    const index = await getTicketIndex();
    res.json({ results: await index.search(query, limit) });
  } catch (err) {
    throw new HttpError(503, `Intake unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}));

// Schedule archiving every Sunday at 6 PM local time.
// Exported for testing — pass a specific `now` to avoid real-clock dependency.
export function msUntilNextSundayEvening(now = new Date()): number {
  const target = new Date(now);
  const day = now.getDay();
  // If it's Sunday and 6 PM hasn't passed yet, fire today; otherwise next Sunday.
  const daysUntilSunday = day === 0 && now.getHours() < 18 ? 0 : (7 - day) % 7 || 7;
  target.setDate(now.getDate() + daysUntilSunday);
  target.setHours(18, 0, 0, 0);
  return target.getTime() - now.getTime();
}

let archiveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleWeeklyArchive() {
  const delay = msUntilNextSundayEvening();
  const days = Math.round(delay / 864e5);
  console.log(`[archive] Next run in ~${days} day(s)`);
  archiveTimer = setTimeout(async () => {
    try { await archiveStaleTickets(); } catch (e) { console.error('[archive] error', e); }
    scheduleWeeklyArchive();
  }, delay);
}

export function stopArchiveScheduler() {
  if (archiveTimer) { clearTimeout(archiveTimer); archiveTimer = null; }
}

// Only bind port and start the scheduler when run directly, not when imported in tests.
/* v8 ignore start -- process-entry bootstrap, not reachable under test */
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Load local model config if present; tolerate its absence (defaults apply).
  try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }
  scheduleWeeklyArchive();
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

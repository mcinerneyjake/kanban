import fs from 'node:fs/promises';
import path from 'node:path';
import { eventsDir } from 'ticket-workflow';
import type { Ticket, BoardTicket } from '../shared/constants.js';

// `completedAt` is DERIVED from the ticket's `done` event, never stored in frontmatter
// (tkt-17dbc816e247). The service emits that event from a single choke point covering MCP and HTTP,
// so a web-UI drag to Done is recorded too. Tickets finished before telemetry existed have no event
// and get null — which must render as "not recorded", never fall back to `updated` (it restamps on
// any edit, so a June completion touched today would read as completed today).

// Keyed by the event file's mtime: a completion timestamp is immutable once written, and the
// uncached join costs +44% on every board load and SSE refetch.
const cache = new Map<string, { mtimeMs: number; completedAt: string | null }>();

// One fd per ticket at once would be ~691 on the live board — a realistic EMFILE under the default
// limit, and an EMFILE here would otherwise degrade into "never completed" (see readDoneAt).
const CONCURRENCY = 32;

export function clearCompletionCache(): void {
  cache.clear();
}

type StepAt = { step: string; at: string }

function isStepAt(v: unknown): v is StepAt {
  return typeof v === 'object' && v !== null
    && 'step' in v && typeof v.step === 'string'
    && 'at' in v && typeof v.at === 'string';
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

// The log is append-only, so a reopened-then-reclosed ticket carries several `done` events.
export function latestDoneAt(events: readonly StepAt[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const e of events) {
    if (e.step !== 'done') continue;
    const ms = Date.parse(e.at);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = e.at;
  }
  return best;
}

function parseEvents(raw: string): StepAt[] {
  const out: StepAt[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isStepAt(parsed)) out.push(parsed);
    } catch { /* a torn final line must not discard the events before it */ }
  }
  return out;
}

// Read here rather than via the package's readEvents. That USED to be because readEvents swallowed
// every readFile error and returned [] (fixed in package v0.9.0, tkt-fc7c6846903d); the reason now
// is the opposite — it throws, and this caller needs a third answer. A 500 propagating from a board
// render is worse than a cell that declines to claim a date, so an unreadable log must return
// `determined: false` ("could not check", never cached) rather than either [] or an exception.
// Caching a false negative would pin the ticket as "not recorded" for the life of the process,
// since its event file never changes again.
//
// Known gap, deliberately not fixed here: it does NOT count discarded lines the way readEvents does
// since v0.10.0, and this path runs for every ticket on every board load — so the widest reader of
// these files is the only blind one. No ticket ref: an unresolvable id is worse than none.
async function readDoneAt(id: string): Promise<{ determined: boolean; at: string | null }> {
  const file = path.join(eventsDir(), `${id}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return { determined: true, at: null }; // genuinely no telemetry
    console.error('[completion] could not read events for', id, err);
    return { determined: false, at: null };
  }
  return { determined: true, at: latestDoneAt(parseEvents(raw)) };
}

async function completedAtFor(id: string): Promise<string | null> {
  const file = path.join(eventsDir(), `${id}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return null; // no events file: pre-telemetry, and cheap enough to re-stat each time
  }
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === mtimeMs) return hit.completedAt;

  const { determined, at } = await readDoneAt(id);
  if (determined) cache.set(id, { mtimeMs, completedAt: at });
  return at;
}

function isCompleted(status: Ticket['status']): boolean {
  return status === 'done' || status === 'archived';
}

export async function withCompletedAt(ticket: BoardTicket): Promise<BoardTicket> {
  return isCompleted(ticket.status) ? { ...ticket, completedAt: await completedAtFor(ticket.id) } : ticket;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Only done/archived tickets are joined — 691 of 882 on the live board, not all of them.
export async function withCompletedAtAll(tickets: BoardTicket[]): Promise<BoardTicket[]> {
  return mapLimited(tickets, CONCURRENCY, (t) => withCompletedAt(t));
}

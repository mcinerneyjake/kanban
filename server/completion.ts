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

// `skipped` rides with the events so no caller here can read the log without it in scope. Note this
// reader's `isStepAt` is far looser than the package's validator — it wants only string `step`/`at`
// — so a step id from a NEWER writer parses fine and is never counted. That is deliberate: these
// discards are structural only, and there is no skew-vs-loss split to mirror (tkt-3d6039df4076).
function parseEvents(raw: string): { events: StepAt[]; skipped: number } {
  const events: StepAt[] = [];
  let skipped = 0;
  const lines = raw.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isStepAt(parsed)) { events.push(parsed); continue; }
      skipped++;
    } catch {
      // A torn line must not discard the events before it, and a torn LAST line is not counted at
      // all: appendEvent terminates every complete record with \n, so a non-empty final chunk is a
      // write in flight. The package reader exempts it for the same reason, and these are the same
      // files — diverging made the two readers contradict each other and left the ticket
      // permanently uncacheable, re-read on every board load forever.
      if (i !== lines.length - 1) skipped++;
    }
  }
  return { events, skipped };
}

// Read here rather than via the package's readEvents. That USED to be because readEvents swallowed
// every readFile error and returned [] (fixed in package v0.9.0, tkt-fc7c6846903d); the reason now
// is the opposite — it throws, and this caller needs a third answer. A 500 propagating from a board
// render is worse than a cell that declines to claim a date, so an unreadable log must return
// `determined: false` ("could not check", never cached) rather than either [] or an exception.
// Caching a false negative would pin the ticket as "not recorded" for the life of the process,
// since its event file never changes again.
//
// `skipped` = lines lost from a log that WAS read. `unreadable` = the log could not be read at all,
// which a line count can never express: zero lines read means zero lines lost, so folding the two
// together reports total loss as a perfectly healthy board.
type Completion = { at: string | null; skipped: number; unreadable: boolean }

async function readDoneAt(id: string): Promise<Completion & { determined: boolean }> {
  const file = path.join(eventsDir(), `${id}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return { determined: true, at: null, skipped: 0, unreadable: false }; // no telemetry
    console.error('[completion] could not read events for', id, err);
    return { determined: false, at: null, skipped: 0, unreadable: true };
  }
  const { events, skipped } = parseEvents(raw);
  // A discarded line makes this answer untrustworthy in the one direction that matters: if the lost
  // line WAS the done event, `at` is null and the board renders "not recorded" for a ticket that
  // was. So it is not `determined` — not wrong, just not cacheable.
  return { determined: skipped === 0, at: latestDoneAt(events), skipped, unreadable: false };
}

async function completedAtFor(id: string): Promise<Completion> {
  const file = path.join(eventsDir(), `${id}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch (err) {
    // Split the errnos exactly as readDoneAt does. Only ENOENT is pre-telemetry; an unconditional
    // catch here turned a directory that lost its execute bit — or an EMFILE storm across the 32
    // concurrent stats this file already anticipates — into "never completed" for every done ticket,
    // board-wide and silent.
    if (isNotFound(err)) return { at: null, skipped: 0, unreadable: false };
    console.error('[completion] could not stat events for', id, err);
    return { at: null, skipped: 0, unreadable: true };
  }
  const hit = cache.get(id);
  // A hit can only exist for a determined read, so reporting 0/false here is accurate rather than
  // assumed — the two facts are coupled, and a test pins the count across a cache-warm second load.
  if (hit && hit.mtimeMs === mtimeMs) return { at: hit.completedAt, skipped: 0, unreadable: false };

  const { determined, at, skipped, unreadable } = await readDoneAt(id);
  // Caching an undetermined answer would pin it forever: this file's mtime never changes again once
  // written, so the memo would outlive the process's only chance to notice.
  if (determined) cache.set(id, { mtimeMs, completedAt: at });
  return { at, skipped, unreadable };
}

function isCompleted(status: Ticket['status']): boolean {
  return status === 'done' || status === 'archived';
}

export async function withCompletedAt(ticket: BoardTicket): Promise<BoardTicket> {
  return (await withCompletedAtCounted(ticket)).ticket;
}

async function withCompletedAtCounted(
  ticket: BoardTicket,
): Promise<{ ticket: BoardTicket; skipped: number; unreadable: boolean }> {
  // Never read, so never counted — the counts describe what was inspected, not the whole board.
  if (!isCompleted(ticket.status)) return { ticket, skipped: 0, unreadable: false };
  const { at, skipped, unreadable } = await completedAtFor(ticket.id);
  return { ticket: { ...ticket, completedAt: at }, skipped, unreadable };
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

// Only done/archived tickets are joined — 691 of 882 on the live board, not all of them. So
// `eventsSkipped` covers the logs actually READ, and must not be read as a board-wide audit.
export async function withCompletedAtAll(
  tickets: BoardTicket[],
): Promise<{ tickets: BoardTicket[]; eventsSkipped: number; eventsUnreadable: number }> {
  const results = await mapLimited(tickets, CONCURRENCY, (t) => withCompletedAtCounted(t));
  return {
    tickets: results.map((r) => r.ticket),
    eventsSkipped: results.reduce((n, r) => n + r.skipped, 0),
    eventsUnreadable: results.filter((r) => r.unreadable).length,
  };
}

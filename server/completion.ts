import fs from 'node:fs/promises';
import path from 'node:path';
import { eventsDir } from 'ticket-workflow';
import type { Ticket, BoardTicket, TicketEvent } from '../shared/constants.js';
import { readEvents } from './events.js';

// `completedAt` is DERIVED from the ticket's `done` event, never stored in frontmatter
// (tkt-17dbc816e247). The service emits that event from a single choke point covering MCP and HTTP,
// so a web-UI drag to Done is recorded too. Tickets finished before telemetry existed have no event
// and get null — which must render as "not recorded", never fall back to `updated` (it restamps on
// any edit, so a June completion touched today would read as completed today).

// Keyed by the event file's mtime: a completion timestamp is immutable once written, and the
// uncached join costs +44% on every board load and SSE refetch.
const cache = new Map<string, { mtimeMs: number; completedAt: string | null }>();

export function clearCompletionCache(): void {
  cache.clear();
}

// The log is append-only, so a reopened-then-reclosed ticket carries several `done` events.
export function latestDoneAt(events: TicketEvent[]): string | null {
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

async function completedAtFor(id: string): Promise<string | null> {
  const file = path.join(eventsDir(), `${id}.jsonl`);
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    return null; // no telemetry for this ticket
  }
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === mtimeMs) return hit.completedAt;
  const completedAt = latestDoneAt(await readEvents(id));
  cache.set(id, { mtimeMs, completedAt });
  return completedAt;
}

function isCompleted(status: Ticket['status']): boolean {
  return status === 'done' || status === 'archived';
}

export async function withCompletedAt(ticket: BoardTicket): Promise<BoardTicket> {
  return isCompleted(ticket.status) ? { ...ticket, completedAt: await completedAtFor(ticket.id) } : ticket;
}

// Only done/archived tickets are joined — 691 of 874 on the live board, not all of them.
export async function withCompletedAtAll(tickets: BoardTicket[]): Promise<BoardTicket[]> {
  return Promise.all(tickets.map((t) => withCompletedAt(t)));
}

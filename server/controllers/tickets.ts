import type { Request, Response } from 'express';
import {
  listBoard,
  filterBySearch,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
} from '../tickets.js';
import { parseSearchTerm } from '../schemas/query.js';
import { ticketId } from '../schemas/params.js';
import { withCompletedAt, withCompletedAtAll } from '../completion.js';

// Thin orchestration: read request → service → response. :id narrowing in ticketId(); the service owns id-format validation.

// Envelope, not a bare array: a ticket file that won't parse is skipped so one bad
// file can't 500 the board, and `unreadable` is how the client learns the board is
// bigger than the array it just got (tkt-6cd916608a2f). One board read serves both
// branches — re-reading for search would discard that report.
export async function list(req: Request, res: Response): Promise<void> {
  const q = parseSearchTerm(req.query.q);
  const { tickets, unreadable } = await listBoard();
  // Enrich after the search branch — only what is actually returned pays for the events join.
  const shown = q ? filterBySearch(tickets, q) : tickets;
  // `eventsSkipped` is the telemetry-side twin of `unreadable`: lines lost from the logs the
  // completion join just read, reported for the same reason (tkt-3d6039df4076). Unlike `unreadable`
  // it is NOT board-wide — only done/archived tickets are joined — so it is scoped to what was read.
  const { tickets: enriched, eventsSkipped, eventsUnreadable } = await withCompletedAtAll(shown);
  res.json({ tickets: enriched, unreadable, eventsSkipped, eventsUnreadable });
}

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await withCompletedAt(await getTicket(ticketId(req))));
}

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await createTicket(req.body));
}

export async function patch(req: Request, res: Response): Promise<void> {
  res.json(await updateTicket(ticketId(req), req.body));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await deleteTicket(ticketId(req));
  res.status(204).end();
}

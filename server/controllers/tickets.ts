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

// Thin orchestration: read request → service → response. :id narrowing in ticketId(); the service owns id-format validation.

// Envelope, not a bare array: a ticket file that won't parse is skipped so one bad
// file can't 500 the board, and `unreadable` is how the client learns the board is
// bigger than the array it just got (tkt-6cd916608a2f). One board read serves both
// branches — re-reading for search would discard that report.
export async function list(req: Request, res: Response): Promise<void> {
  const q = parseSearchTerm(req.query.q);
  const { tickets, unreadable } = await listBoard();
  res.json({ tickets: q ? filterBySearch(tickets, q) : tickets, unreadable });
}

export async function get(req: Request, res: Response): Promise<void> {
  res.json(await getTicket(ticketId(req)));
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

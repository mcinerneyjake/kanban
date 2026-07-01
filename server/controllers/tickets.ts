import type { Request, Response } from 'express';
import {
  listTickets,
  searchTickets,
  getTicket,
  createTicket,
  updateTicket,
  deleteTicket,
} from '../tickets.js';
import { parseSearchTerm } from '../schemas/query.js';
import { ticketId } from '../schemas/params.js';

// Thin orchestration only: read off the request, call the service, shape the
// response. The `:id` narrowing lives in ticketId(); the service owns id
// *format* validation (ID_RE), so MCP callers hit the same guard.

export async function list(req: Request, res: Response): Promise<void> {
  const q = parseSearchTerm(req.query.q);
  res.json(q ? await searchTickets(q) : await listTickets());
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

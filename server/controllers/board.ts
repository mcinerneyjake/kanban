import type { Request, Response } from 'express';
import { listProjects, summarizeBoard, archiveStaleTickets } from '../tickets.js';
import { parseProjectScope } from '../schemas/query.js';

export async function projects(_req: Request, res: Response): Promise<void> {
  res.json(await listProjects());
}

// Dashboard aggregation. ?project= scopes counts; omitted = all. Archived excluded by the service.
export async function dashboard(req: Request, res: Response): Promise<void> {
  res.json(await summarizeBoard(parseProjectScope(req.query.project)));
}

export async function archive(_req: Request, res: Response): Promise<void> {
  res.json({ archived: await archiveStaleTickets() });
}

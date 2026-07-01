import type { Request } from 'express';
import { HttpError } from '../tickets.js';

// @types/express v5 types a route param as `string | string[]` (arrays arise
// only from wildcard/repeated segments, never a plain `:id`). Narrow it to a
// string in ONE place so controllers stay free of the repeated guard. The value
// itself is still validated downstream by the service (ID_RE in ticketPath /
// eventsPath), which is the single home for id *format* checks.
export function ticketId(req: Pick<Request, 'params'>): string {
  const id = req.params.id;
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid :id parameter');
  return id;
}

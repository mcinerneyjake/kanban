import { HttpError } from '../tickets.js';

// :id is a string but Express can surface an array at runtime, and @types/express
// disagree across majors (v4 string, v5 string|string[]). Type to the runtime
// reality and narrow in ONE place. Format is validated downstream by the service (ID_RE).
export function ticketId(req: { params: Record<string, string | string[] | undefined> }): string {
  const id = req.params.id;
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid :id parameter');
  return id;
}

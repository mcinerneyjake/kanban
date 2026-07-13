import { HttpError } from '../tickets.js';

// A route param is a plain string for `:id`, but Express can surface an array at
// runtime for wildcard/repeated segments — and the express *types* disagree on
// this across majors (v4 says always-string, v5 says `string | string[]`). Type
// the guard's input to the runtime reality directly so it stays valid whichever
// @types/express major is installed, and narrow to a string in ONE place so
// controllers stay free of the repeated guard. The id *format* is still
// validated downstream by the service (ID_RE in ticketPath / eventsPath), which
// is the single home for id-format checks.
export function ticketId(req: { params: Record<string, string | string[] | undefined> }): string {
  const id = req.params.id;
  if (typeof id !== 'string') throw new HttpError(400, 'Invalid :id parameter');
  return id;
}

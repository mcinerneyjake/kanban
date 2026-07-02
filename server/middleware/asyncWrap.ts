import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { z, ZodError, type ZodType } from 'zod';
import { HttpError } from '../tickets.js';

// The one home for error -> HTTP status mapping. Every route funnels through
// wrap(), so a thrown ZodError / HttpError / anything-else lands here and
// nowhere else. Handlers therefore never touch status codes for error paths.
function sendError(res: Response, err: unknown): void {
  // Edge validation failure (Zod) is always a 400. Surface the first issue's
  // message so the response keeps the { error } shape the rest of the API uses.
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message ?? 'Validation failed';
    res.status(400).json({ error: message });
    return;
  }
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  // HttpError messages are authored and safe to surface. Any other error reaching
  // here is an unexpected internal fault whose raw message may leak internals — a
  // rethrown fs error, for instance, embeds the ticket file's absolute path — so
  // return a generic message to the client and keep the detail in the server log.
  const message = err instanceof HttpError ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}

// Terminal 4-arg error handler for failures thrown BEFORE any wrap()ed handler
// runs — chiefly express.json()'s errors on a malformed or over-limit body, which
// would otherwise hit Express's default HTML error page and break the { error }
// JSON contract every endpoint honours. body-parser tags these with an `entity.*`
// `type` (and a numeric `status`); everything else falls through to sendError.
// Mounted after the routers (see app.ts).
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) { next(err); return; }
  if (err instanceof Error && 'type' in err && typeof err.type === 'string' && err.type.startsWith('entity.')) {
    const status = 'status' in err && typeof err.status === 'number' ? err.status : 400;
    const message = err.type === 'entity.parse.failed' ? 'Malformed JSON in request body' : err.message;
    res.status(status).json({ error: message });
    return;
  }
  sendError(res, err);
};

// A handler that has already been handed whatever it needs off the request.
// Controllers write their response via `res` and return nothing; the funnel
// only observes thrown errors, so the return is void.
export type Handler = (req: Request, res: Response) => void | Promise<void>
export type InputHandler<T> = (req: Request, res: Response, input: T) => void | Promise<void>

// Centralised async error funnel. fn runs INSIDE the promise chain (via
// `.then`, not `Promise.resolve(fn())`) so a *synchronous* throw — e.g. a Zod
// schema.parse() failing — is captured as a rejection, not leaked past Express.
export const wrap = (fn: Handler): RequestHandler =>
  (req: Request, res: Response, _next: NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch((err: unknown) => sendError(res, err));
  };

// Parse req.body with a Zod schema, then hand the validated, typed value to the
// handler as its third argument. The handler never sees an invalid body: a
// ZodError bubbles to the funnel (-> 400) before the handler runs. The input
// type is inferred from the schema, so the schema is the single source of truth.
export const validated = <S extends ZodType>(schema: S, handler: InputHandler<z.infer<S>>): RequestHandler =>
  wrap((req, res) => handler(req, res, schema.parse(req.body)));

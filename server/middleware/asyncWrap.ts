import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { z, ZodError, type ZodType } from 'zod';
import { HttpError } from '../tickets.js';

// The one home for error → HTTP status mapping. Every route funnels through
// wrap(), so handlers never touch error-path status codes.
function sendError(res: Response, err: unknown): void {
  // Zod failure → 400. Surface the first issue's message, keeping the { error } shape.
  if (err instanceof ZodError) {
    const message = err.issues[0]?.message ?? 'Validation failed';
    res.status(400).json({ error: message });
    return;
  }
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  // HttpError messages are authored + safe. Any other error may leak internals (a
  // raw fs error embeds the file's absolute path), so return a generic message and log the detail.
  const message = err instanceof HttpError ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}

// Terminal 4-arg handler for errors thrown BEFORE a wrap()ed handler (chiefly
// express.json on a malformed/over-limit body) — keeps the { error } contract
// instead of Express's HTML page. body-parser tags these entity.*; else sendError.
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

// Controllers write via res and return void; the funnel only observes thrown errors.
export type Handler = (req: Request, res: Response) => void | Promise<void>
export type InputHandler<T> = (req: Request, res: Response, input: T) => void | Promise<void>

// Async error funnel. fn runs INSIDE the promise chain (.then, not
// Promise.resolve(fn())) so a synchronous throw (e.g. schema.parse()) is captured
// as a rejection, not leaked past Express.
export const wrap = (fn: Handler): RequestHandler =>
  (req: Request, res: Response, _next: NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch((err: unknown) => sendError(res, err));
  };

// Parse req.body with a Zod schema, then pass the typed value as the handler's
// third arg. An invalid body bubbles to the funnel (→ 400) before the handler
// runs; the type is inferred from the schema.
export const validated = <S extends ZodType>(schema: S, handler: InputHandler<z.infer<S>>): RequestHandler =>
  wrap((req, res) => handler(req, res, schema.parse(req.body)));

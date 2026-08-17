import type { RequestHandler } from 'express';
import { isAllowedHost } from '../terminalAuth.js';

// Refuses any request addressed to a host this API is not reachable at, which is what stops a
// DNS-rebound page (tkt-fc40f49495c1). It answers no question about *who* is calling — there is no
// auth here — only about the name they dialed, which is the one thing rebinding cannot fake.
// Wired first in app.ts, before the body parser: a request that will be refused should not be
// buffered and parsed first.
export const hostGuard: RequestHandler = (req, res, next) => {
  if (isAllowedHost(req.headers.host)) {
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden host' });
};

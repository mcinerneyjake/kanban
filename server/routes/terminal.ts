import { Router } from 'express';
import { terminalToken } from '../terminalToken.js';
import { isAllowedTerminalHost } from '../terminalAuth.js';

// Dev-only: hands the per-boot terminal token to the same-origin page. Mounted at /api only when
// KANBAN_TERMINAL=1 (see app.ts).
export const terminalRouter = Router();

// Same-origin policy alone does NOT protect this response: under DNS rebinding a page served from
// evil.com is rebound to 127.0.0.1 and becomes same-origin, so it could read the token. The Host
// header is what still distinguishes them (tkt-b6eb52013662).
terminalRouter.get('/terminal/token', (req, res) => {
  if (!isAllowedTerminalHost(req.headers.host)) {
    res.status(403).json({ error: 'forbidden host' });
    return;
  }
  res.json({ token: terminalToken() });
});

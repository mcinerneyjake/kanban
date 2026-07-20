import { Router } from 'express';
import { terminalToken } from '../terminalToken.js';

// Dev-only: hands the per-boot terminal token to the same-origin page (a cross-site page
// can't read the response). Mounted at /api only when KANBAN_TERMINAL=1 (see app.ts).
export const terminalRouter = Router();

terminalRouter.get('/terminal/token', (_req, res) => {
  res.json({ token: terminalToken() });
});

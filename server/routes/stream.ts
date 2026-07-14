import { Router } from 'express';
import { stream } from '../stream.js';

// SSE live-refresh channel. Mounted at /api/stream. Wired directly (not via wrap()) — the handler holds the connection open and manages its own lifecycle.
export const streamRouter = Router();

streamRouter.get('/', stream);

import { Router } from 'express';
import { stream } from '../stream.js';

// SSE live-refresh channel. Mounted at /api/stream. The handler holds the
// connection open and manages its own lifecycle, so it is wired directly rather
// than through wrap() (whose error funnel assumes a normal request completion).
export const streamRouter = Router();

streamRouter.get('/', stream);

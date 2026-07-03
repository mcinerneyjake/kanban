import { Router } from 'express';
import { wrap } from '../middleware/asyncWrap.js';
import * as ctrl from '../controllers/economics.js';

// Agent economics rollup over the run log. Mounted at /api. Distinct resource
// from the board (run-scoped data), so it gets its own router.
export const economicsRouter = Router();

economicsRouter.get('/economics', wrap(ctrl.economics));

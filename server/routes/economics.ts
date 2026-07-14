import { Router } from 'express';
import { wrap } from '../middleware/asyncWrap.js';
import * as ctrl from '../controllers/economics.js';

// Agent economics rollup over the run log. Mounted at /api; own router (run-scoped, distinct from the board).
export const economicsRouter = Router();

economicsRouter.get('/economics', wrap(ctrl.economics));

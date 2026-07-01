import { Router } from 'express';
import { wrap } from '../middleware/asyncWrap.js';
import * as ctrl from '../controllers/board.js';

// Board-wide reads + maintenance. Mounted at /api.
export const boardRouter = Router();

boardRouter.get('/projects', wrap(ctrl.projects));
boardRouter.get('/dashboard', wrap(ctrl.dashboard));
boardRouter.post('/archive', wrap(ctrl.archive));

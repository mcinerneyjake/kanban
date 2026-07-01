import { Router } from 'express';
import { wrap } from '../middleware/asyncWrap.js';
import * as ctrl from '../controllers/tickets.js';

// Pure wiring: path + method -> controller. Mounted at /api/tickets.
export const ticketsRouter = Router();

ticketsRouter.get('/', wrap(ctrl.list));
ticketsRouter.get('/:id', wrap(ctrl.get));
ticketsRouter.post('/', wrap(ctrl.create));
ticketsRouter.patch('/:id', wrap(ctrl.patch));
ticketsRouter.delete('/:id', wrap(ctrl.remove));

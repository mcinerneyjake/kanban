import { Router } from 'express';
import { wrap, validated } from '../middleware/asyncWrap.js';
import { intakeSearchSchema, intakeProposeSchema } from '../schemas/intake.js';
import * as ctrl from '../controllers/intake.js';

// Mounted at /api/intake.
export const intakeRouter = Router();

intakeRouter.post('/search', validated(intakeSearchSchema, ctrl.search));
intakeRouter.post('/propose', validated(intakeProposeSchema, ctrl.propose));
intakeRouter.get('/health', wrap(ctrl.health));

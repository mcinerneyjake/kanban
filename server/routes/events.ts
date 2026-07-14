import { Router } from 'express';
import { wrap, validated } from '../middleware/asyncWrap.js';
import { reviewSchema } from '../schemas/review.js';
import * as ctrl from '../controllers/events.js';

// Mounted at /api/tickets — shares the /:id prefix but is a distinct telemetry concern from the CRUD router.
export const eventsRouter = Router();

eventsRouter.get('/:id/events', wrap(ctrl.events));
eventsRouter.post('/:id/review', validated(reviewSchema, ctrl.review));

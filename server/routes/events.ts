import { Router } from 'express';
import { wrap, validated } from '../middleware/asyncWrap.js';
import { reviewSchema } from '../schemas/review.js';
import * as ctrl from '../controllers/events.js';

// Also mounted at /api/tickets — these share the /:id prefix but are a distinct
// (telemetry) concern from the ticket CRUD router.
export const eventsRouter = Router();

eventsRouter.get('/:id/events', wrap(ctrl.events));
eventsRouter.post('/:id/review', validated(reviewSchema, ctrl.review));

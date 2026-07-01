import type { Request, Response } from 'express';
import { getTicketEvents, appendEvent, REVIEW_CLEARED } from '../events.js';
import type { ReviewRequest } from '../schemas/review.js';
import { ticketId } from '../schemas/params.js';

// Read-only workflow-milestone timeline. A never-worked or unknown ticket
// returns an all-`pending` pipeline (200, not 404). Id format validation is the
// service's job (eventsPath ID_RE -> 400).
export async function events(req: Request, res: Response): Promise<void> {
  res.json(await getTicketEvents(ticketId(req)));
}

// Toggle the manual "Ready to commit?" review milestone. `{ reviewed: false }`
// un-reviews via a cleared marker; anything else (incl. an empty body) confirms.
export async function review(req: Request, res: Response, input: ReviewRequest): Promise<void> {
  const id = ticketId(req);
  const reviewed = input.reviewed !== false;
  await appendEvent({
    ticketId: id,
    step: 'review',
    state: 'reached',
    ...(reviewed ? {} : { detail: REVIEW_CLEARED }),
  });
  res.json(await getTicketEvents(id));
}

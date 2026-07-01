import { z } from 'zod';

// POST /api/tickets/:id/review body. Only an explicit `false` un-reviews;
// anything else — omitted, or a non-boolean like "false"/0 — means "reviewed".
// `.catch(undefined)` folds any non-boolean to undefined so the controller's
// `reviewed !== false` keeps the old `req.body?.reviewed !== false` semantics
// (a non-boolean must not become a 400).
export const reviewSchema = z.object({
  reviewed: z.boolean().optional().catch(undefined),
});
export type ReviewRequest = z.infer<typeof reviewSchema>

import { z } from 'zod';

// POST /api/tickets/:id/review. Only explicit false un-reviews; anything else means
// reviewed. .catch(undefined) folds a non-boolean to undefined so it can't become a 400.
export const reviewSchema = z.object({
  reviewed: z.boolean().optional().catch(undefined),
});
export type ReviewRequest = z.infer<typeof reviewSchema>

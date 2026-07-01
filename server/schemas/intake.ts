import { z } from 'zod';

// Request payloads for the two intake endpoints. These inputs are NOT validated
// by the service/agent layer (unlike create/update, which the ticket service
// owns), so the schema IS their validation. z.infer keeps the type and the
// validator single-sourced.

// POST /api/intake/search — semantic board search. Behaviour matches the old
// inline validation exactly: `query` is required (custom message on both the
// missing-type and empty cases), and any non-number `limit` silently falls back
// to 5 via `.catch(5)` (the old `typeof limit === 'number' ? limit : 5`) rather
// than rejecting — a refactor must not tighten the contract.
export const intakeSearchSchema = z.object({
  query: z.string({ error: 'query is required' }).trim().min(1, 'query is required'),
  limit: z.number().catch(5),
});
export type IntakeSearchRequest = z.infer<typeof intakeSearchSchema>

// POST /api/intake/propose — run the intake agent in PROPOSE mode.
export const intakeProposeSchema = z.object({
  report: z.string({ error: 'report is required' }).trim().min(1, 'report is required'),
});
export type IntakeProposeRequest = z.infer<typeof intakeProposeSchema>

import { z } from 'zod';

// Request payloads for the intake endpoints. NOT validated by the service/agent
// layer, so the schema IS their validation. z.infer single-sources type + validator.

// POST /api/intake/search. query required; a non-number limit silently falls back
// to 5 (.catch(5)) rather than rejecting — a refactor must not tighten the contract.
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

// POST /api/intake/apply. args = the user's final form fields (validated by the
// ticket service); runId links to the drafting propose call for metering.
export const intakeApplySchema = z.object({
  action: z.enum(['create_ticket', 'update_ticket']),
  runId: z.string().trim().min(1, 'runId is required'),
  args: z.record(z.string(), z.unknown()),
});
export type IntakeApplyRequest = z.infer<typeof intakeApplySchema>

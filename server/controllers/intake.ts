import type { Request, Response } from 'express';
import { getTicketIndex } from '../../agent/retrieval/indexCache.js';
import { RuntimeChatClient, resolveLlmConfig } from '../../agent/runtime/llm.js';
import { proposeIntake } from '../../agent/runtime/propose.js';
import { RUN_PREFIX_TEXT } from '../../agent/runtime/loop.js';
import { type RunRecord } from '../../agent/cost/runLog.js';
import { meterRun } from '../../agent/cost/meterRun.js';
import type { RunUsage } from '../../agent/cost/usage.js';
import type { RunOutcome } from '../../agent/cost/economics.js';
import { extractTicketFields, CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM } from '../validation.js';
import { createTicket, updateTicket, getTicket, HttpError } from '../tickets.js';
import { BoundedMap } from '../lib/boundedMap.js';
import type { Ticket, Provenance } from '../../shared/constants.js';
import type { IntakeSearchRequest, IntakeProposeRequest, IntakeApplyRequest } from '../schemas/intake.js';

// Translate a local-runtime failure → 503 in one place (the agent layer is
// HTTP-agnostic). A real bug inside the agent still surfaces its own message.
async function requireRuntime<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new HttpError(503, `Intake unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// pendingRuns/appliedRuns evict by count (FIFO) via BoundedMap. MAX_RUNS is a pure
// backstop above any realistic in-flight count — bounds a long-lived process
// against abandoned drafts (each holds a full report string).
const MAX_RUNS = 200;

// Drafted-but-not-applied run: stash propose()'s usage so apply() can meter WITHOUT
// trusting a client-sent figure. Server-local + ephemeral (a restart drops an
// in-flight draft's economics).
interface PendingRun { usage: RunUsage; model: string; report: string; at: number }
const pendingRuns = new BoundedMap<PendingRun>(MAX_RUNS);

// runId → applied ticket id: a replayed apply returns the SAME ticket instead of
// minting a duplicate. Bounded; ephemeral (a restart re-opens the small duplicate window).
const appliedRuns = new BoundedMap<string>(MAX_RUNS);

// runIds mid-write. appliedRuns is set only AFTER the awaited write, so it can't
// guard the concurrent race. Checked-and-set SYNCHRONOUSLY at apply() entry (no
// await between) so a second apply 409s instead of writing a duplicate.
const inFlightRuns = new Set<string>();

function rememberRun(runId: string, usage: RunUsage, report: string): PendingRun {
  // Captures CHAT usage only — the generation dominates cost; the embed is a
  // cached query-embed, not cleanly per-run attributable, and minor.
  const pending: PendingRun = { usage, model: resolveLlmConfig().model, report, at: Date.now() };
  pendingRuns.set(runId, pending);
  return pending;
}

const NO_TICKETS: RunRecord['ticketIds'] = { created: [], updated: [] };

// Meter a run through the shared cost path. Called at propose (spend now, before
// any ticket) and apply (re-record same runId enriched). The rollup dedupes runIds
// last-wins, so the two records collapse to the apply record — counted once.
async function meterIntakeRun(runId: string, pending: PendingRun, outcome: RunOutcome, ticketIds: RunRecord['ticketIds'], reviewMs: number): Promise<void> {
  await meterRun({
    runId, model: pending.model, usage: pending.usage, outcome, reviewMs,
    ticketIds, prefixText: RUN_PREFIX_TEXT, dynamicText: pending.report,
  });
}

// Outcome for a propose (spent tokens, no applied ticket yet): zero accepted;
// apply re-meters with the real outcome if applied later.
function proposeOutcome(proposed: boolean): RunOutcome {
  return { created: 0, updated: 0, declined: 0, noProposal: !proposed, errored: false };
}

export async function search(_req: Request, res: Response, input: IntakeSearchRequest): Promise<void> {
  const results = await requireRuntime(async () => {
    const index = await getTicketIndex();
    return index.search(input.query, input.limit);
  });
  // Project to exactly { id, title, status, score } explicitly (not a ...meta
  // spread) so generic fields like source/url can't leak onto the wire or clobber a core field.
  res.json({
    results: results.map((r) => ({ id: r.id, title: r.title, status: r.meta?.status, score: r.score })),
  });
}

export async function propose(_req: Request, res: Response, input: IntakeProposeRequest): Promise<void> {
  const result = await requireRuntime(async () => {
    const index = await getTicketIndex();
    const chat = RuntimeChatClient.fromEnv();
    const proposed = await proposeIntake(input.report, { chat, index });
    // Meter the spend NOW so never-applied proposes still reach the run log; an
    // applied proposal re-records at apply and the rollup dedupes last-wins. Best-effort:
    // if `pending` is lost before apply (restart / MAX_RUNS eviction), this record remains
    // as honest spend with 0 accepted. Durable reconciliation is a follow-up (tkt-2073125cac5c).
    const pending = rememberRun(proposed.runId, chat.getUsage(), input.report);
    await meterIntakeRun(proposed.runId, pending, proposeOutcome(proposed.proposal !== null), NO_TICKETS, 0);
    return proposed;
  });
  res.json(result);
}

// POST /api/intake/apply — persist a reviewed proposal via the AGENT provenance
// path: stamp {source:'assisted', runId} (the trusted boundary human routes never
// cross). An update keeps the existing source (authorship-once). Validated via the
// same ticket service as human routes.
export async function apply(_req: Request, res: Response, input: IntakeApplyRequest): Promise<void> {
  // Idempotent on runId: a replayed apply returns the already-applied ticket instead of minting a duplicate.
  const applied = appliedRuns.get(input.runId);
  if (applied !== undefined) {
    // Already applied; return its ticket. If since deleted, the retry is still benign — acknowledge, don't 404.
    try {
      res.json(await getTicket(applied));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) res.json({ id: applied, deleted: true });
      else throw err;
    }
    return;
  }

  // Guard the CONCURRENT duplicate: checked-and-set with NO await between, so a racing same-runId apply sees the reservation and 409s.
  if (inFlightRuns.has(input.runId)) throw new HttpError(409, 'apply already in progress for this run');
  inFlightRuns.add(input.runId);
  try {
    // Stamp provenance only when a captured run exists — a missing pending run falls
    // back to a plain human write, so the no-run case can't dangle the badge's economics
    // link. An assisted UPDATE of a human ticket keeps source:null (authorship-once).
    // Metering below is best-effort.
    const pending = pendingRuns.get(input.runId);
    const provenance: Provenance | undefined = pending ? { source: 'assisted', runId: input.runId } : undefined;
    let ticket: Ticket;
    let created: boolean;
    if (input.action === 'update_ticket') {
      const id = typeof input.args.id === 'string' ? input.args.id : '';
      if (!id) throw new HttpError(400, 'update_ticket apply requires an id');
      ticket = await updateTicket(id, extractTicketFields(input.args, UPDATE_STATUS_ENUM), provenance);
      created = false;
    } else {
      ticket = await createTicket(extractTicketFields(input.args, CREATE_STATUS_ENUM), provenance);
      created = true;
    }
    appliedRuns.set(input.runId, ticket.id);
    if (pending) {
      pendingRuns.delete(input.runId);
      // Re-meter enriched with the ticket + review latency; shares the runId with the propose record, rollup keeps this (last) one.
      const outcome: RunOutcome = { created: created ? 1 : 0, updated: created ? 0 : 1, declined: 0, noProposal: false, errored: false };
      const ticketIds = { created: created ? [ticket.id] : [], updated: created ? [] : [ticket.id] };
      await meterIntakeRun(input.runId, pending, outcome, ticketIds, Math.max(0, Date.now() - pending.at));
    }
    res.status(created ? 201 : 200).json(ticket);
  } finally {
    inFlightRuns.delete(input.runId);
  }
}

// Liveness probe for the drafting model. Never 503s — reports availability so the UI can fall back to manual entry.
export async function health(_req: Request, res: Response): Promise<void> {
  res.json({ available: await RuntimeChatClient.fromEnv().available() });
}

import type { Request, Response } from 'express';
import { getTicketIndex } from '../../agent/retrieval/indexCache.js';
import { RuntimeChatClient, resolveLlmConfig } from '../../agent/runtime/llm.js';
import { proposeIntake } from '../../agent/runtime/propose.js';
import { RUN_PREFIX_TEXT } from '../../agent/runtime/loop.js';
import { type RunRecord } from '../../agent/cost/runLog.js';
import { meterRun } from '../../agent/cost/meterRun.js';
import type { RunUsage } from '../../agent/cost/usage.js';
import type { RunOutcome } from '../../agent/cost/economics.js';
import { extractTicketFields, CREATE_STATUS_ENUM, UPDATE_STATUS_ENUM } from '../../mcp/handlers.js';
import { createTicket, updateTicket, getTicket, HttpError } from '../tickets.js';
import { BoundedMap } from '../lib/boundedMap.js';
import type { Ticket, Provenance } from '../../shared/constants.js';
import type { IntakeSearchRequest, IntakeProposeRequest, IntakeApplyRequest } from '../schemas/intake.js';

// Both intake endpoints depend on the local LLM runtime (embedder + chat model).
// When it is down the agent layer throws a plain Error — it is deliberately
// HTTP-agnostic (local-first). Translating "runtime unavailable" -> 503 is an
// HTTP concern, so it lives HERE, in one place, rather than being copy-pasted
// per endpoint. A real bug inside the agent still surfaces as its own message.
async function requireRuntime<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    throw new HttpError(503, `Intake unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// pendingRuns / appliedRuns evict by count only (FIFO) via BoundedMap — the rationale
// (why a count cap and not a wall-clock TTL) lives on that class. MAX_RUNS is a pure
// backstop set comfortably above any realistic single-user in-flight count, so it
// never fires in normal use; it only bounds a long-lived process against accumulating
// abandoned drafts (each PendingRun holds a full report string, so this is not huge).
const MAX_RUNS = 200;

// A drafted-but-not-yet-applied intake run: propose() spends the tokens and the
// agent mints a runId; we stash the usage here so apply() can meter the run
// WITHOUT trusting a client-sent usage figure. Server-local + ephemeral — a restart
// just means an in-flight draft's apply logs no economics (best-effort).
interface PendingRun { usage: RunUsage; model: string; report: string; at: number }
const pendingRuns = new BoundedMap<PendingRun>(MAX_RUNS);

// runId → the ticket id it applied, so a replayed apply (a retry after a lost
// response, or a second tab) returns the SAME ticket instead of minting a duplicate
// + re-metering the run. Bounded like pendingRuns; ephemeral (a restart resets it,
// which just re-opens the small duplicate window a client retry could hit).
const appliedRuns = new BoundedMap<string>(MAX_RUNS);

// runIds whose apply is mid-write. appliedRuns is only populated AFTER the awaited
// write, so it can't guard the CONCURRENT case (two applies for one runId racing
// before either records). This set is checked-and-set SYNCHRONOUSLY at apply() entry
// — no await between the check and the add — so the event loop can't interleave a
// second apply past it: the loser 409s instead of writing a duplicate.
const inFlightRuns = new Set<string>();

function rememberRun(runId: string, usage: RunUsage, report: string): PendingRun {
  // Captures the CHAT usage — the LLM generation, which dominates the (energy) cost.
  // The board index is process-cached (indexCache), so a propose's embedder cost is
  // only a query embed and isn't cleanly per-run attributable here (the CLI, which
  // rebuilds+embeds per run, uses a different accounting model). Chat-only is the
  // meaningful, directly-attributable figure; the embed delta is minor + amortized.
  const pending: PendingRun = { usage, model: resolveLlmConfig().model, report, at: Date.now() };
  pendingRuns.set(runId, pending);
  return pending;
}

const NO_TICKETS: RunRecord['ticketIds'] = { created: [], updated: [] };

// Meter an intake run through the shared cost path (agent/cost/meterRun). Called on the
// propose path (records the spend the moment it happens, before any ticket exists) and
// the apply path (re-records the same runId enriched with the created/updated ticket +
// real review latency). The rollup dedupes duplicate runIds last-wins (economicsSummary),
// so an applied run's two records collapse to the apply record — counted once, attributed.
async function meterIntakeRun(runId: string, pending: PendingRun, outcome: RunOutcome, ticketIds: RunRecord['ticketIds'], reviewMs: number): Promise<void> {
  await meterRun({
    runId, model: pending.model, usage: pending.usage, outcome, reviewMs,
    ticketIds, prefixText: RUN_PREFIX_TEXT, dynamicText: pending.report,
  });
}

// Outcome for a run that spent tokens but hasn't produced an applied ticket: a propose
// (which either captured a proposal — pending review — or the agent proposed nothing).
// Zero accepted; if the proposal is later applied, apply re-meters with the real outcome.
function proposeOutcome(proposed: boolean): RunOutcome {
  return { created: 0, updated: 0, declined: 0, noProposal: !proposed, errored: false };
}

export async function search(_req: Request, res: Response, input: IntakeSearchRequest): Promise<void> {
  const results = await requireRuntime(async () => {
    const index = await getTicketIndex();
    return index.search(input.query, input.limit);
  });
  // The retrieval layer is source-agnostic (ScoredDocument), but the intake UI's
  // IntakeMatch contract is flat { id, title, status, score } — project to
  // exactly those fields (explicitly, not a `...meta` spread) so generic fields
  // like `source`/`url` don't leak onto the wire and a stray meta key can't
  // clobber a core field.
  res.json({
    results: results.map((r) => ({ id: r.id, title: r.title, status: r.meta?.status, score: r.score })),
  });
}

export async function propose(_req: Request, res: Response, input: IntakeProposeRequest): Promise<void> {
  const result = await requireRuntime(async () => {
    const index = await getTicketIndex();
    const chat = RuntimeChatClient.fromEnv();
    const proposed = await proposeIntake(input.report, { chat, index });
    // The propose spent the tokens. Stash the usage so a later apply can re-meter it
    // (enriched with the ticket), AND meter the spend NOW so re-drafted / no-proposal /
    // abandoned proposes — which are never applied — still reach the run log. An applied
    // proposal produces a second record at apply; the rollup dedupes last-wins.
    //
    // Reconciliation is best-effort: apply's enriched record collapses this one when the
    // in-memory `pending` survives. If `pending` is lost before apply (a server restart,
    // or MAX_RUNS eviction), this record REMAINS as honest spend with 0 accepted — the
    // ticket then applies via the plain path and loses its economics link, the same
    // restart boundary provenance already has. Durable reconciliation from the log is a
    // follow-up (tkt-2073125cac5c — recover usage + provenance from this record on a pending miss).
    const pending = rememberRun(proposed.runId, chat.getUsage(), input.report);
    await meterIntakeRun(proposed.runId, pending, proposeOutcome(proposed.proposal !== null), NO_TICKETS, 0);
    return proposed;
  });
  res.json(result);
}

// POST /api/intake/apply — persist a reviewed intake proposal through the AGENT
// provenance path: stamp {source:'assisted', runId} (the trusted boundary the
// human MCP/HTTP routes never cross) so a CREATED ticket earns the 🤖 Assisted
// badge + run deep-link, and meter the run's economics. An update keeps the
// existing ticket's source (authorship-once), so it surfaces the badge only when
// that source was already set. The write validates via the same ticket service
// the human routes use (extractTicketFields).
export async function apply(_req: Request, res: Response, input: IntakeApplyRequest): Promise<void> {
  // Idempotent on runId: a replayed apply (a retry after a lost response, or a second
  // tab) returns the already-applied ticket instead of minting a duplicate + re-metering.
  const applied = appliedRuns.get(input.runId);
  if (applied !== undefined) {
    // The run already applied; return its ticket. If that ticket was since deleted the
    // retry is still benign (the effect happened), so acknowledge instead of 404ing.
    try {
      res.json(await getTicket(applied));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) res.json({ id: applied, deleted: true });
      else throw err;
    }
    return;
  }

  // Guard the CONCURRENT duplicate (appliedRuns is set only after the awaited write, so
  // it can't). Checked-and-set with NO await in between, so a second same-runId apply
  // racing this one sees the reservation and 409s rather than writing a second ticket.
  if (inFlightRuns.has(input.runId)) throw new HttpError(409, 'apply already in progress for this run');
  inFlightRuns.add(input.runId);
  try {
    // Stamp provenance only when a captured run exists to attribute it to — a missing
    // pending run (a fresh process, or dropped by the MAX_RUNS backstop) falls back to a
    // plain human write, so the COMMON no-run case can't dangle the badge's "View
    // economics" link. NOTE: an assisted UPDATE of a human-authored ticket keeps
    // source:null (authorship-once), so it earns the run link only if the ticket already
    // had a source — a create, or an update of an agent/assisted ticket. (Metering below
    // is best-effort; a rare append IO failure after the write could leave the link
    // unresolved — acceptable for a local dev tool.)
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
      // Re-meter the run enriched with the created/updated ticket + real review latency.
      // This shares the runId with the propose-time record; the rollup keeps this (last) one.
      const outcome: RunOutcome = { created: created ? 1 : 0, updated: created ? 0 : 1, declined: 0, noProposal: false, errored: false };
      const ticketIds = { created: created ? [ticket.id] : [], updated: created ? [] : [ticket.id] };
      await meterIntakeRun(input.runId, pending, outcome, ticketIds, Math.max(0, Date.now() - pending.at));
    }
    res.status(created ? 201 : 200).json(ticket);
  } finally {
    inFlightRuns.delete(input.runId);
  }
}

// Liveness probe for the drafting model. Never 503s — it reports availability so
// the create UI can fall back to manual entry.
export async function health(_req: Request, res: Response): Promise<void> {
  res.json({ available: await RuntimeChatClient.fromEnv().available() });
}

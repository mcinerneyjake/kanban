import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STEPS,
  isStepId,
  isStepState,
  type StepId,
  type TicketEvent,
  type PipelineStep,
  type TicketEventsResponse,
} from '../shared/constants.js';
import { HttpError } from './tickets.js';

// ---------------------------------------------------------------------------
// Workflow-step telemetry. Append-only JSONL, one file per worked ticket, kept
// OUT of the (already git-ignored) tickets/ dir in its own events/ dir. Writers
// persist directly to disk (this module's appendEvent for status milestones +
// the PostToolUse hook for shell milestones); the server only READS — so a
// ticket worked with no web server running never loses events. See
// tkt-512f9b15ddb8.
//
// NOTE: this module imports HttpError from tickets.ts, which imports appendEvent
// back from here — a cycle. It's safe because both sides use the imported
// binding only inside function bodies (never at module-eval time), so ESM has
// resolved everything before either runs.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests redirect telemetry I/O to a temp dir via this env var (mirrors
// TICKETS_DIR_OVERRIDE) so the real events/ dir is never touched.
function getEventsDir() {
  return process.env.EVENTS_DIR_OVERRIDE ?? path.join(__dirname, '..', 'events');
}

// Same path-traversal guard as tickets.ts: a crafted id can never escape the
// events dir.
const ID_RE = /^[a-zA-Z0-9-]+$/;

function eventsPath(ticketId: string): string {
  if (!ID_RE.test(ticketId)) throw new HttpError(400, `Invalid ticket id: ${ticketId}`);
  return path.join(getEventsDir(), `${ticketId}.jsonl`);
}

// Append one milestone event. `step`/`state` are typed loosely so untyped
// callers can't smuggle an invalid value past validation; the guards narrow
// them to the enum types before the record is built.
export async function appendEvent(event: {
  ticketId: string
  step: string
  state: string
  at?: string
  detail?: string
}): Promise<void> {
  const file = eventsPath(event.ticketId);
  if (!isStepId(event.step)) throw new HttpError(400, `Invalid step: ${event.step}`);
  if (!isStepState(event.state)) throw new HttpError(400, `Invalid state: ${event.state}`);
  const record: TicketEvent = {
    ticketId: event.ticketId,
    step: event.step,
    state: event.state,
    at: event.at ?? new Date().toISOString(),
    ...(event.detail ? { detail: event.detail } : {}),
  };
  await fs.mkdir(getEventsDir(), { recursive: true });
  // flag 'a' = O_APPEND: line-atomic across the two writer processes.
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

// A single JSONL line whose keys are present but not yet type-checked. Built via
// `in`-narrowing so no cast is needed (per the repo's no-`as` convention).
type RawEvent = { ticketId: unknown; step: unknown; state: unknown; at: unknown; detail?: unknown }

function asRawEvent(v: unknown): RawEvent | null {
  if (typeof v !== 'object' || v === null) return null;
  if (!('ticketId' in v) || !('step' in v) || !('state' in v) || !('at' in v)) return null;
  return v;
}

// Parse + validate one JSONL line into a TicketEvent, or null if malformed
// (telemetry robustness: a corrupt line is skipped, never fatal).
function parseEventLine(line: string): TicketEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const raw = asRawEvent(data);
  if (!raw) return null;
  if (typeof raw.ticketId !== 'string') return null;
  if (typeof raw.step !== 'string' || !isStepId(raw.step)) return null;
  if (typeof raw.state !== 'string' || !isStepState(raw.state)) return null;
  if (typeof raw.at !== 'string') return null;
  return {
    ticketId: raw.ticketId,
    step: raw.step,
    state: raw.state,
    at: raw.at,
    ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
  };
}

// All events for a ticket in chronological (file) order. A ticket that has never
// been worked has no file → empty list (not an error).
export async function readEvents(ticketId: string): Promise<TicketEvent[]> {
  const file = eventsPath(ticketId);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const events: TicketEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseEventLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

// Marker used to un-set a toggleable milestone (only `review`). Appended rather
// than deleting the prior line, so the log stays append-only and race-free with
// the hook's concurrent writes; the reducer maps a cleared-latest back to
// pending. The timeline keeps the honest "reviewed … then cleared …" history.
export const REVIEW_CLEARED = 'cleared';

// Reduce the raw event stream to the tracking-view pipeline: every canonical
// step in order, showing the LATEST event's state (last write wins — so a
// failed-then-passed retry lands on `passed`), or `pending` if none arrived. A
// latest event tagged `cleared` (an un-review) reverts that step to pending.
export function reducePipeline(events: TicketEvent[]): PipelineStep[] {
  const latest = new Map<StepId, TicketEvent>();
  for (const e of events) latest.set(e.step, e);
  return STEPS.map((s) => {
    const e = latest.get(s.id);
    const active = e && e.detail !== REVIEW_CLEARED ? e : undefined;
    return {
      step: s.id,
      label: s.label,
      state: active ? active.state : 'pending',
      at: active ? active.at : null,
    };
  });
}

// Read-side aggregation for the tracking endpoint: raw events + the reduced
// pipeline. Validates the id (throws 400 on a bad shape).
export async function getTicketEvents(ticketId: string): Promise<TicketEventsResponse> {
  const events = await readEvents(ticketId);
  return { ticketId, pipeline: reducePipeline(events), events };
}

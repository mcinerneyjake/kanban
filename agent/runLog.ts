import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTicket } from '../server/tickets.js';
import { type RunUsage, isRunUsage } from './usage.js';
import { type RunOutcome, isRunOutcome } from './economics.js';
import { type RunSummary, isRunSummary } from './summary.js';

// ---------------------------------------------------------------------------
// Run log. Each agent run produces one RunRecord — its usage, computed cost
// lines, outcome, and the ids of the tickets it authored — appended to a local
// JSONL file. Mirrors server/events.ts (append-only, dir override, cast-free
// per-line parse), the established local-telemetry pattern. Read/write is behind
// this seam so the JSONL backend can move to SQLite later (tkt-f93c3c10c26c)
// without touching callers. Keyed by runId; a ticket's frontmatter carries the
// runId, giving the ticket → run → usage lookup (getRunForTicket).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests redirect the run log to a temp dir via this env var (mirrors
// TICKETS_DIR_OVERRIDE / EVENTS_DIR_OVERRIDE).
function runsDir(): string {
  return process.env.RUNS_DIR_OVERRIDE ?? path.join(__dirname, '..', 'runs');
}
function runsPath(): string {
  return path.join(runsDir(), 'runs.jsonl');
}

export interface RunRecord {
  runId: string;
  at: string;                       // ISO timestamp
  model: string;
  usage: RunUsage;
  outcome: RunOutcome;
  reviewMs: number;
  cost: RunSummary;
  ticketIds: { created: string[]; updated: string[] };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
function isTicketIds(v: unknown): v is RunRecord['ticketIds'] {
  return typeof v === 'object' && v !== null
    && 'created' in v && isStringArray(v.created)
    && 'updated' in v && isStringArray(v.updated);
}

// Cast-free validator for a persisted RunRecord line. Composes the per-type
// predicates so a truncated or hand-edited line is skipped, not trusted.
export function isRunRecord(v: unknown): v is RunRecord {
  return typeof v === 'object' && v !== null
    && 'runId' in v && typeof v.runId === 'string'
    && 'at' in v && typeof v.at === 'string'
    && 'model' in v && typeof v.model === 'string'
    && 'usage' in v && isRunUsage(v.usage)
    && 'outcome' in v && isRunOutcome(v.outcome)
    && 'reviewMs' in v && typeof v.reviewMs === 'number'
    && 'cost' in v && isRunSummary(v.cost)
    && 'ticketIds' in v && isTicketIds(v.ticketIds);
}

// Append one run record. flag 'a' = O_APPEND so concurrent writers stay
// line-atomic (same guarantee events.ts relies on).
export async function appendRun(record: RunRecord): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  await fs.appendFile(runsPath(), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

// All run records, oldest first. Missing file → [] (not an error); corrupt lines
// are skipped.
export async function readRuns(): Promise<RunRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(runsPath(), 'utf8');
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunRecord(parsed)) records.push(parsed);
    } catch { /* skip a corrupt line */ }
  }
  return records;
}

// The record for a runId, or null if none. Last write wins (a runId should be
// unique, but a re-run appending twice resolves to the latest).
export async function readRun(runId: string): Promise<RunRecord | null> {
  const matches = (await readRuns()).filter((r) => r.runId === runId);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// The ticket → run → usage join: resolve a ticket's stamped runId to its run
// record. Returns null when the ticket has no provenance (a human/CLI write) or
// the run isn't logged.
export async function getRunForTicket(ticketId: string): Promise<RunRecord | null> {
  // A lookup never throws: an unknown/deleted or malformed id (getTicket raises
  // 404/400) simply has no run to join, so it resolves to null.
  let ticket;
  try {
    ticket = await getTicket(ticketId);
  } catch {
    return null;
  }
  return ticket.runId ? readRun(ticket.runId) : null;
}

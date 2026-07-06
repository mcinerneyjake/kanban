import { readRuns, type RunRecord } from './runLog.js';
import { type CostLine } from './cost.js';
import { acceptedCount } from './economics.js';
import {
  type EconomicsSummary,
  type EconomicsRunDetail,
  type EconomicsLine,
  type EconomicsPoint,
  type EconomicsTotals,
  LABEL_TOTAL_RUN_COST,
  LABEL_COST_PER_ACCEPTED,
  LABEL_NET_SAVINGS,
  LABEL_LOCAL_VS_CLOUD,
} from '../../shared/constants.js';

// ---------------------------------------------------------------------------
// Economics aggregation. Rolls the per-run records in the run log up into a
// FinOps summary for GET /api/economics: totals, cost lines summed across the
// range (grouped measured/assumed/externalities), re-derived headline metrics,
// and a per-day time series. Pure `summarizeEconomics` (testable without IO) +
// a thin `summarizeEconomicsFromLog` wrapper over readRuns(), mirroring the
// summarize / summarizeBoard split in server/tickets.ts.
// ---------------------------------------------------------------------------

export interface EconomicsRange {
  from?: string; // inclusive lower bound (ISO; the controller normalizes bare dates)
  to?: string;   // inclusive upper bound
}

// Compare by parsed INSTANT, not lexically: the run log's `at` is canonical
// `...Z`, but a client-supplied bound may carry a zone offset or omit
// milliseconds, which a string compare would order wrongly and silently drop
// in-window runs. An unparseable bound is treated as unbounded.
function inRange(at: string, from?: string, to?: string): boolean {
  const t = Date.parse(at);
  if (from) { const f = Date.parse(from); if (!Number.isNaN(f) && t < f) return false; }
  if (to) { const e = Date.parse(to); if (!Number.isNaN(e) && t > e) return false; }
  return true;
}

// Notes describe the AGGREGATE's provenance (matching economics.ts's hyphen
// style), never a stale per-run note carried over.
const PARTIAL_NOTE = 'partial - some runs were notional';
const NOTIONAL_NOTE = 'notional - not reported in any run';

const groupKey = (l: { label: string; unit: string }): string => JSON.stringify([l.label, l.unit]);

interface Agg { label: string; unit: string; kind: CostLine['kind']; sum: number; count: number; sawNum: boolean; sawNull: boolean }

// Sum a cost-line group across runs, keyed by (label, unit) — `'marginal energy'`
// ships in both kWh and USD, so label alone would collide. Notes reflect the
// aggregate: a line that was only ever null stays null + notional; a mix of null
// and real sums the reals and is flagged partial (so a real total is never
// mislabelled "notional", and an incomplete sum isn't shown as if complete).
// `partial` = any USD line saw a null; `nullish` = the (label,unit) keys that
// saw a null, so the headline derivation can flag a partially-summed total.
function sumGroup(perRun: CostLine[][]): { lines: EconomicsLine[]; partial: boolean; nullish: Set<string> } {
  const acc = new Map<string, Agg>();
  let partial = false;
  const nullish = new Set<string>();
  for (const group of perRun) {
    for (const line of group) {
      const key = groupKey(line);
      let a = acc.get(key);
      if (!a) { a = { label: line.label, unit: line.unit, kind: line.kind, sum: 0, count: 0, sawNum: false, sawNull: false }; acc.set(key, a); }
      if (line.amount === null) {
        a.sawNull = true;
        nullish.add(key);
        if (line.unit === 'USD') partial = true;
      } else {
        a.sawNum = true;
        a.sum += line.amount;
        a.count += 1;
      }
    }
  }
  const lines = [...acc.values()].map((a): EconomicsLine => {
    if (!a.sawNum) return { label: a.label, amount: null, unit: a.unit, kind: a.kind, note: NOTIONAL_NOTE };
    // Percentages are ratios — average across runs, not sum (a summed % > 100 is
    // meaningless). Every other unit (tokens, ms, USD, kWh, count, …) is additive.
    const amount = a.unit === '%' ? a.sum / a.count : a.sum;
    return { label: a.label, amount, unit: a.unit, kind: a.kind, ...(a.sawNull ? { note: PARTIAL_NOTE } : {}) };
  });
  return { lines, partial, nullish };
}

function usdAmount(lines: EconomicsLine[], label: string): number | null {
  return lines.find((l) => l.label === label && l.unit === 'USD')?.amount ?? null;
}

// Headline: net savings + local-vs-cloud are differences of sums (summing is
// valid), but cost-per-accepted is a ratio, re-derived from the summed total
// cost and the accepted count — and flagged notional when its inputs are absent,
// or partial when the summed total cost was itself incomplete (so it isn't shown
// as a complete-looking, understated figure).
function deriveHeadline(
  assumed: EconomicsLine[],
  summedHeadline: EconomicsLine[],
  accepted: number,
  totalCostPartial: boolean,
): EconomicsLine[] {
  const totalRunCost = usdAmount(assumed, LABEL_TOTAL_RUN_COST);
  let amount: number | null = null;
  let note: string | undefined;
  if (totalRunCost === null) note = 'notional - total run cost incomplete';
  else if (accepted === 0) note = 'notional - no accepted tickets';
  else {
    amount = totalRunCost / accepted;
    if (totalCostPartial) note = 'partial - some runs had notional cost';
  }
  const costPerAccepted: EconomicsLine = { label: LABEL_COST_PER_ACCEPTED, amount, unit: 'USD', kind: 'assumed', ...(note ? { note } : {}) };
  const pick = (label: string): EconomicsLine =>
    summedHeadline.find((l) => l.label === label && l.unit === 'USD')
    ?? { label, amount: null, unit: 'USD', kind: 'assumed', note: NOTIONAL_NOTE };
  return [costPerAccepted, pick(LABEL_NET_SAVINGS), pick(LABEL_LOCAL_VS_CLOUD)];
}

function buildTimeSeries(runs: RunRecord[]): EconomicsPoint[] {
  const byDate = new Map<string, EconomicsPoint>();
  for (const r of runs) {
    const date = r.at.slice(0, 10); // YYYY-MM-DD
    const point = byDate.get(date) ?? { date, runCostUsd: null, totalTokens: 0, acceptedTickets: 0 };
    const cost = r.cost.assumed.find((l) => l.label === LABEL_TOTAL_RUN_COST && l.unit === 'USD')?.amount ?? null;
    if (cost !== null) point.runCostUsd = (point.runCostUsd ?? 0) + cost;
    point.totalTokens += r.usage.totalTokens;
    point.acceptedTickets += acceptedCount(r.outcome);
    byDate.set(date, point);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function summarizeEconomics(runs: RunRecord[], opts: EconomicsRange = {}): EconomicsSummary {
  const scope = runs.filter((r) => inRange(r.at, opts.from, opts.to));

  const totals: EconomicsTotals = {
    promptTokens: 0, completionTokens: 0, totalTokens: 0, activeMs: 0,
    created: 0, updated: 0, declined: 0, acceptedTickets: 0,
  };
  for (const r of scope) {
    totals.promptTokens += r.usage.promptTokens;
    totals.completionTokens += r.usage.completionTokens;
    totals.totalTokens += r.usage.totalTokens;
    totals.activeMs += r.usage.activeMs;
    totals.created += r.outcome.created;
    totals.updated += r.outcome.updated;
    totals.declined += r.outcome.declined;
    totals.acceptedTickets += acceptedCount(r.outcome);
  }

  const measured = sumGroup(scope.map((r) => r.cost.measured));
  const assumed = sumGroup(scope.map((r) => r.cost.assumed));
  const externalities = sumGroup(scope.map((r) => r.cost.externalities));
  const headline = sumGroup(scope.map((r) => r.cost.headline));
  const totalCostPartial = assumed.nullish.has(groupKey({ label: LABEL_TOTAL_RUN_COST, unit: 'USD' }));

  return {
    range: { from: opts.from ?? null, to: opts.to ?? null },
    runs: scope.length,
    totals,
    measured: measured.lines,
    assumed: assumed.lines,
    externalities: externalities.lines,
    headline: deriveHeadline(assumed.lines, headline.lines, totals.acceptedTickets, totalCostPartial),
    timeSeries: buildTimeSeries(scope),
    partial: measured.partial || assumed.partial || externalities.partial || headline.partial,
  };
}

export function summarizeEconomicsFromLog(opts: EconomicsRange = {}): Promise<EconomicsSummary> {
  return readRuns().then((runs) => summarizeEconomics(runs, opts));
}

// Single-run detail for the `?runId=` deep-link: the same summary over a one-run
// scope, enriched with the run's identity + authored ticket ids (which the
// aggregate rollup drops) so the detail view can link back to each ticket.
export function summarizeRun(run: RunRecord): EconomicsRunDetail {
  return {
    ...summarizeEconomics([run]),
    runId: run.runId,
    model: run.model,
    at: run.at,
    ticketIds: run.ticketIds,
  };
}

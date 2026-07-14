import { appendRun, type RunRecord } from './runLog.js';
import { buildSummary, type RunSummary } from './summary.js';
import { resolveCostConfig } from './costConfig.js';
import { type RunUsage } from './usage.js';
import { type RunOutcome } from './economics.js';

export interface MeterRunInput {
  runId: string;
  model: string;
  usage: RunUsage;
  outcome: RunOutcome;
  reviewMs: number;
  ticketIds: RunRecord['ticketIds'];
  // The cacheable prompt prefix (system prompt + tool schema) the cost model prices
  // separately from the per-run dynamic text — supplied by the caller (RUN_PREFIX_TEXT).
  prefixText: string;
  // The per-run variable input (the CLI's raw prompt, or the intake report).
  dynamicText: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Build a run's cost summary and persist it to the run log — the SINGLE metering path
// shared by the CLI (agent/index.ts) and the in-app intake controller, so their
// economics share one cost basis and record shape. Drift in the appendRun schema or the
// buildSummary composition now fails to compile here rather than silently diverging
// between the two call sites.
//
// Fully best-effort: the run's real work is already done (tickets written / response
// returned), so NEITHER cost assembly NOR the run-log write may surface as a failure —
// this must not throw. A cost-build failure returns an empty summary; a persist failure
// still returns the real (built) summary, so the CLI renders it even when the write drops.
export async function meterRun(input: MeterRunInput): Promise<RunSummary> {
  let cost: RunSummary;
  try {
    cost = buildSummary({
      usage: input.usage,
      outcome: input.outcome,
      reviewMs: input.reviewMs,
      cfg: resolveCostConfig(),
      model: input.model,
      prefixText: input.prefixText,
      dynamicText: input.dynamicText,
    });
  } catch (err) {
    console.warn(`[cost] failed to summarize run ${input.runId}: ${errMsg(err)}`);
    return { measured: [], assumed: [], externalities: [], headline: [] };
  }
  try {
    await appendRun({
      runId: input.runId,
      at: new Date().toISOString(),
      model: input.model,
      usage: input.usage,
      outcome: input.outcome,
      reviewMs: input.reviewMs,
      cost,
      ticketIds: input.ticketIds,
    });
  } catch (err) {
    console.warn(`[runlog] failed to persist run ${input.runId}: ${errMsg(err)}`);
  }
  return cost;
}

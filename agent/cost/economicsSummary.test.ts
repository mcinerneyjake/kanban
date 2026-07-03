import { describe, it, expect } from 'vitest';
import { summarizeEconomics } from './economicsSummary.js';
import { type RunRecord } from './runLog.js';
import { type CostLine } from './cost.js';
import { emptyUsage, type RunUsage } from './usage.js';
import { type RunOutcome } from './economics.js';
import { buildSummary } from './summary.js';
import { resolveCostConfig } from './costConfig.js';

// --- fixtures ---------------------------------------------------------------

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return { ...emptyUsage(), ...over };
}
function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return { created: 0, updated: 0, declined: 0, noProposal: false, errored: false, ...over };
}
function record(over: Partial<RunRecord> & { at: string }): RunRecord {
  return {
    runId: 'run',
    model: 'test-model',
    usage: usage(),
    outcome: outcome(),
    reviewMs: 0,
    cost: { measured: [], assumed: [], externalities: [], headline: [] },
    ticketIds: { created: [], updated: [] },
    ...over,
  };
}
const line = (label: string, amount: number | null, unit: string, kind: CostLine['kind'], note?: string): CostLine =>
  ({ label, amount, unit, kind, ...(note ? { note } : {}) });

describe('summarizeEconomics — totals', () => {
  it('sums usage and outcome across runs; accepted = created + updated', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T10:00:00.000Z', usage: usage({ promptTokens: 100, completionTokens: 20, totalTokens: 120, activeMs: 500 }), outcome: outcome({ created: 1 }) }),
      record({ at: '2026-07-02T10:00:00.000Z', usage: usage({ promptTokens: 50, completionTokens: 10, totalTokens: 60, activeMs: 300 }), outcome: outcome({ updated: 1, declined: 2 }) }),
    ]);
    expect(s.runs).toBe(2);
    expect(s.totals).toMatchObject({ promptTokens: 150, completionTokens: 30, totalTokens: 180, activeMs: 800, created: 1, updated: 1, declined: 2, acceptedTickets: 2 });
  });

  it('returns zeroed totals + empty groups for an empty log', () => {
    const s = summarizeEconomics([]);
    expect(s.runs).toBe(0);
    expect(s.totals.totalTokens).toBe(0);
    expect(s.measured).toEqual([]);
    expect(s.partial).toBe(false);
  });
});

describe('summarizeEconomics — cost-line aggregation', () => {
  it('sums cost lines by (label, unit), preserving unit + kind', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', cost: { measured: [line('active compute', 500, 'ms', 'measured')], assumed: [line('marginal energy', 0.001, 'kWh', 'assumed'), line('total run cost', 0.02, 'USD', 'assumed')], externalities: [line('carbon footprint', 3, 'gCO2e', 'externality')], headline: [] } }),
      record({ at: '2026-07-02T00:00:00.000Z', cost: { measured: [line('active compute', 300, 'ms', 'measured')], assumed: [line('marginal energy', 0.002, 'kWh', 'assumed'), line('total run cost', 0.03, 'USD', 'assumed')], externalities: [line('carbon footprint', 2, 'gCO2e', 'externality')], headline: [] } }),
    ]);
    expect(s.measured).toContainEqual({ label: 'active compute', amount: 800, unit: 'ms', kind: 'measured' });
    expect(s.assumed).toContainEqual({ label: 'marginal energy', amount: expect.closeTo(0.003), unit: 'kWh', kind: 'assumed' });
    expect(s.assumed).toContainEqual({ label: 'total run cost', amount: expect.closeTo(0.05), unit: 'USD', kind: 'assumed' });
    expect(s.externalities).toContainEqual({ label: 'carbon footprint', amount: 5, unit: 'gCO2e', kind: 'externality' });
  });

  it('averages percentage (ratio) lines across runs instead of summing them', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', cost: { measured: [line('cacheable prefix', 40, '%', 'measured')], assumed: [], externalities: [], headline: [] } }),
      record({ at: '2026-07-02T00:00:00.000Z', cost: { measured: [line('cacheable prefix', 50, '%', 'measured')], assumed: [], externalities: [], headline: [] } }),
    ]);
    expect(s.measured.find((l) => l.label === 'cacheable prefix')?.amount).toBe(45); // mean, not 90
  });

  it('flags partial + keeps a USD line null when it was only ever notional', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', cost: { measured: [], assumed: [line('keep-warm energy cost', null, 'USD', 'assumed', 'notional')], externalities: [], headline: [] } }),
      record({ at: '2026-07-02T00:00:00.000Z', cost: { measured: [], assumed: [line('keep-warm energy cost', null, 'USD', 'assumed', 'notional')], externalities: [], headline: [] } }),
    ]);
    expect(s.partial).toBe(true);
    expect(s.assumed.find((l) => l.label === 'keep-warm energy cost')?.amount).toBeNull();
  });

  it('sums the numbers when a line is mixed null + present (partial still flags)', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', cost: { measured: [], assumed: [line('review time cost', 0.10, 'USD', 'assumed')], externalities: [], headline: [] } }),
      record({ at: '2026-07-02T00:00:00.000Z', cost: { measured: [], assumed: [line('review time cost', null, 'USD', 'assumed')], externalities: [], headline: [] } }),
    ]);
    expect(s.assumed.find((l) => l.label === 'review time cost')?.amount).toBeCloseTo(0.10);
    expect(s.partial).toBe(true);
  });
});

describe('summarizeEconomics — headline re-derivation', () => {
  it('re-derives cost-per-accepted as sum(total cost)/sum(accepted), NOT the sum of per-run ratios', () => {
    // Run A: $0.06 over 3 accepted ($0.02/ea). Run B: $0.04 over 1 accepted ($0.04/ea).
    // Aggregate must be 0.10 / 4 = 0.025 — not (0.02 + 0.04) = 0.06.
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', outcome: outcome({ created: 3 }), cost: { measured: [], assumed: [line('total run cost', 0.06, 'USD', 'assumed')], externalities: [], headline: [line('cost per accepted ticket', 0.02, 'USD', 'assumed')] } }),
      record({ at: '2026-07-02T00:00:00.000Z', outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.04, 'USD', 'assumed')], externalities: [], headline: [line('cost per accepted ticket', 0.04, 'USD', 'assumed')] } }),
    ]);
    expect(s.headline.find((l) => l.label === 'cost per accepted ticket')?.amount).toBeCloseTo(0.025);
  });

  it('sums net savings + local-vs-cloud from the headline group (difference of sums)', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.02, 'USD', 'assumed')], externalities: [], headline: [line('net savings', 1.50, 'USD', 'assumed'), line('local vs cloud (saved)', 0.30, 'USD', 'assumed')] } }),
      record({ at: '2026-07-02T00:00:00.000Z', outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.02, 'USD', 'assumed')], externalities: [], headline: [line('net savings', 2.50, 'USD', 'assumed'), line('local vs cloud (saved)', 0.20, 'USD', 'assumed')] } }),
    ]);
    expect(s.headline.find((l) => l.label === 'net savings')?.amount).toBeCloseTo(4.0);
    expect(s.headline.find((l) => l.label === 'local vs cloud (saved)')?.amount).toBeCloseTo(0.5);
  });

  it('marks cost-per-accepted notional when no tickets were accepted', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', outcome: outcome({ declined: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.02, 'USD', 'assumed')], externalities: [], headline: [] } }),
    ]);
    const cpa = s.headline.find((l) => l.label === 'cost per accepted ticket');
    expect(cpa?.amount).toBeNull();
    expect(cpa?.note).toMatch(/no accepted tickets/);
  });
});

describe('summarizeEconomics — filtering + time series', () => {
  const runs = [
    record({ at: '2026-07-01T09:00:00.000Z', usage: usage({ totalTokens: 10 }), outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.01, 'USD', 'assumed')], externalities: [], headline: [] } }),
    record({ at: '2026-07-01T18:00:00.000Z', usage: usage({ totalTokens: 20 }), outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.02, 'USD', 'assumed')], externalities: [], headline: [] } }),
    record({ at: '2026-07-03T12:00:00.000Z', usage: usage({ totalTokens: 5 }), outcome: outcome({ updated: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.03, 'USD', 'assumed')], externalities: [], headline: [] } }),
  ];

  it('filters by inclusive [from, to] on record.at', () => {
    const s = summarizeEconomics(runs, { from: '2026-07-01T00:00:00.000Z', to: '2026-07-01T23:59:59.999Z' });
    expect(s.runs).toBe(2);
    expect(s.totals.totalTokens).toBe(30);
  });

  it('buckets the time series by day, oldest first, summing per-day cost + tokens', () => {
    const s = summarizeEconomics(runs);
    expect(s.timeSeries.map((p) => p.date)).toEqual(['2026-07-01', '2026-07-03']);
    expect(s.timeSeries[0]).toMatchObject({ date: '2026-07-01', runCostUsd: expect.closeTo(0.03), totalTokens: 30, acceptedTickets: 2 });
    expect(s.timeSeries[1]).toMatchObject({ date: '2026-07-03', totalTokens: 5, acceptedTickets: 1 });
  });
});

describe('summarizeEconomics — note provenance + bound parsing', () => {
  it('does not carry a stale notional note onto a summed real value', () => {
    // First run notional, later run real → the aggregate is a real summed value
    // flagged `partial`, NOT mislabelled "unavailable/notional" from the first run.
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', cost: { measured: [line('total tokens', null, 'tokens', 'measured', 'usage unavailable')], assumed: [], externalities: [], headline: [] } }),
      record({ at: '2026-07-02T00:00:00.000Z', cost: { measured: [line('total tokens', 5000, 'tokens', 'measured')], assumed: [], externalities: [], headline: [] } }),
    ]);
    const tokens = s.measured.find((l) => l.label === 'total tokens');
    expect(tokens?.amount).toBe(5000);
    expect(tokens?.note).not.toMatch(/unavailable|not reported/);
    expect(tokens?.note).toMatch(/partial/);
  });

  it('flags cost-per-accepted partial when the summed total cost was incomplete', () => {
    const s = summarizeEconomics([
      record({ at: '2026-07-01T00:00:00.000Z', outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', 0.10, 'USD', 'assumed')], externalities: [], headline: [] } }),
      record({ at: '2026-07-02T00:00:00.000Z', outcome: outcome({ created: 1 }), cost: { measured: [], assumed: [line('total run cost', null, 'USD', 'assumed')], externalities: [], headline: [] } }),
    ]);
    const cpa = s.headline.find((l) => l.label === 'cost per accepted ticket');
    expect(cpa?.amount).toBeCloseTo(0.05); // 0.10 / 2 accepted — understated, so flagged
    expect(cpa?.note).toMatch(/partial/);
    expect(s.partial).toBe(true);
  });

  it('filters by instant, not lexically, when a bound carries a zone offset', () => {
    // Run at 08:00Z; from = 09:00+02:00 = 07:00Z, so the run IS in range. A naive
    // string compare ('...T09:00:00+02:00' > '...T08:00:00.000Z') would drop it.
    const runs = [record({ at: '2026-07-01T08:00:00.000Z', usage: usage({ totalTokens: 1 }) })];
    expect(summarizeEconomics(runs, { from: '2026-07-01T09:00:00+02:00' }).runs).toBe(1);
  });
});

describe('summarizeEconomics — real cost lines (buildSummary)', () => {
  it('aggregates realistically-shaped records without dropping groups', () => {
    // buildSummary with an unconfigured cost model → real labels, mostly notional
    // (null) amounts. Proves the aggregator matches the actual label strings and
    // flags partial rather than silently zeroing.
    const cost = buildSummary({
      usage: usage({ promptTokens: 200, completionTokens: 50, totalTokens: 250, activeMs: 900, calls: 2, reportedCalls: 2 }),
      outcome: outcome({ created: 1 }),
      reviewMs: 4000,
      cfg: resolveCostConfig({}),
      model: 'qwen',
      prefixText: 'sys',
      dynamicText: 'report',
    });
    const s = summarizeEconomics([record({ at: '2026-07-01T00:00:00.000Z', outcome: outcome({ created: 1 }), cost })]);
    expect(s.runs).toBe(1);
    // The measured token lines flow through with real labels.
    expect(s.measured.some((l) => l.label === 'total tokens')).toBe(true);
    expect(s.headline.some((l) => l.label === 'cost per accepted ticket')).toBe(true);
  });
});

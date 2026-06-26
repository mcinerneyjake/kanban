import { describe, it, expect } from 'vitest';
import { buildSummary, renderSummary, type SummaryInput } from './summary.js';
import { resolveCostConfig } from './costConfig.js';
import { emptyUsage, type RunUsage } from './usage.js';
import { type RunOutcome } from './economics.js';

const usage: RunUsage = {
  ...emptyUsage(),
  promptTokens: 1000, completionTokens: 200, totalTokens: 1200,
  calls: 2, reportedCalls: 2, activeMs: 4000,
};
const outcome: RunOutcome = { created: 1, updated: 0, declined: 0, noProposal: false, errored: false };

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    usage,
    outcome,
    reviewMs: 0,
    cfg: resolveCostConfig({
      COST_ACTIVE_WATTS: '60', COST_IDLE_WATTS: '20', COST_ELECTRICITY_RATE: '0.2',
      COST_HARDWARE_COST: '3000', COST_HARDWARE_LIFE_YEARS: '3',
    }),
    model: 'local',
    prefixText: 'a'.repeat(120),
    dynamicText: 'b'.repeat(40),
    ...over,
  };
}

describe('buildSummary', () => {
  it('groups lines into measured / assumed / externalities by kind', () => {
    const s = buildSummary(input());
    expect(s.measured.find((l) => l.label === 'active compute')?.amount).toBe(4000);
    expect(s.measured.find((l) => l.label === 'total tokens')?.amount).toBe(1200);
    expect(s.measured.find((l) => l.label === 'cacheable prefix')).toBeDefined();
    expect(s.measured.find((l) => l.label === 'accepted tickets')?.amount).toBe(1);
    expect(s.assumed.find((l) => l.label === 'marginal energy cost')).toBeDefined();
    expect(s.assumed.find((l) => l.label === 'hardware amortization')).toBeDefined();
    expect(s.externalities.map((l) => l.label).sort()).toEqual(['carbon footprint', 'water footprint']);
    // kinds are internally consistent
    expect(s.measured.every((l) => l.kind === 'measured')).toBe(true);
    expect(s.assumed.every((l) => l.kind === 'assumed')).toBe(true);
    expect(s.externalities.every((l) => l.kind === 'externality')).toBe(true);
  });

  it('curates the headline and excludes those lines from assumed (no duplication)', () => {
    const s = buildSummary(input());
    const labels = s.headline.map((l) => l.label);
    expect(labels).toEqual(expect.arrayContaining([
      'cost per accepted ticket', 'net savings', 'local vs cloud (saved)',
    ]));
    expect(s.assumed.find((l) => l.label === 'net savings')).toBeUndefined();
    expect(s.assumed.find((l) => l.label === 'cost per accepted ticket')).toBeUndefined();
  });

  it('marks token lines "usage unavailable" when the runtime reported none', () => {
    const s = buildSummary(input({ usage: { ...emptyUsage(), activeMs: 100 } })); // reportedCalls 0
    const tot = s.measured.find((l) => l.label === 'total tokens');
    expect(tot?.amount).toBeNull();
    expect(tot?.note).toMatch(/unavailable/i);
  });

  it('includes the runtime cached-tokens line only when reported', () => {
    const withCache = buildSummary(input({ usage: { ...usage, cachedTokens: 50, cachedReported: true } }));
    const without = buildSummary(input()); // default usage: cachedReported false
    expect(withCache.measured.find((l) => l.label === 'cached tokens (runtime)')).toBeDefined();
    expect(without.measured.find((l) => l.label === 'cached tokens (runtime)')).toBeUndefined();
  });
});

describe('renderSummary', () => {
  it('renders the four sections and surfaces notional markers', () => {
    const out = renderSummary(buildSummary(input({ cfg: resolveCostConfig({}) }))); // watts unset → notional energy
    expect(out).toContain('— Measured —');
    expect(out).toContain('— Assumed ($) —');
    expect(out).toContain('— Externalities (report-only) —');
    expect(out).toContain('— Headline —');
    expect(out).toMatch(/notional/);
  });
});

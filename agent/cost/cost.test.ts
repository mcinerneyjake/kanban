import { describe, it, expect } from 'vitest';
import { EnergyCostModel, HardwareCostModel, ApiPriceCostModel, type CostLine } from './cost.js';
import { resolveCostConfig } from './costConfig.js';
import { emptyUsage, type RunUsage } from './usage.js';

function usageWith(partial: Partial<RunUsage>): RunUsage {
  return { ...emptyUsage(), ...partial };
}
function line(lines: CostLine[], label: string): CostLine {
  const found = lines.find((l) => l.label === label);
  if (!found) throw new Error(`no cost line: ${label}`);
  return found;
}

describe('EnergyCostModel', () => {
  // Fully-calibrated config: active 60W, idle 20W, $0.20/kWh, 2 runs/hr, water 3 L/kWh, carbon 400 g/kWh.
  const fullCfg = () => resolveCostConfig({
    COST_ACTIVE_WATTS: '60', COST_IDLE_WATTS: '20', COST_ELECTRICITY_RATE: '0.2',
    COST_UTILIZATION_RUNS_PER_HOUR: '2', COST_GRID_WATER_INTENSITY: '3', COST_GRID_CARBON_INTENSITY: '400',
  });

  it('computes marginal energy (kWh + $) from active-compute time × configured watts/rate', () => {
    const lines = new EnergyCostModel(fullCfg()).lines(usageWith({ activeMs: 1_800_000 })); // 0.5 h
    expect(line(lines, 'marginal energy').amount).toBeCloseTo(0.02, 9);       // (60-20)/1000 × 0.5
    expect(line(lines, 'marginal energy cost').amount).toBeCloseTo(0.004, 9); // 0.02 × 0.2
    expect(line(lines, 'marginal energy cost').kind).toBe('assumed');
  });

  it('clamps marginal power at zero when active <= idle (no negative cost)', () => {
    const cfg = resolveCostConfig({ COST_ACTIVE_WATTS: '20', COST_IDLE_WATTS: '50', COST_ELECTRICITY_RATE: '0.2' });
    const lines = new EnergyCostModel(cfg).lines(usageWith({ activeMs: 3_600_000 }));
    expect(line(lines, 'marginal energy').amount).toBe(0);
    expect(line(lines, 'marginal energy cost').amount).toBe(0);
  });

  it('computes keep-warm cost from the utilization assumption (separate assumed line)', () => {
    const lines = new EnergyCostModel(fullCfg()).lines(usageWith({ activeMs: 1_800_000 }));
    const kw = line(lines, 'keep-warm energy cost');
    expect(kw.amount).toBeCloseTo(0.002, 9); // (20/1000) × (1/2) × 0.2
    expect(kw.kind).toBe('assumed');
    expect(kw.note).toMatch(/2 run/);
  });

  it('emits water + carbon as externalities (never USD), from marginal kWh', () => {
    const lines = new EnergyCostModel(fullCfg()).lines(usageWith({ activeMs: 1_800_000 }));
    const water = line(lines, 'water footprint');
    const carbon = line(lines, 'carbon footprint');
    expect(water.amount).toBeCloseTo(0.06, 9); // 0.02 × 3
    expect(water.unit).toBe('L');
    expect(water.kind).toBe('externality');
    expect(carbon.amount).toBeCloseTo(8, 9);   // 0.02 × 400
    expect(carbon.kind).toBe('externality');
  });

  it('marks energy + externalities notional (null) when watts are unset — no crash', () => {
    const lines = new EnergyCostModel(resolveCostConfig({})).lines(usageWith({ activeMs: 1_800_000 }));
    expect(line(lines, 'marginal energy cost').amount).toBeNull();
    expect(line(lines, 'water footprint').amount).toBeNull();
    expect(line(lines, 'carbon footprint').amount).toBeNull();
    expect(line(lines, 'marginal energy cost').note).toMatch(/notional/i);
  });

  it('marks keep-warm notional when utilization is zero (no divide-by-zero)', () => {
    const cfg = resolveCostConfig({ COST_IDLE_WATTS: '20', COST_ELECTRICITY_RATE: '0.2', COST_UTILIZATION_RUNS_PER_HOUR: '0' });
    expect(line(new EnergyCostModel(cfg).lines(usageWith({ activeMs: 1_800_000 })), 'keep-warm energy cost').amount).toBeNull();
  });

  it('keep-warm is notional via the idle/rate branch when utilization is set but watts are not', () => {
    const cfg = resolveCostConfig({ COST_ELECTRICITY_RATE: '0.2' }); // utilization default 1 (set, >0); idle unset
    const kw = line(new EnergyCostModel(cfg).lines(usageWith({ activeMs: 1000 })), 'keep-warm energy cost');
    expect(kw.amount).toBeNull();
    expect(kw.note).toMatch(/idle watts/i);
  });

  it('the notional note names only the unset inputs', () => {
    const cfg = resolveCostConfig({ COST_ACTIVE_WATTS: '60', COST_ELECTRICITY_RATE: '0.2' }); // only idle unset
    const note = line(new EnergyCostModel(cfg).lines(usageWith({ activeMs: 1000 })), 'marginal energy cost').note ?? '';
    expect(note).toMatch(/idle watts/i);
    expect(note).not.toMatch(/active watts/i);
    expect(note).not.toMatch(/kWh/); // $/kWh is set — must not be listed
  });

  it('zero active time yields zero marginal energy (still a real, non-notional 0)', () => {
    const line0 = line(new EnergyCostModel(fullCfg()).lines(usageWith({ activeMs: 0 })), 'marginal energy cost');
    expect(line0.amount).toBe(0);
  });
});

describe('HardwareCostModel', () => {
  it('amortizes capital over life by active-compute time', () => {
    // life 1yr = 31,557,600 s; set cost = that many $ → exactly $1 per second of compute.
    const cfg = resolveCostConfig({ COST_HARDWARE_COST: '31557600', COST_HARDWARE_LIFE_YEARS: '1' });
    const l = line(new HardwareCostModel(cfg).lines(usageWith({ activeMs: 2000 })), 'hardware amortization');
    expect(l.amount).toBeCloseTo(2, 9); // $1/s × 2 s
    expect(l.kind).toBe('assumed');
  });

  it('is notional when hardware cost is unset (names the missing input)', () => {
    const l = line(new HardwareCostModel(resolveCostConfig({})).lines(usageWith({ activeMs: 1000 })), 'hardware amortization');
    expect(l.amount).toBeNull();
    expect(l.note).toMatch(/hardware cost/i);
  });

  it('is notional (no divide-by-zero) when life is zero', () => {
    const cfg = resolveCostConfig({ COST_HARDWARE_COST: '3000', COST_HARDWARE_LIFE_YEARS: '0' });
    expect(line(new HardwareCostModel(cfg).lines(usageWith({ activeMs: 1000 })), 'hardware amortization').amount).toBeNull();
  });

  it('zero active time amortizes to 0 (a real 0, not notional)', () => {
    const cfg = resolveCostConfig({ COST_HARDWARE_COST: '3000', COST_HARDWARE_LIFE_YEARS: '3' });
    expect(line(new HardwareCostModel(cfg).lines(usageWith({ activeMs: 0 })), 'hardware amortization').amount).toBe(0);
  });

  it('scales linearly with active-compute time', () => {
    const cfg = resolveCostConfig({ COST_HARDWARE_COST: '3000', COST_HARDWARE_LIFE_YEARS: '3' });
    const a = line(new HardwareCostModel(cfg).lines(usageWith({ activeMs: 1000 })), 'hardware amortization').amount;
    const b = line(new HardwareCostModel(cfg).lines(usageWith({ activeMs: 2000 })), 'hardware amortization').amount;
    expect(a).not.toBeNull();
    expect(b).toBeCloseTo((a ?? 0) * 2, 12);
  });

  it('capital amortization dominates marginal energy for the same run (the headline insight)', () => {
    const cfg = resolveCostConfig({
      COST_HARDWARE_COST: '3000', COST_HARDWARE_LIFE_YEARS: '3',
      COST_ACTIVE_WATTS: '60', COST_IDLE_WATTS: '20', COST_ELECTRICITY_RATE: '0.2',
    });
    const usage = usageWith({ activeMs: 60_000 });
    const hw = line(new HardwareCostModel(cfg).lines(usage), 'hardware amortization').amount ?? 0;
    const energy = line(new EnergyCostModel(cfg).lines(usage), 'marginal energy cost').amount ?? 0;
    expect(hw).toBeGreaterThan(energy);
    expect(hw).toBeGreaterThan(0);
  });
});

describe('ApiPriceCostModel (dormant seam)', () => {
  it('is notional when no price is configured for the model', () => {
    const lines = new ApiPriceCostModel({}, 'some-model').lines(usageWith({ promptTokens: 1000, completionTokens: 500 }));
    expect(lines[0].amount).toBeNull();
    expect(lines[0].note).toMatch(/notional/i);
  });

  it('computes cloud-equivalent cost from tokens × a configured price table', () => {
    const prices = {
      'gpt-x': {
        inputPerMTok: { value: 3, unit: 'USD/Mtok', source: 'test' },
        outputPerMTok: { value: 15, unit: 'USD/Mtok', source: 'test' },
      },
    };
    const lines = new ApiPriceCostModel(prices, 'gpt-x').lines(usageWith({ promptTokens: 1_000_000, completionTokens: 1_000_000 }));
    expect(lines[0].amount).toBeCloseTo(18, 9); // 1×3 + 1×15
    expect(lines[0].kind).toBe('assumed');
  });

  it('is notional when only one side of the price is configured', () => {
    const prices = {
      m: {
        inputPerMTok: { value: 3, unit: 'USD/Mtok', source: 'test' },
        outputPerMTok: { value: null, unit: 'USD/Mtok', source: 'unset' },
      },
    };
    const lines = new ApiPriceCostModel(prices, 'm').lines(usageWith({ promptTokens: 1000, completionTokens: 1000 }));
    expect(lines[0].amount).toBeNull();
  });

  it('a priced model with zero tokens costs 0 (a real 0, not notional)', () => {
    const prices = {
      m: {
        inputPerMTok: { value: 3, unit: 'USD/Mtok', source: 'test' },
        outputPerMTok: { value: 15, unit: 'USD/Mtok', source: 'test' },
      },
    };
    const lines = new ApiPriceCostModel(prices, 'm').lines(usageWith({}));
    expect(lines[0].amount).toBe(0);
  });

  // tkt-4251671dcb5a. intake merges the chat and embed meters, so `promptTokens` is a MIXED total —
  // and this model prices all of it at the CHAT model's input rate. An embed model is an order of
  // magnitude cheaper, so the cloud-equivalent (and the local-vs-cloud saving derived from it) came out
  // inflated. The trace already carries per-call `kind` and tokens, so the split needs no new plumbing.
  describe('mixed chat + embed usage', () => {
    const prices = {
      chat: {
        inputPerMTok: { value: 3, unit: 'USD/Mtok', source: 'test' },
        outputPerMTok: { value: 15, unit: 'USD/Mtok', source: 'test' },
      },
    };
    const call = (kind: 'chat' | 'embed', prompt: number, completion: number, startedAt: number) =>
      ({ kind, startedAt, ms: 10, inputChars: 100, tokens: { prompt, completion, total: prompt + completion } });

    it('prices only the chat tokens, and says the embed ones were excluded', () => {
      const usage = usageWith({
        promptTokens: 1_000_000 + 4_000_000, // 1M chat + 4M embed, as mergeUsage produces
        completionTokens: 1_000_000,
        calls: 2,
        reportedCalls: 2,
        activeMs: 20,
        callTrace: [call('chat', 1_000_000, 1_000_000, 1), call('embed', 4_000_000, 0, 2)],
      });
      const [cloud] = new ApiPriceCostModel(prices, 'chat').lines(usage);
      expect(cloud.amount).toBeCloseTo(18, 9); // 1M×3 + 1M×15 — the embed 4M is NOT priced at $3/Mtok
      // Names the exclusion AND how much was excluded: a note that just says "some tokens omitted"
      // leaves the reader unable to judge the size of what is missing.
      expect(cloud.note).toMatch(/embed/i);
      expect(cloud.note).toContain('4,000,000');
    });

    // The control: exclusion must not become "price nothing". A chat-only traced run is unchanged.
    it('leaves a chat-only run exactly as before', () => {
      const usage = usageWith({
        promptTokens: 1_000_000, completionTokens: 1_000_000, calls: 1, reportedCalls: 1, activeMs: 10,
        callTrace: [call('chat', 1_000_000, 1_000_000, 1)],
      });
      const [cloud] = new ApiPriceCostModel(prices, 'chat').lines(usage);
      expect(cloud.amount).toBeCloseTo(18, 9);
      expect(cloud.note).toBeUndefined(); // nothing was excluded, so nothing to caveat
    });

    // A pre-trace run (callTrace undefined) cannot be split at all. Keeping the old total is the only
    // option, but it must SAY the total may include embed tokens rather than imply a clean figure.
    it('falls back to the mixed total when the trace is absent, and states the assumption', () => {
      const usage = usageWith({ promptTokens: 1_000_000, completionTokens: 1_000_000, reportedCalls: 1 });
      delete usage.callTrace; // a run logged before tracing existed
      const [cloud] = new ApiPriceCostModel(prices, 'chat').lines(usage);
      expect(cloud.amount).toBeCloseTo(18, 9);
      expect(cloud.note).toMatch(/no usable call trace/i);
    });

    // The mirror of the bug: charging only what the trace accounts for would UNDERSTATE the figure when
    // the trace cannot account for the totals. An empty trace beside real tokens is the reachable case,
    // since emptyUsage() supplies `callTrace: []`.
    it('falls back rather than zeroing when the trace cannot account for the totals', () => {
      const usage = usageWith({ promptTokens: 1_000_000, completionTokens: 1_000_000, reportedCalls: 1, callTrace: [] });
      const [cloud] = new ApiPriceCostModel(prices, 'chat').lines(usage);
      expect(cloud.amount).toBeCloseTo(18, 9); // NOT 0
      expect(cloud.note).toMatch(/no usable call trace/i);
    });

    it('is 0, not notional, for a run that was ONLY embeddings', () => {
      const usage = usageWith({
        promptTokens: 4_000_000, calls: 1, reportedCalls: 1, activeMs: 10,
        callTrace: [call('embed', 4_000_000, 0, 1)],
      });
      const [cloud] = new ApiPriceCostModel(prices, 'chat').lines(usage);
      expect(cloud.amount).toBe(0); // a measured zero: there was no chat work to price
      expect(cloud.note).toMatch(/embed/i);
    });
  });
});

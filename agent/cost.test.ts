import { describe, it, expect } from 'vitest';
import { EnergyCostModel, ApiPriceCostModel, type CostLine } from './cost.js';
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
});

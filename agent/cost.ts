import { type RunUsage } from './usage.js';
import { type CostConfig, type ApiPrice, type Sourced, isSet } from './costConfig.js';

// A single economic figure, tagged so the summary can group measured truth,
// labeled assumptions, and report-only externalities separately. `amount: null`
// means notional — a required input was unset (never a silent zero).
export type CostKind = 'measured' | 'assumed' | 'externality';

export interface CostLine {
  label: string;
  amount: number | null;
  unit: string;
  kind: CostKind;
  note?: string;
}

// A run's measured inputs (tokens, active-compute time) drive the lines; assumed
// factors come from config.
export interface CostModel {
  lines(usage: RunUsage): CostLine[];
}

const MS_PER_HOUR = 3_600_000;

function missingNote(pairs: [string, Sourced][]): string {
  const missing = pairs.filter(([, s]) => !isSet(s)).map(([name]) => name);
  return `notional — set ${missing.join(', ')}`;
}

// Local energy cost. Phase A: power + rate come from config, so the $ lines are
// ASSUMED (only as good as the calibration). Marginal $ is the per-run headline;
// keep-warm is a separate amortized line; water + carbon are externalities.
export class EnergyCostModel implements CostModel {
  constructor(private readonly cfg: CostConfig) {}

  lines(usage: RunUsage): CostLine[] {
    const { kwh, lines } = this.marginal(usage);
    return [...lines, this.keepWarm(), ...this.externalities(kwh)];
  }

  // Marginal = (active − model-loaded-idle) watts × active-compute time. NOT
  // wall-clock. Clamped at 0 so active ≤ idle never yields a negative cost.
  private marginal(usage: RunUsage): { kwh: number | null; lines: CostLine[] } {
    const { activeWatts: a, idleWatts: i, electricityRate: r } = this.cfg;
    if (!isSet(a) || !isSet(i) || !isSet(r)) {
      const note = missingNote([['active watts', a], ['idle watts', i], ['$/kWh', r]]);
      return { kwh: null, lines: [
        { label: 'marginal energy', amount: null, unit: 'kWh', kind: 'assumed', note },
        { label: 'marginal energy cost', amount: null, unit: 'USD', kind: 'assumed', note },
      ] };
    }
    const marginalKw = Math.max(0, a.value - i.value) / 1000;
    const kwh = marginalKw * (usage.activeMs / MS_PER_HOUR);
    return { kwh, lines: [
      { label: 'marginal energy', amount: kwh, unit: 'kWh', kind: 'assumed' },
      { label: 'marginal energy cost', amount: kwh * r.value, unit: 'USD', kind: 'assumed' },
    ] };
  }

  // The amortized cost of keeping the model warm between runs: idle draw × the
  // warm time attributed to one run (from the utilization assumption).
  private keepWarm(): CostLine {
    const label = 'keep-warm energy cost';
    const { idleWatts: i, electricityRate: r, utilizationRunsPerHour: u } = this.cfg;
    if (!isSet(u) || u.value <= 0) {
      return { label, amount: null, unit: 'USD', kind: 'assumed', note: 'notional — set a positive utilization (runs/hour)' };
    }
    if (!isSet(i) || !isSet(r)) {
      return { label, amount: null, unit: 'USD', kind: 'assumed', note: missingNote([['idle watts', i], ['$/kWh', r]]) };
    }
    const warmHoursPerRun = 1 / u.value;
    const kwh = (i.value / 1000) * warmHoursPerRun;
    return { label, amount: kwh * r.value, unit: 'USD', kind: 'assumed', note: `assumes ${u.value} run(s)/hour` };
  }

  // Report-only footprints from the run's marginal energy — never folded into $.
  private externalities(kwh: number | null): CostLine[] {
    const { gridWaterIntensity: w, gridCarbonIntensity: c } = this.cfg;
    const water: CostLine = kwh !== null && isSet(w)
      ? { label: 'water footprint', amount: kwh * w.value, unit: 'L', kind: 'externality' }
      : { label: 'water footprint', amount: null, unit: 'L', kind: 'externality', note: 'notional' };
    const carbon: CostLine = kwh !== null && isSet(c)
      ? { label: 'carbon footprint', amount: kwh * c.value, unit: 'gCO2e', kind: 'externality' }
      : { label: 'carbon footprint', amount: null, unit: 'gCO2e', kind: 'externality', note: 'notional' };
    return [water, carbon];
  }
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

// Capital cost attributed to a run: the machine's purchase price spread over its
// useful life, charged for the run's active-compute time. Often the DOMINANT
// real cost of local inference — without it the energy-only $ is misleadingly
// tiny. Assumed (depends on configured cost + life).
export class HardwareCostModel implements CostModel {
  constructor(private readonly cfg: CostConfig) {}

  lines(usage: RunUsage): CostLine[] {
    const label = 'hardware amortization';
    const { hardwareCost: h, hardwareLifeYears: y } = this.cfg;
    if (!isSet(y) || y.value <= 0) {
      return [{ label, amount: null, unit: 'USD', kind: 'assumed', note: 'notional — set a positive hardware life (years)' }];
    }
    if (!isSet(h)) {
      return [{ label, amount: null, unit: 'USD', kind: 'assumed', note: missingNote([['hardware cost', h]]) }];
    }
    const usdPerSecond = h.value / (y.value * SECONDS_PER_YEAR);
    const usd = usdPerSecond * (usage.activeMs / 1000);
    return [{ label, amount: usd, unit: 'USD', kind: 'assumed', note: `${h.value} over ${y.value}yr, by active-compute time` }];
  }
}

// Cloud-equivalent cost for the local-vs-cloud comparison. Dormant until #5
// populates the price table from CURRENT vendor pricing (never hardcode rates).
export class ApiPriceCostModel implements CostModel {
  constructor(
    private readonly prices: Record<string, ApiPrice>,
    private readonly model: string,
  ) {}

  lines(usage: RunUsage): CostLine[] {
    const label = `cloud-equivalent (${this.model})`;
    const price = this.prices[this.model];
    if (!price || !isSet(price.inputPerMTok) || !isSet(price.outputPerMTok)) {
      return [{ label, amount: null, unit: 'USD', kind: 'assumed', note: 'notional — no price configured for this model' }];
    }
    const usd = (usage.promptTokens / 1e6) * price.inputPerMTok.value
      + (usage.completionTokens / 1e6) * price.outputPerMTok.value;
    return [{ label, amount: usd, unit: 'USD', kind: 'assumed' }];
  }
}

// Single home for every ASSUMED cost input, each default annotated with its
// source — so "assumed" reads as "modeled," not "made up." Env-overridable via
// COST_* vars. A value left null is NOTIONAL: the consuming cost line must mark
// itself notional rather than substitute a silent zero. Measurements (tokens,
// active-compute time, sampled power) live elsewhere; this file is assumptions.

export interface Sourced {
  /** null = unset → the consuming cost line is notional, not zero. */
  value: number | null;
  unit: string;
  /** Provenance: where the number comes from, or how to obtain it. */
  source: string;
}

export interface ApiPrice {
  inputPerMTok: Sourced;
  outputPerMTok: Sourced;
}

export interface CostConfig {
  electricityRate: Sourced;          // $/kWh
  idleWatts: Sourced;                // W — model-loaded idle (tier 2)
  activeWatts: Sourced;              // W — during inference (tier 3)
  utilizationRunsPerHour: Sourced;   // for keep-warm attribution
  hardwareCost: Sourced;             // $
  hardwareLifeYears: Sourced;        // years
  laborRate: Sourced;                // $/hour, loaded
  manualMinutesPerReport: Sourced;   // minutes
  gridCarbonIntensity: Sourced;      // gCO2e/kWh
  gridWaterIntensity: Sourced;       // L/kWh
  /** Per-model cloud prices for the local-vs-cloud comparison (#5). Empty until
   *  populated from CURRENT vendor pricing — never hardcode stale rates. */
  apiPrices: Record<string, ApiPrice>;
}

function sourced(value: number | null, unit: string, source: string): Sourced {
  return { value, unit, source };
}

// Read a COST_<KEY> override; fall back to the documented default. Invalid
// overrides — non-numeric, empty, whitespace, NaN/Infinity, or negative — are
// ignored (a cost input can't be negative or infinite). 0 is valid.
function envNum(env: NodeJS.ProcessEnv, key: string, fallback: Sourced): Sourced {
  const raw = env[key];
  if (raw !== undefined && raw.trim() !== '') {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return { value: v, unit: fallback.unit, source: `env:${key}` };
  }
  return fallback;
}

export function resolveCostConfig(env: NodeJS.ProcessEnv = process.env): CostConfig {
  return {
    // Region/process assumptions ship as clearly-illustrative defaults.
    electricityRate: envNum(env, 'COST_ELECTRICITY_RATE',
      sourced(0.17, '$/kWh', 'illustrative US avg residential — set COST_ELECTRICITY_RATE to your tariff')),
    utilizationRunsPerHour: envNum(env, 'COST_UTILIZATION_RUNS_PER_HOUR',
      sourced(1, 'runs/hour', 'illustrative — set to your real utilization for keep-warm attribution')),
    hardwareLifeYears: envNum(env, 'COST_HARDWARE_LIFE_YEARS',
      sourced(3, 'years', 'common 3-year amortization, illustrative')),
    laborRate: envNum(env, 'COST_LABOR_RATE',
      sourced(50, '$/hour', 'illustrative loaded labor rate — set to yours')),
    manualMinutesPerReport: envNum(env, 'COST_MANUAL_MINUTES_PER_REPORT',
      sourced(5, 'minutes', 'illustrative manual-triage baseline — set to yours')),
    gridCarbonIntensity: envNum(env, 'COST_GRID_CARBON_INTENSITY',
      sourced(400, 'gCO2e/kWh', 'illustrative US-avg grid intensity — set to your region')),
    gridWaterIntensity: envNum(env, 'COST_GRID_WATER_INTENSITY',
      sourced(2.5, 'L/kWh', 'illustrative US-avg thermoelectric water intensity — set to your region')),

    // Machine-specific values have no honest default — null → notional until calibrated.
    idleWatts: envNum(env, 'COST_IDLE_WATTS',
      sourced(null, 'W', 'unset — measure model-loaded idle via powermetrics / nvidia-smi / wall-meter')),
    activeWatts: envNum(env, 'COST_ACTIVE_WATTS',
      sourced(null, 'W', 'unset — measure during inference via powermetrics / nvidia-smi / wall-meter')),
    hardwareCost: envNum(env, 'COST_HARDWARE_COST',
      sourced(null, '$', 'unset — your machine purchase price')),

    // Populated by #5 from current vendor pricing; never hardcode stale rates.
    apiPrices: {},
  };
}

// A value is usable iff it was actually set (default or override). 0 is valid.
export function isSet(s: Sourced): boolean {
  return s.value !== null;
}

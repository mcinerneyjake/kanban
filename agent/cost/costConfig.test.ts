import { describe, it, expect } from 'vitest';
import { resolveCostConfig, isSet } from './costConfig.js';

describe('resolveCostConfig', () => {
  it('ships illustrative region/process defaults with source annotations', () => {
    const c = resolveCostConfig({});
    expect(c.electricityRate).toMatchObject({ value: 0.17, unit: '$/kWh' });
    expect(c.electricityRate.source).toMatch(/illustrative/i);
    expect(c.hardwareLifeYears.value).toBe(3);
    expect(c.laborRate.value).toBe(50);
    expect(c.gridCarbonIntensity.source).toMatch(/region/i);
  });

  it('leaves machine-specific values unset (null → notional, not zero)', () => {
    const c = resolveCostConfig({});
    expect(c.idleWatts.value).toBeNull();
    expect(c.activeWatts.value).toBeNull();
    expect(c.hardwareCost.value).toBeNull();
    expect(isSet(c.idleWatts)).toBe(false);
    expect(c.idleWatts.source).toMatch(/measure/i);
  });

  it('applies a numeric env override and records its provenance', () => {
    const c = resolveCostConfig({ COST_ELECTRICITY_RATE: '0.25', COST_IDLE_WATTS: '40' });
    expect(c.electricityRate.value).toBe(0.25);
    expect(c.electricityRate.source).toBe('env:COST_ELECTRICITY_RATE');
    expect(c.idleWatts.value).toBe(40);
    expect(isSet(c.idleWatts)).toBe(true);
  });

  it('ignores invalid overrides (non-numeric, empty, whitespace, Infinity, negative) → keeps defaults', () => {
    const c = resolveCostConfig({
      COST_ELECTRICITY_RATE: 'abc',
      COST_LABOR_RATE: '',
      COST_HARDWARE_LIFE_YEARS: '   ',
      COST_MANUAL_MINUTES_PER_REPORT: 'Infinity',
      COST_GRID_CARBON_INTENSITY: '-5',
    });
    expect(c.electricityRate.value).toBe(0.17);
    expect(c.laborRate.value).toBe(50);
    expect(c.hardwareLifeYears.value).toBe(3);
    expect(c.manualMinutesPerReport.value).toBe(5);
    expect(c.gridCarbonIntensity.value).toBe(400);
  });

  it('a negative override on a normally-unset field stays unset (not accepted)', () => {
    const c = resolveCostConfig({ COST_IDLE_WATTS: '-10' });
    expect(c.idleWatts.value).toBeNull();
    expect(isSet(c.idleWatts)).toBe(false);
  });

  it('maps each field to its own COST_ env key (no transposition)', () => {
    const c = resolveCostConfig({
      COST_ELECTRICITY_RATE: '1',
      COST_UTILIZATION_RUNS_PER_HOUR: '2',
      COST_HARDWARE_LIFE_YEARS: '3',
      COST_LABOR_RATE: '4',
      COST_MANUAL_MINUTES_PER_REPORT: '5',
      COST_GRID_CARBON_INTENSITY: '6',
      COST_GRID_WATER_INTENSITY: '7',
      COST_IDLE_WATTS: '8',
      COST_ACTIVE_WATTS: '9',
      COST_HARDWARE_COST: '10',
    });
    expect(c.electricityRate.value).toBe(1);
    expect(c.utilizationRunsPerHour.value).toBe(2);
    expect(c.hardwareLifeYears.value).toBe(3);
    expect(c.laborRate.value).toBe(4);
    expect(c.manualMinutesPerReport.value).toBe(5);
    expect(c.gridCarbonIntensity.value).toBe(6);
    expect(c.gridWaterIntensity.value).toBe(7);
    expect(c.idleWatts.value).toBe(8);
    expect(c.activeWatts.value).toBe(9);
    expect(c.hardwareCost.value).toBe(10);
  });

  it('treats 0 as a valid override, not as unset', () => {
    const c = resolveCostConfig({ COST_IDLE_WATTS: '0' });
    expect(c.idleWatts.value).toBe(0);
    expect(isSet(c.idleWatts)).toBe(true);
    expect(c.idleWatts.source).toBe('env:COST_IDLE_WATTS');
  });

  it('starts with an empty API price table (no fabricated cloud rates)', () => {
    expect(resolveCostConfig({}).apiPrices).toEqual({});
  });
});

import { describe, it, expect } from 'vitest';
import { fmtInt, fmtUsd, sentence, formatAmount, headlineTile } from './econFormat.js';
import { type EconomicsLine } from '../../shared/constants.js';

const line = (amount: number | null, unit: string): EconomicsLine =>
  ({ label: 'x', amount, unit, kind: 'measured' });

describe('fmtInt', () => {
  it('rounds and groups with thousands separators', () => {
    expect(fmtInt(1234.6)).toBe('1,235');
    expect(fmtInt(0)).toBe('0');
  });
});

describe('fmtUsd', () => {
  it('uses 4 decimals under $1 and 2 decimals at/over $1', () => {
    expect(fmtUsd(0.0234)).toBe('$0.0234');
    expect(fmtUsd(12.5)).toBe('$12.50');
  });
  it('treats the boundary by magnitude, so negatives under $1 keep 4 decimals', () => {
    expect(fmtUsd(-0.5)).toBe('$-0.5000');
  });
});

describe('sentence', () => {
  it('capitalizes the first letter and leaves the rest', () => {
    expect(sentence('total run cost')).toBe('Total run cost');
  });
  it('is a no-op on empty input', () => {
    expect(sentence('')).toBe('');
  });
});

describe('headlineTile', () => {
  const headline: EconomicsLine[] = [
    { label: 'cost per accepted ticket', amount: 0.02, unit: 'USD', kind: 'assumed' },
    { label: 'net savings', amount: null, unit: 'USD', kind: 'assumed', note: 'notional - no data' },
  ];
  it('formats a present metric and carries its note', () => {
    expect(headlineTile(headline, 'cost per accepted ticket')).toEqual({ value: '$0.0200', note: undefined });
    expect(headlineTile(headline, 'net savings')).toEqual({ value: '—', note: 'notional - no data' });
  });
  it('falls back to an em dash for an absent metric', () => {
    expect(headlineTile(headline, 'local vs cloud (saved)')).toEqual({ value: '—', note: undefined });
    expect(headlineTile([], 'cost per accepted ticket')).toEqual({ value: '—', note: undefined });
  });
});

describe('formatAmount', () => {
  it('renders a null amount as an em dash, never $0', () => {
    expect(formatAmount(line(null, 'USD'))).toBe('—');
  });
  it('formats each unit distinctly', () => {
    expect(formatAmount(line(0.02, 'USD'))).toBe('$0.0200');
    expect(formatAmount(line(2500, 'ms'))).toBe('2.5s');
    expect(formatAmount(line(0.00123, 'kWh'))).toBe('0.00123 kWh');
    expect(formatAmount(line(3.6, 'gCO2e'))).toBe('4 gCO2e');
    expect(formatAmount(line(87.4, '%'))).toBe('87%');
    expect(formatAmount(line(12000, 'tokens'))).toBe('12,000 tokens');
  });
});

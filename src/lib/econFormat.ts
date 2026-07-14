import { type EconomicsLine } from '../../shared/constants.js';

export const fmtInt = (n: number): string => Math.round(n).toLocaleString();

// Sub-dollar figures need more precision than a headline total's two decimals.
export const fmtUsd = (n: number): string => `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`;

// Sentence-case for display; underlying strings stay lowercase.
export const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Formatted headline value for a StatTile, or "—" when the metric is absent.
export function headlineTile(headline: EconomicsLine[], label: string): { value: string; note?: string } {
  const l = headline.find((h) => h.label === label);
  return l ? { value: formatAmount(l), note: l.note } : { value: '—', note: undefined };
}

// A null amount is "—" (never $0), per the run-log contract; unit drives formatting.
export function formatAmount(line: EconomicsLine): string {
  if (line.amount === null) return '—';
  switch (line.unit) {
    case 'USD': return fmtUsd(line.amount);
    case 'ms': return `${(line.amount / 1000).toFixed(1)}s`;
    case 'kWh':
    case 'L': return `${line.amount.toPrecision(3)} ${line.unit}`;
    case 'gCO2e': return `${Math.round(line.amount)} ${line.unit}`;
    case '%': return `${Math.round(line.amount)}%`;
    default: return `${fmtInt(line.amount)} ${line.unit}`; // tokens, count
  }
}

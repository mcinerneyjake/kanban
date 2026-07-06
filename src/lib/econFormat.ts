import { type EconomicsLine } from '../../shared/constants.js';

// Display formatters for the economics views (aggregate dashboard + single-run
// detail). Pure and colocated-testable — the React parts render, these decide
// how a number reads.

export const fmtInt = (n: number): string => Math.round(n).toLocaleString();

// Sub-dollar figures (cost per accepted, energy $) need more precision than the
// two decimals a headline total wants.
export const fmtUsd = (n: number): string => `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`;

// Cost-model labels are lowercase by convention; sentence-case them for display
// (the underlying strings stay lowercase — the CLI renders them its own way).
export const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// A headline metric shaped for a StatTile: its formatted value + optional note,
// or a neutral em-dash when the metric is absent. Shared by the aggregate
// dashboard and the single-run detail so a headline reads identically in both.
export function headlineTile(headline: EconomicsLine[], label: string): { value: string; note?: string } {
  const l = headline.find((h) => h.label === label);
  return l ? { value: formatAmount(l), note: l.note } : { value: '—', note: undefined };
}

// Render one cost line's value honestly: a null amount is "—" (never $0), per
// the run-log contract. The unit drives the formatting.
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

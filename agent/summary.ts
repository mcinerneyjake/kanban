import { type RunUsage } from './usage.js';
import { type CostConfig } from './costConfig.js';
import { type CostLine, EnergyCostModel, HardwareCostModel } from './cost.js';
import { economicsLines, type RunOutcome } from './economics.js';
import { cacheablePrefix, cacheableLines } from './cacheable.js';

// Assembles every CostLine for a run (energy, hardware, cacheable, economics)
// plus the measured inputs, and groups them Measured / Assumed / Externalities
// with a curated headline. Pure + testable; the CLI just prints renderSummary().

export interface SummaryInput {
  usage: RunUsage;            // combined chat + embedder usage
  outcome: RunOutcome;
  reviewMs: number;
  cfg: CostConfig;
  model: string;
  prefixText: string;         // stable prefix (system prompt + tool defs)
  dynamicText: string;        // dynamic tail (the report)
}

export interface RunSummary {
  measured: CostLine[];
  assumed: CostLine[];
  externalities: CostLine[];
  headline: CostLine[];
}

// The curated highlight lines — shown separately, and excluded from `assumed`
// so they aren't listed twice.
const HEADLINE = ['cost per accepted ticket', 'net savings', 'local vs cloud (saved)'];

function measuredInputs(usage: RunUsage): CostLine[] {
  const tok = (label: string, n: number): CostLine =>
    usage.reportedCalls > 0
      ? { label, amount: n, unit: 'tokens', kind: 'measured' }
      : { label, amount: null, unit: 'tokens', kind: 'measured', note: 'usage unavailable' };
  return [
    { label: 'active compute', amount: usage.activeMs, unit: 'ms', kind: 'measured' },
    tok('prompt tokens', usage.promptTokens),
    tok('completion tokens', usage.completionTokens),
    tok('total tokens', usage.totalTokens),
  ];
}

export function buildSummary(input: SummaryInput): RunSummary {
  const { usage, outcome, reviewMs, cfg, model, prefixText, dynamicText } = input;
  const energy = new EnergyCostModel(cfg).lines(usage);
  const hardware = new HardwareCostModel(cfg).lines(usage);
  // Economics sums the local $ lines itself (sumUsd ignores non-USD), so passing
  // the full energy + hardware sets is safe — no double counting in display.
  const econ = economicsLines({ usage, outcome, localCostLines: [...energy, ...hardware], reviewMs, cfg, model });
  const cacheable = cacheableLines(cacheablePrefix(prefixText, dynamicText), usage);

  const all = [...measuredInputs(usage), ...energy, ...hardware, ...cacheable, ...econ];
  const headline = HEADLINE
    .map((label) => all.find((l) => l.label === label))
    .filter((l): l is CostLine => l !== undefined);

  return {
    measured: all.filter((l) => l.kind === 'measured'),
    assumed: all.filter((l) => l.kind === 'assumed' && !HEADLINE.includes(l.label)),
    externalities: all.filter((l) => l.kind === 'externality'),
    headline,
  };
}

function fmtLine(l: CostLine): string {
  const amt = l.amount === null ? 'notional' : `${l.amount}`;
  return `  ${l.label.padEnd(28)} ${amt.padStart(16)} ${l.unit}${l.note ? `   (${l.note})` : ''}`;
}

export function renderSummary(s: RunSummary): string {
  const section = (title: string, lines: CostLine[]): string => `${title}\n${lines.map(fmtLine).join('\n')}`;
  return [
    section('— Measured —', s.measured),
    section('— Assumed ($) —', s.assumed),
    section('— Externalities (report-only) —', s.externalities),
    section('— Headline —', s.headline),
  ].join('\n\n');
}

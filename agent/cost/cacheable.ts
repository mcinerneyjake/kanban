import { type RunUsage } from './usage.js';
import { type CostLine } from './cost.js';

// From-scratch PROXY for cacheable-prefix share, independent of runtime prompt caching (real cached-token hits are surfaced too when reported).

// Rough estimate — ~4 chars/token, no tokenizer; labeled an estimate wherever it surfaces.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface PrefixSplit {
  prefixTokens: number;
  dynamicTokens: number;
  totalTokens: number;
  /** Cacheable share of the request, 0..1. */
  fraction: number;
}

export function cacheablePrefix(prefixText: string, dynamicText: string): PrefixSplit {
  const prefixTokens = estimateTokens(prefixText);
  const dynamicTokens = estimateTokens(dynamicText);
  const totalTokens = prefixTokens + dynamicTokens;
  const fraction = totalTokens === 0 ? 0 : prefixTokens / totalTokens;
  return { prefixTokens, dynamicTokens, totalTokens, fraction };
}

export function cacheableLines(split: PrefixSplit, usage: RunUsage): CostLine[] {
  const lines: CostLine[] = [
    {
      label: 'cacheable prefix',
      amount: Math.round(split.fraction * 1000) / 10,
      unit: '%',
      kind: 'measured',
      note: 'estimate (~4 chars/token)',
    },
  ];
  if (usage.cachedReported) {
    lines.push({ label: 'cached tokens (runtime)', amount: usage.cachedTokens, unit: 'tokens', kind: 'measured' });
  }
  return lines;
}

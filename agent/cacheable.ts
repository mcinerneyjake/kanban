import { type RunUsage } from './usage.js';
import { type CostLine } from './cost.js';

// How much of each request is a STABLE, cacheable prefix (the system prompt +
// tool definitions, identical across a run's calls) vs the dynamic tail (user
// input, tool results). This is a from-scratch PROXY that proves the concept
// regardless of whether the runtime supports prompt caching. When the runtime
// *does* report real cached-token hits, we surface those too (see cacheableLines).
//
// Note: Anthropic's cache billing (1.25x write / 0.1x read) is explanatory only;
// it is not reproduced here.

// Rough token estimate — no tokenizer dependency. ~4 chars/token is the common
// heuristic; this is an ESTIMATE, labeled as such wherever it surfaces.
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

// Summary lines: the from-scratch % cacheable (estimate, always shown) and — only
// when the runtime actually reported it — the real cached-token hit count.
export function cacheableLines(split: PrefixSplit, usage: RunUsage): CostLine[] {
  const lines: CostLine[] = [
    {
      label: 'cacheable prefix',
      amount: Math.round(split.fraction * 1000) / 10, // one-decimal percentage
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

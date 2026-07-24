// The shared eval runner. One place enforces the discipline every eval needs: prove the instruments
// BEFORE scoring, then run every case, then summarize — so a broken instrument fails loud instead of
// reporting a plausible-but-false score (the `feedback_validate_probe_with_controls` failure mode,
// mirrored on scripts/probe/repo-stats.mjs). The generic seam is why tkt-799588d9b162's future
// LLM-as-judge eval reuses THIS rather than building a second harness: it supplies its own case type,
// scorer, and summarizer; the assert-first ordering and report shape stay shared.

export interface EvalReport<R> {
  name: string;
  results: R[];
  metrics: Record<string, number>;
  lines: string[];
}

export interface EvalSpec<C, R> {
  name: string;
  cases: C[];
  // Throws (loud) if the instrument itself is untrustworthy — empty corpus, runtime down, a control
  // that must hold but doesn't. Runs to completion BEFORE any case is scored; a throw here aborts the
  // whole eval rather than letting it emit a number.
  assertInstruments: () => Promise<void>;
  scoreCase: (c: C) => Promise<R>;
  summarize: (results: R[]) => { metrics: Record<string, number>; lines: string[] };
}

export async function runEval<C, R>(spec: EvalSpec<C, R>): Promise<EvalReport<R>> {
  await spec.assertInstruments(); // controls first — a false instrument never reaches a score
  const results: R[] = [];
  for (const c of spec.cases) {
    results.push(await spec.scoreCase(c));
  }
  const { metrics, lines } = spec.summarize(results);
  return { name: spec.name, results, metrics, lines };
}

// Render a report as plain text for the CLI. Metrics are printed in insertion order.
export function formatReport<R>(report: EvalReport<R>): string {
  const head = `\n=== ${report.name} (${report.results.length} cases) ===`;
  const metricLines = Object.entries(report.metrics).map(([k, v]) => `  ${k}: ${v.toFixed(3)}`);
  return [head, ...report.lines, '', ...metricLines].join('\n');
}

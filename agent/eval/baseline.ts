// Baseline record + comparison for the retrieval eval (tkt-07fab923fcbd).
//
// The comparison is REPORTING, never a gate: drift prints and the process still exits 0. That is
// deliberate and is the ticket's requirement — a recall number moving is a prompt to look, not a
// build failure, and wiring it as a blocking check would make every embedding-model experiment red.
// The loud/fatal half lives upstream in assertRetrievalInstruments: an instrument that cannot be
// trusted aborts before a metric is ever computed. Those two must not be confused — this file is
// allowed to say "no comparison available"; that file is not.

import { createHash } from 'node:crypto';
import type { GoldenSet } from './golden.js';

export interface BaselineMetrics {
  recallAt1: number;
  recallAt5: number;
  mrr: number;
}

// Provenance rides WITH the numbers. A recall figure is only comparable to another figure measured
// over the same corpus with the same embedder — a model or prefix swap changes every vector, so the
// delta across one is not a regression, it is a different experiment. Recording these fields is what
// lets `compareToBaseline` refuse rather than print a meaningless delta.
export interface Baseline {
  recordedAt: string;
  corpus: string;
  corpusSize: number;
  // Content hashes, not just the count: a corpus can be edited or a pair added or reworded without
  // the size moving, and that reads as ordinary drift over an unchanged experiment — the failure a
  // count alone cannot see. Both cover exactly the inputs that change a score.
  corpusHash: string;
  goldenSetHash: string;
  searchDepth: number;
  embedModel: string;
  // Two runtimes can advertise one model id and still return different vectors (different
  // quantization, a different build), so the endpoint is part of the experiment's identity.
  embedBaseUrl: string;
  queryInstruction: string;
  docInstruction: string;
  metrics: BaselineMetrics;
}

/** The measurement side of a comparison — the same provenance fields, freshly observed. */
export type Measurement = Omit<Baseline, 'recordedAt'>;

// Float noise from a re-embed of identical text is ~1e-12; a real recall move over 12 pairs is at
// least 1/12. Anything under this is reported as unchanged rather than as drift.
const EPSILON = 5e-4;

export interface Comparison {
  /** False when no baseline exists, or when provenance differs so a delta would be meaningless. */
  comparable: boolean;
  /** Provenance fields that differ, empty when they all match. */
  mismatches: string[];
  /** Metrics whose absolute change exceeds EPSILON. Empty when comparable and steady. */
  drifted: string[];
  lines: string[];
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`baseline.json: "${k}" must be a string, got ${typeof v}`);
  return v;
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`baseline.json: "${k}" must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`baseline.json: ${what} must be an object`);
  }
  return { ...v };
}

// Parses and VALIDATES, rather than asserting a shape onto whatever was on disk. A baseline is an
// instrument: a corrupt one that reads as a Baseline would silently compare today's run against
// undefined and report a delta of NaN, which prints as plausibly as a real number. Missing file is
// the caller's business (a legitimate "none recorded yet"); malformed content is fatal here.
export function parseBaseline(raw: string): Baseline {
  const o = obj(JSON.parse(raw), 'the document');
  const m = obj(o.metrics, '"metrics"');
  return {
    recordedAt: str(o, 'recordedAt'),
    corpus: str(o, 'corpus'),
    corpusSize: num(o, 'corpusSize'),
    corpusHash: str(o, 'corpusHash'),
    goldenSetHash: str(o, 'goldenSetHash'),
    searchDepth: num(o, 'searchDepth'),
    embedModel: str(o, 'embedModel'),
    embedBaseUrl: str(o, 'embedBaseUrl'),
    queryInstruction: str(o, 'queryInstruction'),
    docInstruction: str(o, 'docInstruction'),
    metrics: {
      recallAt1: num(m, 'recallAt1'),
      recallAt5: num(m, 'recallAt5'),
      mrr: num(m, 'mrr'),
    },
  };
}

// Identity of the golden set — every field that changes what is being asked. Rewording a query,
// re-pointing an anchor, or moving a control threshold all change the experiment, and none of them
// changes the pair COUNT, so a length check would not see any of it.
export function hashGoldenSet(set: GoldenSet): string {
  const canonical = JSON.stringify({
    pairs: [...set.pairs]
      .map((p) => [p.query, p.expectedId])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    positive: [set.positive.query, set.positive.expectedId],
    negative: [set.negative.query, set.negative.maxTopScore],
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Metrics arrive from the harness as Record<string, number>, so a renamed or dropped key reads as
// `undefined` and — with noUncheckedIndexedAccess off — type-checks all the way into a recorded
// baseline. Validate at the seam instead of trusting the shape.
export function readMetrics(metrics: Record<string, number>): BaselineMetrics {
  const pick = (k: keyof BaselineMetrics): number => {
    const v: number | undefined = metrics[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`retrieval-eval: the report is missing a finite "${k}" metric (got ${JSON.stringify(v)}) — refusing to record or compare a baseline with a dropped metric.`);
    }
    return v;
  };
  return { recallAt1: pick('recallAt1'), recallAt5: pick('recallAt5'), mrr: pick('mrr') };
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function delta(now: number, was: number): string {
  const d = now - was;
  if (Math.abs(d) <= EPSILON) return '  (unchanged)';
  return `  (${d > 0 ? '+' : ''}${d.toFixed(3)})`;
}

// Pure: takes both sides and returns what to print. Kept free of I/O and of process.exit so the
// decision table is asserted directly instead of being inferred from a CLI's output.
export function compareToBaseline(baseline: Baseline | null, current: Measurement): Comparison {
  if (!baseline) {
    return {
      comparable: false,
      mismatches: [],
      drifted: [],
      lines: [
        'No baseline recorded for this corpus yet.',
        'Re-run with --record to write one from this run.',
      ],
    };
  }

  const fields: [string, string | number, string | number][] = [
    ['corpus', current.corpus, baseline.corpus],
    ['corpusSize', current.corpusSize, baseline.corpusSize],
    ['corpusHash', current.corpusHash, baseline.corpusHash],
    ['goldenSetHash', current.goldenSetHash, baseline.goldenSetHash],
    ['searchDepth', current.searchDepth, baseline.searchDepth],
    ['embedModel', current.embedModel, baseline.embedModel],
    ['embedBaseUrl', current.embedBaseUrl, baseline.embedBaseUrl],
    ['queryInstruction', current.queryInstruction, baseline.queryInstruction],
    ['docInstruction', current.docInstruction, baseline.docInstruction],
  ];
  const mismatches = fields
    .filter(([, now, was]) => now !== was)
    .map(([name, now, was]) => `${name}: now ${JSON.stringify(now)}, baseline ${JSON.stringify(was)}`);

  const names: (keyof BaselineMetrics)[] = ['recallAt1', 'recallAt5', 'mrr'];

  if (mismatches.length > 0) {
    return {
      comparable: false,
      mismatches,
      drifted: [],
      lines: [
        `Baseline recorded ${baseline.recordedAt}, but it measured something else — NOT comparable:`,
        ...mismatches.map((m) => `  ! ${m}`),
        'A delta across a changed corpus or embedder is a different experiment, not a regression.',
        'Re-record the baseline (--record) once the new configuration is the intended one.',
        ...names.map((n) => `  ${n}: ${fmt(current.metrics[n])}  (baseline ${fmt(baseline.metrics[n])}, not compared)`),
      ],
    };
  }

  const drifted = names.filter((n) => Math.abs(current.metrics[n] - baseline.metrics[n]) > EPSILON);
  return {
    comparable: true,
    mismatches: [],
    drifted,
    lines: [
      `Compared against the baseline recorded ${baseline.recordedAt}:`,
      ...names.map((n) => `  ${n}: ${fmt(current.metrics[n])}${delta(current.metrics[n], baseline.metrics[n])}`),
      drifted.length === 0
        ? 'No drift.'
        : `Drift in ${drifted.join(', ')} — reported, NOT a failure. Look before re-recording.`,
    ],
  };
}

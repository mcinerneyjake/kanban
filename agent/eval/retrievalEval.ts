import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeEmbedder, type DocumentIndex } from '../retrieval/retrieval.js';
import { buildBoardIndex } from '../retrieval/indexCache.js';
import { runEval, formatReport, type EvalReport } from './harness.js';
import { aggregate, rankOf } from './metrics.js';
import {
  GOLDEN_PAIRS, POSITIVE_CONTROL, NEGATIVE_CONTROL, type GoldenPair,
} from './golden.js';

// The retrieval eval: measures recall@1 / recall@5 / MRR of the board index over the golden set, and
// proves its own instruments first (non-empty corpus, positive control ranks top-1, negative control
// stays weak) so a broken embedder fails LOUD instead of reporting a false score. Reuses the shared
// runEval + the live DocumentIndex — no retrieval logic is reimplemented here.

// Search depth: deep enough that recall@5 and a meaningful MRR are exact. A true rank beyond this
// counts as a miss (MRR is a lower bound past depth) — stated in the summary so the number is honest.
const SEARCH_DEPTH = 10;

export interface CaseResult {
  query: string;
  expectedId: string;
  rankedIds: string[];
  rank: number | null;
  topScore: number;
}

async function scoreCase(index: DocumentIndex, pair: GoldenPair): Promise<CaseResult> {
  const hits = await index.search(pair.query, SEARCH_DEPTH);
  const rankedIds = hits.map((h) => h.id);
  return {
    query: pair.query,
    expectedId: pair.expectedId,
    rankedIds,
    rank: rankOf(rankedIds, pair.expectedId),
    topScore: hits.length ? hits[0].score : 0,
  };
}

// Loud instrument gate — runs BEFORE any metric is computed (via runEval). Any throw here aborts the
// eval rather than letting it emit a plausible-but-false recall number.
// `pairs` is REQUIRED, with no default: a default of `[]` would let a one-argument call check no
// anchors at all and still report the instruments sound — the permissive answer to "can't check".
export async function assertRetrievalInstruments(index: DocumentIndex, pairs: readonly GoldenPair[]): Promise<void> {
  if (index.size === 0) {
    throw new Error('retrieval-eval: the board index is EMPTY — nothing to search. Is the board readable / the embedder up? Refusing to report recall over an empty corpus.');
  }
  // Anchor presence, before any embedding call: a deleted ticket is not in the corpus, so its pair is
  // unrankable and scores as an ordinary miss — indistinguishable in the report from genuinely poor
  // retrieval, and it caps recall for a board reason rather than a retrieval one (tkt-0a076c4d3084).
  // POSITIVE_CONTROL is checked here too: if its ticket is deleted the control fails below with
  // "the embedder is broken", which is the exact misdiagnosis this gate exists to remove.
  const indexed = index.documentIds;
  const anchors = new Set([...pairs.map((p) => p.expectedId), POSITIVE_CONTROL.expectedId]);
  const missing = [...anchors].filter((id) => !indexed.has(id));
  if (missing.length > 0) {
    throw new Error(`retrieval-eval: ${missing.length} golden anchor(s) ABSENT from the corpus — ${missing.join(', ')}. Those pairs can never rank, so recall would be capped by the board, not measured. Check the board FIRST: a ticket whose file failed to parse is dropped into listBoard's \`unreadable\` and is absent here too, so this can mean a corrupt file rather than a deleted ticket. Only once the ticket is really gone, fix the PAIR in agent/eval/golden.ts — never tune the query to force a hit.`);
  }
  // Positive control: a near-verbatim title MUST land top-1, or the embedder is miswired.
  const pos = await scoreCase(index, POSITIVE_CONTROL);
  if (pos.rank !== 1) {
    throw new Error(`retrieval-eval: POSITIVE control failed — "${POSITIVE_CONTROL.expectedId}" ranked ${pos.rank ?? 'absent'} (expected 1) for a near-verbatim title query. The index/embedder is broken; the recall numbers would be noise.`);
  }
  // Negative control: a query with no answer must NOT produce a confident hit.
  const neg = await index.search(NEGATIVE_CONTROL.query, 1);
  const negTop = neg.length ? neg[0].score : 0;
  if (negTop >= NEGATIVE_CONTROL.maxTopScore) {
    throw new Error(`retrieval-eval: NEGATIVE control failed — a no-answer query scored ${negTop.toFixed(3)} (>= ${NEGATIVE_CONTROL.maxTopScore}). The index is asserting a confident answer that does not exist; recall@1 cannot be trusted.`);
  }
}

function summarize(results: CaseResult[]): { metrics: Record<string, number>; lines: string[] } {
  const m = aggregate(results);
  const lines = results.map((r) => {
    const mark = r.rank === 1 ? 'top-1' : r.rank !== null && r.rank <= 5 ? `@${r.rank}` : r.rank !== null ? `@${r.rank}` : 'MISS';
    return `  [${mark.padStart(5)}] ${r.expectedId}  score=${r.topScore.toFixed(3)}  "${r.query.slice(0, 56)}"`;
  });
  return {
    metrics: { recallAt1: m.recallAt1, recallAt5: m.recallAt5, mrr: m.mrr },
    lines,
  };
}

// Build the eval report over a given index (injected so tests drive it with a stub embedder + a small
// board, and the CLI drives it with the live board).
export function evaluateRetrieval(index: DocumentIndex, pairs: readonly GoldenPair[] = GOLDEN_PAIRS): Promise<EvalReport<CaseResult>> {
  return runEval<GoldenPair, CaseResult>({
    name: 'retrieval golden set',
    cases: [...pairs],
    assertInstruments: () => assertRetrievalInstruments(index, pairs),
    scoreCase: (pair) => scoreCase(index, pair),
    summarize,
  });
}

// CLI entry — only when invoked directly (`npm run eval:retrieval`). Builds the live board index and
// prints the report; an instrument failure throws here and exits non-zero (loud, not a false score).
async function main(): Promise<void> {
  try { process.loadEnvFile('.env'); } catch { /* defaults */ }
  process.stdout.write('Building the board index…\n');
  const index = await buildBoardIndex(RuntimeEmbedder.fromEnv());
  process.stdout.write(`Indexed ${index.size} vectors. Running retrieval eval (search depth ${SEARCH_DEPTH})…\n`);
  const report = await evaluateRetrieval(index);
  process.stdout.write(`${formatReport(report)}\n`);
  const missed = report.results.filter((r) => r.rank === null).length;
  process.stdout.write(`\n${report.results.length - missed}/${report.results.length} found within depth ${SEARCH_DEPTH}.\n`);
}

// Run only when invoked directly (not when a test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`\nretrieval eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

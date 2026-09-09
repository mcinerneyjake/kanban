import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeEmbedder, type DocumentIndex } from '../retrieval/retrieval.js';
import { buildCliIndex } from '../retrieval/indexCache.js';
import { resolveEmbedConfig } from '../retrieval/models.js';
import { runEval, formatReport, type EvalReport } from './harness.js';
import { aggregate, rankOf } from './metrics.js';
import {
  BOARD_GOLDEN_SET, type GoldenPair, type GoldenSet, type NegativeControl,
} from './golden.js';
import { FIXTURE_GOLDEN_SET, FIXTURE_CORPUS_DIR, FIXTURE_CACHE_PATH } from './fixtures/goldenFixture.js';
import {
  compareToBaseline, parseBaseline, hashGoldenSet, readMetrics,
  type Baseline, type Measurement,
} from './baseline.js';

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

/** The two controls, carried together — see GoldenSet for why they travel with their corpus. */
export interface Controls {
  positive: GoldenPair;
  negative: NegativeControl;
}

// Loud instrument gate — runs BEFORE any metric is computed (via runEval). Any throw here aborts the
// eval rather than letting it emit a plausible-but-false recall number.
// `pairs` is REQUIRED, with no default: a default of `[]` would let a one-argument call check no
// anchors at all and still report the instruments sound — the permissive answer to "can't check".
// `controls` is required for the same reason AND a second one: a control is corpus-specific, so a
// default set would silently check the live board's anchors against the fixture corpus and fail for
// a wiring reason while reporting an embedder fault (tkt-07fab923fcbd).
export async function assertRetrievalInstruments(
  index: DocumentIndex,
  pairs: readonly GoldenPair[],
  controls: Controls,
): Promise<void> {
  const { positive, negative } = controls;
  if (index.size === 0) {
    throw new Error('retrieval-eval: the board index is EMPTY — nothing to search. Is the board readable / the embedder up? Refusing to report recall over an empty corpus.');
  }
  // Anchor presence, before any embedding call: a deleted ticket is not in the corpus, so its pair is
  // unrankable and scores as an ordinary miss — indistinguishable in the report from genuinely poor
  // retrieval, and it caps recall for a board reason rather than a retrieval one (tkt-0a076c4d3084).
  // The positive control is checked here too: if its ticket is deleted the control fails below with
  // "the embedder is broken", which is the exact misdiagnosis this gate exists to remove.
  const indexed = index.documentIds;
  const anchors = new Set([...pairs.map((p) => p.expectedId), positive.expectedId]);
  const missing = [...anchors].filter((id) => !indexed.has(id));
  if (missing.length > 0) {
    throw new Error(`retrieval-eval: ${missing.length} golden anchor(s) ABSENT from the corpus — ${missing.join(', ')}. Those pairs can never rank, so recall would be capped by the board, not measured. Check the board FIRST: a ticket whose file failed to parse is dropped into listBoard's \`unreadable\` and is absent here too, so this can mean a corrupt file rather than a deleted ticket. Only once the ticket is really gone, fix the PAIR in this corpus's golden set (agent/eval/golden.ts for the live board, agent/eval/fixtures/goldenFixture.ts for the fixture corpus) — never tune the query to force a hit.`);
  }
  // Positive control: a near-verbatim title MUST land top-1, or the embedder is miswired.
  const pos = await scoreCase(index, positive);
  if (pos.rank !== 1) {
    throw new Error(`retrieval-eval: POSITIVE control failed — "${positive.expectedId}" ranked ${pos.rank ?? 'absent'} (expected 1) for a near-verbatim title query. The index/embedder is broken; the recall numbers would be noise.`);
  }
  // Negative control: a query with no answer must NOT produce a confident hit.
  const neg = await index.search(negative.query, 1);
  const negTop = neg.length ? neg[0].score : 0;
  if (negTop >= negative.maxTopScore) {
    throw new Error(`retrieval-eval: NEGATIVE control failed — a no-answer query scored ${negTop.toFixed(3)} (>= ${negative.maxTopScore}). The index is asserting a confident answer that does not exist; recall@1 cannot be trusted.`);
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
// board, and the CLI drives it with the live board or the committed fixture corpus).
// Takes the whole GoldenSet rather than loose pairs: the set carries the controls the instrument gate
// needs, so there is no call shape that scores one corpus against another's controls.
export function evaluateRetrieval(index: DocumentIndex, set: GoldenSet): Promise<EvalReport<CaseResult>> {
  return runEval<GoldenPair, CaseResult>({
    name: `retrieval golden set — ${set.name}`,
    cases: [...set.pairs],
    assertInstruments: () => assertRetrievalInstruments(index, set.pairs, set),
    scoreCase: (pair) => scoreCase(index, pair),
    summarize,
  });
}

export const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'baseline.json',
);

// Points a fixture run at the committed corpus AND at that corpus's own embedding cache. Both are
// unconditional assignments, not defaults: an ambient EMBED_CACHE_PATH (set in .env, or exported by
// a shell) would otherwise send this run's PRUNE at the board's cache, deleting every board vector
// in this embedder's namespace to leave only the 61 fixture ones. Reading the env here rather than
// letting defaultCachePath() resolve it is the whole guard, so it is exported and asserted directly.
export function applyFixtureEnv(env: NodeJS.ProcessEnv): void {
  env.TICKETS_DIR_OVERRIDE = FIXTURE_CORPUS_DIR;
  env.EMBED_CACHE_PATH = FIXTURE_CACHE_PATH;
}

// Three outcomes, deliberately distinct. Only a MISSING file is "nothing recorded yet"; a file that
// cannot be read (EACCES, EISDIR, EIO) or cannot be parsed is a broken instrument, and folding either
// into `none` would report a clean first run over a baseline nobody could read — then offer to
// overwrite it. Matching on `code === 'ENOENT'` rather than catching everything is the whole point.
type BaselineLoad =
  | { kind: 'none' }
  | { kind: 'ok'; baseline: Baseline }
  | { kind: 'unreadable'; reason: string };

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

async function loadBaseline(): Promise<BaselineLoad> {
  let raw: string;
  try {
    raw = await fs.readFile(BASELINE_PATH, 'utf8');
  } catch (err) {
    if (isMissing(err)) return { kind: 'none' };
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { kind: 'ok', baseline: parseBaseline(raw) };
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

// Hash of the corpus CONTENT, so an edited ticket body invalidates the comparison even though the
// file count is unchanged. Sorted by filename so the digest does not depend on readdir order.
async function hashCorpusDir(dir: string): Promise<string> {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  const h = createHash('sha256');
  for (const name of names) {
    h.update(name);
    h.update(await fs.readFile(path.join(dir, name)));
  }
  return h.digest('hex').slice(0, 16);
}

// Temp + rename, matching EmbeddingStore.persist(): baseline.json is a TRACKED file, so a crash or a
// full disk partway through a plain write would leave a truncated baseline in the working tree —
// which parseBaseline then rejects, taking out the comparison until someone notices.
async function writeBaseline(next: Baseline): Promise<void> {
  const tmp = `${BASELINE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, BASELINE_PATH);
}

// CLI entry — only when invoked directly (`npm run eval:retrieval`). An instrument failure throws
// here and exits non-zero (loud, not a false score); a baseline DRIFT does not — see baseline.ts.
//
//   npm run eval:retrieval              measure the live board (real, but not reproducible)
//   npm run eval:retrieval -- --fixture measure the committed corpus and compare to the baseline
//   npm run eval:retrieval -- --fixture --record   ... and rewrite the baseline from this run
async function main(): Promise<void> {
  try { process.loadEnvFile('.env'); } catch { /* defaults */ }

  const argv = process.argv.slice(2);
  const fixture = argv.includes('--fixture');
  const record = argv.includes('--record');
  if (record && !fixture) {
    throw new Error('--record only applies to --fixture: the live board changes under every run, so a baseline recorded from it could never be compared against.');
  }
  const unknown = argv.filter((a) => a !== '--fixture' && a !== '--record');
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(', ')}. Expected --fixture and/or --record.`);
  }

  const set = fixture ? FIXTURE_GOLDEN_SET : BOARD_GOLDEN_SET;
  if (fixture) applyFixtureEnv(process.env);

  process.stdout.write(`Building the ${set.name} index…\n`);
  // buildCliIndex, NOT buildBoardIndex: the latter is the uncached building block, so the eval used
  // to re-embed the entire corpus on every run. This routes through the persistent EmbeddingStore,
  // making a second run re-embed only what changed (tkt-07fab923fcbd).
  const index = await buildCliIndex(RuntimeEmbedder.fromEnv());
  process.stdout.write(`Indexed ${index.size} vectors. Running retrieval eval (search depth ${SEARCH_DEPTH})…\n`);
  const report = await evaluateRetrieval(index, set);
  process.stdout.write(`${formatReport(report)}\n`);
  const missed = report.results.filter((r) => r.rank === null).length;
  process.stdout.write(`\n${report.results.length - missed}/${report.results.length} found within depth ${SEARCH_DEPTH}.\n`);

  if (!fixture) {
    process.stdout.write('\nLive board — not compared to a baseline: the corpus is gitignored and changes\nunder every run, so two scores measure different things. Use --fixture for a\nreproducible number.\n');
    return;
  }

  const cfg = resolveEmbedConfig();
  const current: Measurement = {
    corpus: set.name,
    corpusSize: index.size,
    corpusHash: await hashCorpusDir(FIXTURE_CORPUS_DIR),
    goldenSetHash: hashGoldenSet(set),
    searchDepth: SEARCH_DEPTH,
    embedModel: cfg.model,
    embedBaseUrl: cfg.baseUrl,
    queryInstruction: cfg.queryInstruction,
    docInstruction: cfg.docInstruction,
    metrics: readMetrics(report.metrics),
  };

  const loaded = await loadBaseline();

  // An unreadable baseline is fatal EXCEPT under --record, which is its documented repair path. If
  // reading it were fatal unconditionally, the one command that fixes a corrupt baseline could never
  // run — the file would have to be deleted by hand first, which nothing says.
  if (loaded.kind === 'unreadable') {
    const detail = `existing baseline at ${BASELINE_PATH} could not be read: ${loaded.reason}`;
    if (!record) {
      throw new Error(`${detail}. This is NOT "no baseline recorded" — refusing to report an uncompared run over a file that exists. Re-run with --record to replace it, or restore the file.`);
    }
    process.stdout.write(`\n! ${detail}\n! --record given, so it is being replaced from this run.\n`);
  }

  if (loaded.kind !== 'unreadable') {
    const comparison = compareToBaseline(loaded.kind === 'ok' ? loaded.baseline : null, current);
    process.stdout.write(`\n${comparison.lines.join('\n')}\n`);
  }

  if (record) {
    await writeBaseline({ recordedAt: new Date().toISOString(), ...current });
    process.stdout.write(`\nBaseline written to ${BASELINE_PATH}\n`);
  }
}

// Run only when invoked directly (not when a test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`\nretrieval eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

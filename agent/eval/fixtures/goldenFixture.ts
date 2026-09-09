import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoldenSet } from '../golden.js';

// The golden set for the COMMITTED fixture corpus (./corpus/*.md) — the reproducible half of the
// retrieval eval. The live-board set in ../golden.ts measures the real board but can never yield a
// comparable baseline: that corpus is gitignored, private, and different on every run.
//
// Every anchor below has three deliberate near-miss distractors in the corpus that share its
// vocabulary and subject while answering a DIFFERENT question ("retry failed webhooks" vs "log
// webhook failures" vs "verify webhook signatures"). That is the whole design: recall sensitivity
// comes from distractor quality, not corpus size. The 2026-07-24 board baseline recorded
// recall@5 = 1.000 over 509 vectors — saturated, and therefore unable to show a regression. A
// corpus whose hardest competitors are present by construction has headroom in both directions.
//
// Queries are worded as a user would report the symptom, never as the ticket's title, so this
// measures semantic recall rather than lexical echo. Misses are the finding, not a bug to hand-fix:
// if a pair looks wrong, fix the PAIR or the CORPUS — never tune the query to force a hit.

// Absolute, so the corpus resolves the same from any cwd (the CLI runs from the repo root, vitest
// from wherever it was invoked). getTicketsDir() reads TICKETS_DIR_OVERRIDE, which is what points
// the board read here.
export const FIXTURE_CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus');

// The fixture run's OWN embedding cache, named explicitly rather than left to defaultCachePath().
// Building through buildCliIndex PRUNES the store to the corpus just embedded, so a run that
// inherited an ambient EMBED_CACHE_PATH pointing at the board cache would delete every board vector
// in this embedder's namespace — the same destruction test-support/vitest.setup.ts pins away from
// the suites. `.cache/` is gitignored at any depth, so this is never committed.
export const FIXTURE_CACHE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '.cache', 'embeddings.json',
);

export const FIXTURE_GOLDEN_SET: GoldenSet = {
  name: 'fixture corpus',
  pairs: [
    { query: 'webhooks that fail should be tried again later with increasing delays', expectedId: 'tkt-fx-webhook-retry-backoff' },
    { query: 'the search endpoint returns everything at once and needs page-by-page fetching', expectedId: 'tkt-fx-search-cursor-pagination' },
    { query: 'swap the database password while the service keeps serving traffic', expectedId: 'tkt-fx-db-credential-rotation' },
    { query: 'every keystroke sends a save request and hammers the backend', expectedId: 'tkt-fx-autosave-debounce' },
    { query: 'the same error fires hundreds of identical notifications', expectedId: 'tkt-fx-alert-deduplication' },
    { query: 'exporting a big report runs the process out of memory', expectedId: 'tkt-fx-csv-streaming-export' },
    { query: 'dates are stored in mixed local zones so comparisons come out wrong', expectedId: 'tkt-fx-utc-timestamp-migration' },
    { query: 'a double-clicked checkout button charges the customer twice', expectedId: 'tkt-fx-payment-idempotency-key' },
    { query: 'the dashboard shows nothing for seconds because the javascript bundle is huge', expectedId: 'tkt-fx-chart-bundle-lazy-load' },
    { query: 'log people out automatically when they walk away from their desk', expectedId: 'tkt-fx-idle-session-expiry' },
    { query: 'older uploads have no preview image and need one generated after the fact', expectedId: 'tkt-fx-thumbnail-backfill' },
    { query: 'two tasks each waiting on the other hang the scheduler forever', expectedId: 'tkt-fx-dependency-cycle-detection' },
  ],

  // Near-verbatim title of a corpus ticket. It MUST rank top-1: if it does not, the embedder is
  // miswired (wrong model or prefix) and every metric is noise.
  positive: {
    query: 'Detect and break circular dependencies in the task graph',
    expectedId: 'tkt-fx-dependency-cycle-detection',
  },

  // A query with no answer in this corpus — nothing here touches Bluetooth or mobile pairing. A
  // healthy index must return only weak matches: the top score must stay BELOW maxTopScore.
  //
  // Threshold MEASURED, not guessed (2026-09-09, 61-vector corpus, qwen3-embedding-0.6b). Three
  // independent no-answer queries topped out at 0.376 / 0.350 / 0.265, while the weakest TRUE golden
  // match scored 0.469. 0.42 sits in that ~0.093-wide gap. The first pass guessed 0.50, which is
  // ABOVE the weakest real match — it would have waved through a false hit scoring better than a
  // genuine one, which is the exact failure this control exists to catch. Re-derive it whenever the
  // corpus or the embedding model changes; the numbers above are only true for that pair.
  negative: {
    query: 'the bluetooth pairing dialog crashes on android tablets',
    maxTopScore: 0.42,
  },
};

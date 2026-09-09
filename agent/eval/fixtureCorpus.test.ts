import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listBoard } from '../../server/tickets.js';
import { FIXTURE_GOLDEN_SET, FIXTURE_CORPUS_DIR, FIXTURE_CACHE_PATH } from './fixtures/goldenFixture.js';
import { applyFixtureEnv } from './retrievalEval.js';

// The half of the retrieval eval that CI can actually check. Scoring recall needs an embedding
// runtime, which CI has not got — but the defect this suite pins needs no embedder at all: a corpus
// that does not survive a checkout makes the eval unrunnable there before any model is contacted
// (tkt-07fab923fcbd). `.gitignore:12` is `tickets/` with no leading slash, so it matches a directory
// of that name at ANY depth; a fixture corpus placed under one is silently uncommitted, present for
// the author and absent for everyone else. These read the corpus through the real listBoard() path
// rather than a directory walk, so a file that git keeps but the parser drops still fails.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let saved: string | undefined;
beforeAll(() => {
  saved = process.env.TICKETS_DIR_OVERRIDE;
  process.env.TICKETS_DIR_OVERRIDE = FIXTURE_CORPUS_DIR;
});
afterAll(() => {
  if (saved === undefined) delete process.env.TICKETS_DIR_OVERRIDE;
  else process.env.TICKETS_DIR_OVERRIDE = saved;
});

// Files git will hand a fresh checkout. Throws rather than returning [] on any failure: an empty
// list is exactly what a gitignored corpus produces, so "could not ask git" must never be
// indistinguishable from "git has nothing" — that is the permissive answer to a question this
// suite exists to ask.
function trackedCorpusFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'agent/eval/fixtures/corpus'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const files = out.split('\n').filter((l) => l.endsWith('.md'));
  if (files.length === 0) {
    throw new Error('git ls-files returned no .md files under agent/eval/fixtures/corpus — the fixture corpus is untracked (gitignored, or never added). A CI checkout would see an empty board.');
  }
  return files;
}

describe('fixture corpus survives a checkout', () => {
  it('is tracked by git, so a fresh clone gets the corpus', () => {
    expect(trackedCorpusFiles().length).toBeGreaterThan(0);
  });

  it('is not swallowed by a gitignore rule', () => {
    // Direct control on the mechanism, independent of the ls-files check above: check-ignore exits 0
    // when a path IS ignored. Asking about a file git already tracks would be vacuous, so this asks
    // about a would-be NEW file in the corpus directory — the case that actually bites when someone
    // adds a ticket to the fixture later.
    const probe = 'agent/eval/fixtures/corpus/tkt-fx-not-yet-created.md';
    const ignored = (() => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--', probe], { cwd: REPO_ROOT });
        return true;
      } catch {
        return false; // exit 1 = no ignore rule matched
      }
    })();
    expect(ignored, `${probe} matches a .gitignore rule — a corpus file added there would be silently uncommitted`).toBe(false);
  });

  it('parses through the real board read with no unreadable files', async () => {
    const board = await listBoard();
    expect(board.unreadable).toEqual([]);
    expect(board.tickets.length).toBeGreaterThan(0);
  });

  it('contains every golden anchor, including the positive control', async () => {
    const board = await listBoard();
    const present = new Set(board.tickets.map((t) => t.id));
    const anchors = [
      ...FIXTURE_GOLDEN_SET.pairs.map((p) => p.expectedId),
      FIXTURE_GOLDEN_SET.positive.expectedId,
    ];
    const missing = [...new Set(anchors)].filter((id) => !present.has(id));
    expect(missing, 'anchors absent from the corpus can never rank, so recall would be capped by the fixture rather than measured').toEqual([]);
  });

  it('every parsed ticket is on disk as a tracked file, so none is author-only', async () => {
    const board = await listBoard();
    const tracked = new Set(trackedCorpusFiles().map((f) => path.basename(f, '.md')));
    const untracked = board.tickets.map((t) => t.id).filter((id) => !tracked.has(id));
    expect(untracked, 'these tickets parse locally but git would not ship them').toEqual([]);
  });

  it('carries enough distractors that recall@5 is not trivially saturated', async () => {
    // With depth 5 over a corpus of N, a corpus barely larger than the anchor set scores ~1.000 for
    // any embedder at all — a metric that cannot regress is not a measurement. The design is three
    // near-misses per anchor (goldenFixture.ts), i.e. FOUR documents per anchor family including the
    // anchor. The multiplier must match that: at *3 a corpus gutted from 61 to 40 stayed green while
    // contradicting the stated design. Pins the ratio, not the exact count, so adding pairs or
    // distractors stays free.
    const board = await listBoard();
    const anchorCount = new Set(FIXTURE_GOLDEN_SET.pairs.map((p) => p.expectedId)).size;
    expect(board.tickets.length).toBeGreaterThanOrEqual(anchorCount * 4);
  });

  // Adversary list for "a fixture run cannot touch the board's embedding cache". The dimensions that
  // matter are what the ambient environment can already be when the CLI starts: unset, set to the
  // board's default cache, set to some third path, or already correct. A fixture run PRUNES the
  // store it loads, so any of these landing on the board cache deletes real vectors.
  describe.each([
    ['unset', undefined],
    // Not written home-shaped (`/Users/<name>/…`): repoHygiene.test.mjs scans the index for a home
    // path naming an account and cannot tell a placeholder from a real one.
    ['pointing at the board cache', '/opt/board/.cache/embeddings.json'],
    ['pointing at an unrelated path', '/tmp/whatever/embeddings.json'],
    ['already the fixture cache', FIXTURE_CACHE_PATH],
  ])('applyFixtureEnv with EMBED_CACHE_PATH %s', (_label, ambient) => {
    it('pins both the corpus and the cache to the fixture, overwriting whatever was there', () => {
      const env: NodeJS.ProcessEnv = { TICKETS_DIR_OVERRIDE: '/somewhere/else' };
      if (ambient !== undefined) env.EMBED_CACHE_PATH = ambient;

      applyFixtureEnv(env);

      expect(env.EMBED_CACHE_PATH).toBe(FIXTURE_CACHE_PATH);
      expect(env.TICKETS_DIR_OVERRIDE).toBe(FIXTURE_CORPUS_DIR);
    });
  });

  it('pins the fixture cache inside the fixtures directory, where .cache is gitignored', () => {
    // If this ever resolved outside agent/eval/fixtures the cache would be committable, and the
    // prune above would be aimed at a directory this suite makes no claim about.
    const fixturesDir = path.dirname(FIXTURE_CORPUS_DIR);
    expect(FIXTURE_CACHE_PATH.startsWith(fixturesDir + path.sep)).toBe(true);
    expect(path.basename(path.dirname(FIXTURE_CACHE_PATH))).toBe('.cache');

    // Ask git, rather than inferring "gitignored" from the directory being called `.cache` — the
    // sibling test above asks about the corpus the same way. A 1.3MB embedding cache committed to a
    // public repo on every eval run is what this actually prevents.
    const rel = path.relative(REPO_ROOT, FIXTURE_CACHE_PATH);
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPO_ROOT });
      ignored = true;
    } catch { /* exit 1 = not ignored */ }
    expect(ignored, `${rel} is NOT gitignored — the embedding cache would be committable`).toBe(true);
  });

  it('routes the negative control at a subject the corpus does not cover', async () => {
    // A negative control that accidentally has an answer would fail for a board reason rather than
    // an index one — the misdiagnosis the positive-control presence check exists to remove, in the
    // other direction. Lexical, not semantic: a cheap standing check that needs no embedder.
    const board = await listBoard();
    const corpusText = board.tickets.map((t) => `${t.title} ${t.body}`.toLowerCase()).join('\n');
    for (const term of ['bluetooth', 'pairing', 'android']) {
      expect(corpusText, `the negative control's subject "${term}" appears in the corpus, so it may have a real answer`).not.toContain(term);
    }
  });
});

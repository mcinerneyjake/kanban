// Golden set for the retrieval eval: natural-language queries paired with the ONE ticket each should
// surface. Drawn from real, distinctive board tickets — all archived/done, which makes them stable in
// *content* but NOT permanent: archived tickets can still be deleted, and three of them were (see the
// retraction below), so "archived" buys a fixed body, never a guaranteed anchor. The presence gate in
// assertRetrievalInstruments is what actually holds this set honest. Queries are worded as a user
// would type them, NOT as the ticket's title, so this measures semantic recall rather than lexical echo.
//
// This set is NOT curated to flatter recall: misses are the finding, not a bug to hand-fix. If a pair
// looks wrong after a board change (the ticket was deleted, or a newer ticket is a legitimately better
// answer), fix the PAIR — never tune the query to force a hit.
//
// SCORE RETRACTION (2026-09-08, tkt-0a076c4d3084): three anchors — tkt-2597a4525562, tkt-6394577fd6af
// and tkt-98c0ccfb2e90 — had been deleted from the board. A deleted anchor is not in the corpus and
// can never rank, so recall was capped at 21/24 = 87.5% before any embedder ran, and a scored miss is
// indistinguishable from an unrankable anchor in the report.
//
// **Scope of the retraction — it is NOT "everything before 2026-09-08".** The 2026-07-24 baseline in
// tkt-7da70536da6a records `found 24/24 within depth 10` and recall@5 = 1.000, which is positive
// evidence that all 24 anchors were still live when it ran: that baseline, and the T7 chunking A/B
// built on it, stand. What is void is any run made AFTER the deletions — and their date is unknown, so
// **an undated run between 2026-07-24 and 2026-09-08 cannot be trusted**. Re-measure; no arithmetic
// recovers a capped number.
//
// The three pairs were replaced, not repaired. tkt-98c0ccfb2e90's real-client-IP scope was explicitly
// absorbed by tkt-fc7ffb516583 ("absorbs part of parked tkt-98c0ccfb2e90"), so that query was
// rewritten to describe the surviving ticket. tkt-2597a4525562 has NO successor: tkt-8fc2c52ce511
// fixed the concurrent-edit *clobber* but names "full optimistic locking / 409-on-`updated`-mismatch"
// as out of scope, so its slot is a new pair for the symptom that ticket really fixed, not a claim of
// succession. The old docker-compose query was dropped rather than re-pointed: the nearest board
// tickets (tkt-4db3f5c733e4, tkt-9ad7656fa60a) cover compose + a database but not the nginx half, so
// no single ticket is *the* answer — and a query with no unambiguous owner belongs in NEGATIVE_CONTROL,
// not here. `assertRetrievalInstruments` now fails LOUD on an absent anchor, so this cannot recur
// silently.

export interface GoldenPair {
  query: string;
  expectedId: string;
}

export interface NegativeControl {
  query: string;
  maxTopScore: number;
}

// A corpus and its controls travel together as ONE value. The controls are corpus-specific — a
// positive control names a ticket that must exist in *that* corpus, and a negative control's
// threshold was measured against *that* corpus's score distribution — so pairs and controls drawn
// from different corpora are always a wiring bug. Bundling them makes that combination
// unrepresentable rather than merely discouraged (tkt-07fab923fcbd).
export interface GoldenSet {
  /** Names the corpus this set is measured against, for the report header. */
  name: string;
  pairs: readonly GoldenPair[];
  positive: GoldenPair;
  negative: NegativeControl;
}

export const GOLDEN_PAIRS: readonly GoldenPair[] = [
  { query: 'run the embedded terminal detached with dtach so connections survive a restart', expectedId: 'tkt-00dd79b261d7' },
  { query: 'the embedded terminal vanishes when the container fails to start', expectedId: 'tkt-171759eb29f6' },
  { query: 'reconnect the terminal automatically after the websocket drops', expectedId: 'tkt-af8e94856264' },
  { query: 'copy and paste text into the embedded terminal', expectedId: 'tkt-fe2ead98fd65' },
  { query: 'vitest is collecting test files from inside git worktrees', expectedId: 'tkt-17d81c74b662' },
  { query: 'estimate the energy and water footprint of a local model run', expectedId: 'tkt-16f8fc4ebe05' },
  { query: 'add a multi-field filter UI to the board', expectedId: 'tkt-200dc50c1ebb' },
  { query: 'pressing escape on an open dropdown closes the whole ticket modal and loses my edits', expectedId: 'tkt-2f08f4f8635d' },
  { query: 'two saves with the same ticket id race on the temp file', expectedId: 'tkt-33a1ffcf9d5e' },
  { query: 'saving the ticket modal wiped out an edit made while it was open', expectedId: 'tkt-8fc2c52ce511' },
  { query: 'allow Claude as the cloud model for embeddings and agentic RAG', expectedId: 'tkt-29788d084c21' },
  { query: 'show a badge on agent-created tickets that deep-links to the run', expectedId: 'tkt-08247786f079' },
  { query: 'the MCP tools cannot set a due date or an assignee', expectedId: 'tkt-09aeba07e038' },
  { query: 'the guard-bash hook does not block force-push or branch deletion', expectedId: 'tkt-0b9b9543907f' },
  { query: 'split long documents into overlapping chunks before embedding them', expectedId: 'tkt-73bbcae2f3ca' },
  { query: 'a health endpoint to check whether the local chat model is running', expectedId: 'tkt-cde01f6bd72a' },
  { query: 'archive every done ticket at once from the done column', expectedId: 'tkt-a6a5fae92dcd' },
  { query: 'collapse the children of a done parent ticket by default', expectedId: 'tkt-de12f49fa167' },
  { query: 'due dates with a calendar view for deadlines', expectedId: 'tkt-b8f21c8b4493' },
  { query: 'the sidebar collapses when I activate it with the keyboard', expectedId: 'tkt-950cf52fd363' },
  { query: 'credentials in the base URL end up visible in the container process list', expectedId: 'tkt-281272b5ef77' },
  { query: 'stand up the production box with key-only ssh, a firewall, and origin certificates', expectedId: 'tkt-fc7ffb516583' },
  { query: 'an interactive replay viewer for agent runs that needs no backend', expectedId: 'tkt-cd3b0410162f' },
  { query: 'fix the heading margin in the mobile view', expectedId: 'tkt-59723ee7d481' },
];

// Positive control — a near-verbatim title of a stable ticket. It MUST rank top-1: if it does not,
// the embedder is miswired (wrong model/prefix) and every metric below is noise. This is the
// known-present control the retracted 2026-07-23 probe lacked.
export const POSITIVE_CONTROL: GoldenPair = {
  query: 'Interactive replay viewer for agent runs (static JSON, no backend)',
  expectedId: 'tkt-cd3b0410162f',
};

// Negative control — a query with no answer anywhere on the board, so a healthy index must return
// only weak matches: the top score must stay BELOW `maxTopScore`. A confident hit here means the
// index is asserting an answer that does not exist.
//
// Re-measured 2026-09-09 (tkt-0765a61ed303), 1554-vector board. The old control — "the CSV export
// crashes when the table has empty rows", threshold 0.50, calibrated 2026-07-24 at 509 vectors — had
// stopped being answerless and scored 0.599, hard-stopping the eval. Replaced, not reworded: the
// board tripled and went multi-repo in the central-board pivot, so it now carries real CSV tickets
// from copart-filter. The control also moved OFF-DOMAIN, because the board now spans every software
// project on this machine: a software-flavored no-answer query can no longer be kept answerless.
//
// 17 candidate queries measured; 2 dropped as no longer answerless — the CSV one (0.599) and "refund
// a customer through the point-of-sale terminal after closing" (0.500), which collided with
// ticket-closure tickets. Dropping that second one is a JUDGMENT CALL and it sets the floor below:
// read as a lexical collision rather than a real answer, it belongs in the population at 0.500 and
// the band below narrows to [0.501, 0.507]. The surviving 15, by top score:
//   0.482 0.480 0.458 0.455 0.422 0.419 0.412 0.386 0.379 0.378 0.350 0.342 0.318 0.295 0.293
//
// Ceiling: the weakest TRUE golden match scores 0.508 (tkt-16f8fc4ebe05). That is the ANCHOR'S OWN
// score at rank 2 — not the `score=` column of the eval report, which is `topScore`, i.e. whoever
// ranked first (0.513 for that case). Re-derive it the same way or the ceiling comes out too high.
//
// So the admissible band is [0.483, 0.507] and 0.49 sits in it: 0.008 above the highest answerless
// query, 0.018 below the ceiling, 0.148 above this control's own 0.342. The 2026-07-24 like-for-like
// figures were 0.031 and 0.015 — the band NARROWED from 0.046 to 0.026 as the corpus tripled, but it
// has not closed, so the original method still applies. Anything >= 0.508 waves through a real match,
// which is how the first-pass 0.62 failed. Expect this to need re-measuring again as the board grows.
//
// Floor note: agent/eval/retrievalEval.test.ts builds a 6-dim stub whose 'uniform' routing scores
// exactly 1/sqrt(6) = 0.408, so a threshold at or below that reddens the stub test for a reason that
// has nothing to do with the board.
export const NEGATIVE_CONTROL: NegativeControl = {
  query: 'the dog needs a rabies booster before the kennel will take him',
  maxTopScore: 0.49,
};

// The live board as a GoldenSet. Measures real recall, but is NOT reproducible: the board is
// gitignored, private, and changes under every run, so two runs score different corpora and the
// number cannot be compared over time. Use FIXTURE_GOLDEN_SET for a baseline; use this to ask what
// retrieval actually does on the real board today.
export const BOARD_GOLDEN_SET: GoldenSet = {
  name: 'live board',
  pairs: GOLDEN_PAIRS,
  positive: POSITIVE_CONTROL,
  negative: NEGATIVE_CONTROL,
};

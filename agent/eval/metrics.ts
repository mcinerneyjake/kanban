// Ranking metrics for retrieval eval — pure, so they unit-test without a runtime. `rankedIds` is
// best-first; `expectedId` is the one correct answer. Rank is 1-based; absent ⇒ no credit.

// 1-based rank of the expected id in a best-first list, or null if it never appears.
export function rankOf(rankedIds: string[], expectedId: string): number | null {
  const i = rankedIds.indexOf(expectedId);
  return i === -1 ? null : i + 1;
}

// Hit if the expected id is within the top k. k must be a positive integer.
export function recallAtK(rankedIds: string[], expectedId: string, k: number): boolean {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`recallAtK: k must be a positive integer, got ${k}`);
  const rank = rankOf(rankedIds, expectedId);
  return rank !== null && rank <= k;
}

// 1/rank, or 0 when the expected id is absent. Note: a search truncated at depth D reports 0 for any
// true rank > D, so MRR over such results is a LOWER bound — state the search depth alongside it.
export function reciprocalRank(rankedIds: string[], expectedId: string): number {
  const rank = rankOf(rankedIds, expectedId);
  return rank === null ? 0 : 1 / rank;
}

export interface RankedCase {
  rankedIds: string[];
  expectedId: string;
}

export interface RetrievalMetrics {
  n: number;
  recallAt1: number;   // fraction in [0,1]
  recallAt5: number;
  mrr: number;
}

// Aggregate recall@1 / recall@5 / MRR over the cases. Empty input ⇒ all-zero (n:0) rather than a
// divide-by-zero — a caller that expected cases should assert n>0 (the eval's instrument check does).
export function aggregate(cases: RankedCase[]): RetrievalMetrics {
  const n = cases.length;
  if (n === 0) return { n: 0, recallAt1: 0, recallAt5: 0, mrr: 0 };
  let r1 = 0;
  let r5 = 0;
  let rr = 0;
  for (const c of cases) {
    if (recallAtK(c.rankedIds, c.expectedId, 1)) r1 += 1;
    if (recallAtK(c.rankedIds, c.expectedId, 5)) r5 += 1;
    rr += reciprocalRank(c.rankedIds, c.expectedId);
  }
  return { n, recallAt1: r1 / n, recallAt5: r5 / n, mrr: rr / n };
}

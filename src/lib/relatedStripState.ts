export type RelatedStripState = 'list' | 'searching' | 'error' | 'hidden';

// Precedence: matches → list; else in-flight → spinner; else last search failed → error; else hidden.
export function relatedStripState(hasMatches: boolean, loading: boolean, error: boolean): RelatedStripState {
  if (hasMatches) return 'list';
  if (loading) return 'searching';
  if (error) return 'error';
  return 'hidden';
}

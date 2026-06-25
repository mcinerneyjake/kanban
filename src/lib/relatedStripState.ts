export type RelatedStripState = 'list' | 'searching' | 'error' | 'hidden';

// Precedence for the create-modal related-tickets strip: show the list if we
// have matches; otherwise the spinner while a search is in flight; otherwise an
// error line if the last search for this query failed; otherwise nothing.
export function relatedStripState(hasMatches: boolean, loading: boolean, error: boolean): RelatedStripState {
  if (hasMatches) return 'list';
  if (loading) return 'searching';
  if (error) return 'error';
  return 'hidden';
}

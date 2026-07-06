// Format an ISO timestamp with the given formatter, falling back to the raw
// string when it can't be parsed (a hand-edited or malformed value) rather than
// rendering "Invalid Date". Shared by the views that display log/run timestamps
// (PipelineTracker's event times, the economics run-detail header).
export function formatIso(iso: string, format: (d: Date) => string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : format(new Date(t));
}

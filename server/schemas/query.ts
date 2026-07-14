// Query-string parsing (kept out of controllers). Accept only a single string;
// anything else (absent/repeated/nested) is not-provided.
export function firstString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// GET /api/tickets?q= — trimmed search term, or '' when absent (list-all).
export function parseSearchTerm(q: unknown): string {
  return firstString(q)?.trim() ?? '';
}

// GET /api/dashboard?project= — trimmed project scope, or null for all projects.
export function parseProjectScope(project: unknown): string | null {
  const trimmed = firstString(project)?.trim();
  return trimmed ? trimmed : null;
}

// GET /api/economics?runId= — a run id to fetch a single run, or undefined.
export function parseRunId(runId: unknown): string | undefined {
  const trimmed = firstString(runId)?.trim();
  return trimmed ? trimmed : undefined;
}

// GET /api/economics?from=&to= — inclusive bounds. A bare YYYY-MM-DD normalizes to
// start (from) / end (to) of day so the run-log ISO 'at' compares correctly (else
// to=2026-07-03 excludes runs later that day).
export function parseDateBound(value: unknown, edge: 'from' | 'to'): string | undefined {
  const raw = firstString(value)?.trim();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return edge === 'from' ? `${raw}T00:00:00.000Z` : `${raw}T23:59:59.999Z`;
  }
  return raw;
}

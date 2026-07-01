// Query-string parsing lives here (not in controllers) so the read endpoints
// stay free of inline `typeof` coercion. Express types a query value as
// string | string[] | ParsedQs | ... ; we accept only a single string and treat
// anything else (absent, repeated, nested) as not-provided.
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

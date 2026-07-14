import type { Ticket, DashboardSummary, EconomicsSummary, EconomicsRunDetail, TicketEventsResponse } from '../shared/constants.js';

// Rejects with the server's {error} message (or a generic status string) when
// the HTTP response is not ok. Does not intercept network-level fetch()
// rejections (offline, DNS) — those propagate as TypeError and are caught by
// callers. res.json() returns `any`, so .error is directly accessible without
// a cast.
async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error || `Request failed (${res.status})`);
}

// Unwraps a successful JSON response. res.json() returns Promise<any>, which
// is assignable to T without a cast.
const json = async <T>(res: Response): Promise<T> => {
  await throwIfError(res);
  return res.json();
};

const get = <T>(url: string): Promise<T> => fetch(url).then((res) => json<T>(res));

// send() is for endpoints that return a JSON body (POST, PATCH).
// DELETE returns 204 No Content — calling res.json() on an empty body would
// throw a SyntaxError, so remove() uses fetch + throwIfError directly instead.
const send = <T>(url: string, method: string, data?: unknown): Promise<T> =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((res) => json<T>(res));

// `status` is optional: the search projection reads it from the document's meta
// (`r.meta?.status`), which is absent for a non-ticket source — so the wire type
// stays honest rather than claiming a status that may not ship (tkt-727c5cacdfad).
export interface IntakeMatch { id: string; title: string; status?: Ticket['status']; score: number }
export interface IntakeProposal { action: string; args: Record<string, unknown> }
export interface ProposeResult { proposal: IntakeProposal | null; summary: string; runId: string }

export const api = {
  list: (): Promise<Ticket[]> => get('/api/tickets'),
  get: (id: string): Promise<Ticket> => get(`/api/tickets/${id}`),
  dashboard: (project?: string): Promise<DashboardSummary> =>
    get(`/api/dashboard${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  // Agent economics: a rollup over an optional date range.
  economics: (opts: { from?: string; to?: string } = {}): Promise<EconomicsSummary> => {
    const qs = new URLSearchParams(
      Object.entries(opts).filter((e): e is [string, string] => Boolean(e[1]))
    ).toString();
    return get(`/api/economics${qs ? `?${qs}` : ''}`);
  },
  // Single-run economics detail — the `?runId=` deep-link target. Same endpoint,
  // richer payload (run identity + authored ticket ids). A 404 (unknown run) is a
  // normal outcome for a stale/mistyped link, so it RESOLVES to 'not-found' — the
  // detail view renders that distinctly from a real fault. Any other non-ok
  // status still rejects (surfaced as an error banner, not "run not found").
  economicsRun: async (runId: string): Promise<EconomicsRunDetail | 'not-found'> => {
    const res = await fetch(`/api/economics?runId=${encodeURIComponent(runId)}`);
    if (res.status === 404) return 'not-found';
    return json<EconomicsRunDetail>(res);
  },
  events: (id: string): Promise<TicketEventsResponse> => get(`/api/tickets/${id}/events`),
  review: (id: string, reviewed = true): Promise<TicketEventsResponse> =>
    send(`/api/tickets/${id}/review`, 'POST', { reviewed }),
  intake: {
    search: (query: string, limit?: number): Promise<{ results: IntakeMatch[] }> =>
      send('/api/intake/search', 'POST', { query, limit }),
    propose: (report: string): Promise<ProposeResult> =>
      send('/api/intake/propose', 'POST', { report }),
    // Persist a reviewed agent draft through the provenance/metering endpoint (stamps
    // source:'assisted' + the runId), instead of the plain human create/update routes.
    apply: (body: { action: 'create_ticket' | 'update_ticket'; runId: string; args: Record<string, unknown> }): Promise<Ticket> =>
      send('/api/intake/apply', 'POST', body),
    health: (): Promise<{ available: boolean }> => get('/api/intake/health'),
  },
  create: (data: Partial<Ticket>): Promise<Ticket> => send('/api/tickets', 'POST', data),
  update: (id: string, data: Partial<Ticket>): Promise<Ticket> => send(`/api/tickets/${id}`, 'PATCH', data),
  remove: (id: string): Promise<void> =>
    fetch(`/api/tickets/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
      .then(throwIfError),
};

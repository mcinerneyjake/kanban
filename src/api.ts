import type { Ticket, DashboardSummary, EconomicsSummary, EconomicsRunDetail, TicketEventsResponse } from '../shared/constants.js';

// Network-level fetch rejections (offline/DNS) propagate as TypeError, not here.
async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  throw new Error(body.error || `Request failed (${res.status})`);
}

const json = async <T>(res: Response): Promise<T> => {
  await throwIfError(res);
  return res.json();
};

const get = <T>(url: string): Promise<T> => fetch(url).then((res) => json<T>(res));

// DELETE returns 204 (empty body) — remove() skips json() to avoid a SyntaxError.
const send = <T>(url: string, method: string, data?: unknown): Promise<T> =>
  fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((res) => json<T>(res));

// `status` optional: absent for non-ticket sources (tkt-727c5cacdfad).
export interface IntakeMatch { id: string; title: string; status?: Ticket['status']; score: number }
export interface IntakeProposal { action: string; args: Record<string, unknown> }
export interface ProposeResult { proposal: IntakeProposal | null; summary: string; runId: string }

export const api = {
  list: (): Promise<Ticket[]> => get('/api/tickets'),
  get: (id: string): Promise<Ticket> => get(`/api/tickets/${id}`),
  dashboard: (project?: string): Promise<DashboardSummary> =>
    get(`/api/dashboard${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  economics: (opts: { from?: string; to?: string } = {}): Promise<EconomicsSummary> => {
    const qs = new URLSearchParams(
      Object.entries(opts).filter((e): e is [string, string] => Boolean(e[1]))
    ).toString();
    return get(`/api/economics${qs ? `?${qs}` : ''}`);
  },
  // 404 (unknown/stale run) resolves to 'not-found'; any other non-ok still rejects.
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
    // Provenance/metering endpoint: stamps source:'assisted' + runId (not the human route).
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

import { useCallback } from 'react';
import { api } from '../api.js';
import ErrorBanner from './ui/ErrorBanner.jsx';
import Modal from './ui/Modal.jsx';
import { StatTile, CostGroup } from './EconomicsParts.jsx';
import { usePolledSummary } from '../usePolledSummary.js';
import { fmtInt, headlineTile } from '../lib/econFormat.js';
import { formatIso } from '../lib/formatDate.js';
import {
  type EconomicsRunDetail as RunDetail,
  LABEL_COST_PER_ACCEPTED, LABEL_NET_SAVINGS, LABEL_LOCAL_VS_CLOUD,
} from '../../shared/constants.js';

type Props = {
  runId: string;
  onClose: () => void;
  onOpen: (id: string) => void;
};

function TicketLinks({ title, ids, onOpen }: { title: string; ids: string[]; onOpen: (id: string) => void }) {
  if (ids.length === 0) return null;
  return (
    <div className="econ-tickets-group">
      <span className="econ-tickets-label">{title}</span>
      <div className="econ-tickets-chips">
        {ids.map((id) => (
          <button key={id} className="econ-ticket-chip" onClick={() => onOpen(id)} title={`Open ${id}`}>
            {id}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function EconomicsRunDetail({ runId, onClose, onOpen }: Props) {
  const fetcher = useCallback(() => api.economicsRun(runId), [runId]);
  // Poll disabled: a persisted run record never changes; refetch only on runId change.
  const { data, error, setError } = usePolledSummary<RunDetail | 'not-found'>(fetcher, 0, 0);

  const isLoading = data === null && error === null;
  // 'not-found' is a resolved 404 (own empty state); real faults surface the banner.
  const notFound = data === 'not-found';
  const run = data && data !== 'not-found' ? data : null;

  const tile = (label: string) => headlineTile(run?.headline ?? [], label);

  return (
    <Modal onClose={onClose} className="modal--run" label="Run details">
      {/* Labelled back — outside-click can miss (sidebar sits above the backdrop). */}
      <button type="button" className="modal-back" onClick={onClose}>← Back to ticket</button>
      <div className="econ-run-header">
        {/* Neutral title when missing, so it doesn't read "Run <id>" above "not found". */}
        <h2 className="econ-run-id">{notFound ? 'Run detail' : `Run ${runId}`}</h2>
        {run && <p className="econ-run-meta">{run.model} · {formatIso(run.at, (d) => d.toLocaleString())}</p>}
      </div>

        {notFound ? (
          <div className="dash-empty">Run not found. It may have been removed, or the link is out of date.</div>
        ) : isLoading ? (
          <div className="dash-empty">Loading…</div>
        ) : (
          <>
            {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

            {run && (
              <>
                <div className="econ-tiles">
                  <StatTile label={LABEL_COST_PER_ACCEPTED} {...tile(LABEL_COST_PER_ACCEPTED)} />
                  <StatTile label={LABEL_NET_SAVINGS} {...tile(LABEL_NET_SAVINGS)} />
                  <StatTile label={LABEL_LOCAL_VS_CLOUD} {...tile(LABEL_LOCAL_VS_CLOUD)} />
                  <StatTile label="accepted tickets" value={fmtInt(run.totals.acceptedTickets)} />
                  <StatTile label="total tokens" value={fmtInt(run.totals.totalTokens)} />
                  <StatTile label="active time" value={`${(run.totals.activeMs / 1000).toFixed(1)}s`} />
                </div>
                {run.partial && (
                  <p className="econ-caveat">* Some figures are notional or partial — a required cost input was unset for this run.</p>
                )}

                <div className="econ-groups">
                  <CostGroup title="Usage" kind="measured" lines={[
                    { label: 'prompt tokens', amount: run.totals.promptTokens, unit: 'tokens', kind: 'measured' },
                    { label: 'completion tokens', amount: run.totals.completionTokens, unit: 'tokens', kind: 'measured' },
                    { label: 'total tokens', amount: run.totals.totalTokens, unit: 'tokens', kind: 'measured' },
                  ]} />
                  <CostGroup title="Outcome" kind="assumed" lines={[
                    { label: 'created', amount: run.totals.created, unit: 'count', kind: 'assumed' },
                    { label: 'updated', amount: run.totals.updated, unit: 'count', kind: 'assumed' },
                    { label: 'declined', amount: run.totals.declined, unit: 'count', kind: 'assumed' },
                  ]} />
                </div>

                <div className="econ-groups">
                  <CostGroup title="Measured" kind="measured" lines={run.measured} />
                  <CostGroup title="Assumed ($)" kind="assumed" lines={run.assumed} />
                  <CostGroup title="Externalities" kind="externality" lines={run.externalities} />
                </div>

                <section className="econ-tickets">
                  <h3 className="econ-group-title">Tickets authored</h3>
                  {run.ticketIds.created.length === 0 && run.ticketIds.updated.length === 0 ? (
                    <p className="econ-tickets-empty">This run authored no tickets.</p>
                  ) : (
                    <>
                      <TicketLinks title="Created" ids={run.ticketIds.created} onOpen={onOpen} />
                      <TicketLinks title="Updated" ids={run.ticketIds.updated} onOpen={onOpen} />
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}
    </Modal>
  );
}

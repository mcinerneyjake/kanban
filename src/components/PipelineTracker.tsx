import { useState } from 'react';
import { STEPS, type StatusId, type StepId } from '../../shared/constants.js';
import { api } from '../api.js';
import { useTicketEvents } from '../useTicketEvents.js';
import { pipelineView } from '../lib/pipelineView.js';
import { formatIso } from '../lib/formatDate.js';

function stepLabel(step: StepId): string {
  return STEPS.find((s) => s.id === step)?.label ?? step;
}

const formatTime = (iso: string): string => formatIso(iso, (d) => d.toLocaleTimeString());

// The "package tracking" timeline for a ticket, rendered inside TicketModal.
// Shows the full canonical pipeline (greyed until each milestone lands), the
// current phase, an on-demand raw event log, and the manual review gate: the
// Review node is a clickable checkmark — empty while awaiting, green once
// reviewed, toggleable both ways while the ticket is in-progress.
export default function PipelineTracker({ ticketId, status }: { ticketId: string; status: StatusId }) {
  const live = status === 'in-progress' || status === 'qa';
  const [reload, setReload] = useState(0);
  const { data, error } = useTicketEvents(ticketId, live, reload);
  const [showLog, setShowLog] = useState(false);
  const [toggling, setToggling] = useState(false);

  if (!data) {
    return error ? <div className="tracker tracker--error">Couldn't load progress.</div> : null;
  }

  const view = pipelineView(data.pipeline, status);
  if (!view.started) return null; // don't show a wall of grey for un-started tickets

  // Confirm-only: Review is recorded once, at the awaiting frontier, then locks.
  const markReviewed = async () => {
    setToggling(true);
    try {
      await api.review(ticketId, true);
      setReload((r) => r + 1); // force an immediate refetch, don't wait for the poll
    } catch {
      // best-effort; the poll will reconcile
    } finally {
      setToggling(false);
    }
  };

  return (
    <section className="tracker">
      <div className="tracker-head">
        <span>Progress</span>
        {view.current && (
          <span className={`tracker-current${view.failed ? ' is-failed' : ''}`}>{view.current}</span>
        )}
      </div>

      <ol className="tracker-steps">
        {view.nodes.map((n) => {
          // Review-gate interactivity is derived in pipelineView (unit-tested)
          // and consumed here — pulse when awaiting, ✓ control when showCheck,
          // actionable (with a live toggle guard) when clickable.
          const { awaiting, reviewed, showCheck, clickable } = n;
          const isReview = n.key === 'review';
          const nodeClass = awaiting ? 'is-awaiting-review' : `is-${n.state}`;
          const title = isReview
            ? (reviewed ? 'Reviewed'
              : awaiting ? 'Confirm your review'
              : n.state === 'skipped' ? 'Review skipped' : 'Awaiting the gate')
            // State-aware: a status-derived node (e.g. Started) is `reached` with
            // no event timestamp — it's Done, not Pending. Only truly-pending
            // nodes read "Pending".
            : n.state === 'skipped' ? 'Skipped'
              : n.state === 'failed' ? 'Failed'
              : n.at ? formatTime(n.at)
              : n.state === 'reached' || n.state === 'passed' ? 'Done'
              : n.state === 'active' ? 'In progress'
              : 'Pending';
          return (
            <li key={n.key} className={`tracker-node ${nodeClass}`} title={title}>
              {showCheck ? (
                <button
                  type="button"
                  className={`tracker-dot tracker-dot--check${reviewed ? ' is-checked' : ''}${awaiting ? ' is-awaiting' : ''}`}
                  onClick={clickable ? () => void markReviewed() : undefined}
                  disabled={!clickable || toggling}
                  aria-label="Mark reviewed"
                  aria-pressed={reviewed}
                >
                  ✓
                </button>
              ) : (
                <span className="tracker-dot" />
              )}
              <span className="tracker-label">{n.label}</span>
            </li>
          );
        })}
      </ol>

      {data.events.length > 0 && (
        <div className="tracker-log">
          <button type="button" className="link" onClick={() => setShowLog((s) => !s)}>
            {showLog ? 'Hide timeline' : `Show timeline (${data.events.length})`}
          </button>
          {showLog && (
            <ul className="tracker-log-list">
              {data.events.map((e, i) => {
                const label = e.detail === 'cleared' ? 'cleared' : e.state;
                return (
                  <li key={`${e.step}-${e.at}-${i}`} className={`tracker-log-row is-${label}`}>
                    <span className="tracker-log-time">{formatTime(e.at)}</span>
                    <span className="tracker-log-step">{stepLabel(e.step)}</span>
                    <span className="tracker-log-state">{label}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

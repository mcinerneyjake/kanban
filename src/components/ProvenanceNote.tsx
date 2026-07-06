// Shown in TicketModal for an agent-authored ticket: the provenance badge and a
// deep-link into the single-run economics view. Reads only the ticket's `runId`
// (a reference) — the economics themselves live in the run log and are one click
// away in the detail view, so this component fetches nothing (per the ticket's
// data contract: provenance is a pointer, not economics).
import ProvenanceBadge from './ProvenanceBadge.js';

type Props = { runId: string; onOpenRun: (runId: string) => void };

export default function ProvenanceNote({ runId, onOpenRun }: Props) {
  return (
    <div className="provenance-note">
      <ProvenanceBadge />
      <span className="provenance-text">Created by the intake agent</span>
      <button type="button" className="link" onClick={() => onOpenRun(runId)}>
        View economics →
      </button>
    </div>
  );
}

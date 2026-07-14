// Shown in TicketModal for a ticket authored via the intake agent: the provenance
// badge and a deep-link into the single-run economics view. Reads only the ticket's
// `source`/`runId` (a reference) — the economics live in the run log, one click away
// in the detail view, so this component fetches nothing (provenance is a pointer).
import ProvenanceBadge from './ProvenanceBadge.js';
import { type TicketSource } from '../../shared/constants.js';

const NOTE: Record<TicketSource, string> = {
  agent: 'Created by the intake agent',
  assisted: 'Drafted with the intake agent, saved by you',
};

type Props = { source: TicketSource; runId: string; onOpenRun: (runId: string) => void };

export default function ProvenanceNote({ source, runId, onOpenRun }: Props) {
  return (
    <div className="provenance-note">
      <ProvenanceBadge source={source} />
      <span className="provenance-text">{NOTE[source]}</span>
      <button type="button" className="link" onClick={() => onOpenRun(runId)}>
        View economics →
      </button>
    </div>
  );
}

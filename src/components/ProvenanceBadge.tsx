import { type TicketSource } from '../../shared/constants.js';

// The provenance marker — shared by the card (a passive badge among the type/
// priority badges) and the ticket modal's ProvenanceNote, so the label/styling
// live in one place. `agent` = an autonomous CLI run; `assisted` = a human-reviewed
// in-app draft. Non-interactive; the run-economics deep-link is a separate control.
// Record<TicketSource, ...> so a new source fails to compile until labelled here.
const LABEL: Record<TicketSource, string> = {
  agent: '🤖 Agent',
  assisted: '🤖 Assisted',
};

type Props = { source: TicketSource; title?: string };

export default function ProvenanceBadge({ source, title }: Props) {
  return <span className={`badge provenance provenance-${source}`} title={title}>{LABEL[source]}</span>;
}

import { type TicketSource } from '../../shared/constants.js';

// Record<TicketSource,…> so a new source fails to compile until labelled here.
const LABEL: Record<TicketSource, string> = {
  agent: '🤖 Agent',
  assisted: '🤖 Assisted',
};

type Props = { source: TicketSource; title?: string };

export default function ProvenanceBadge({ source, title }: Props) {
  return <span className={`badge provenance provenance-${source}`} title={title}>{LABEL[source]}</span>;
}

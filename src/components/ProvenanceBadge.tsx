// The "🤖 Agent" provenance marker — shared by the card (a passive badge among
// the type/priority badges) and the ticket modal's ProvenanceNote, so the label,
// emoji, and styling live in one place rather than diverging across the two.
// Non-interactive; the run-economics deep-link is a separate control.

type Props = { title?: string };

export default function ProvenanceBadge({ title }: Props) {
  return <span className="badge provenance" title={title}>🤖 Agent</span>;
}

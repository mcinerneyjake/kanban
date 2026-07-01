import type { Ticket } from '../../shared/constants.js';
import Card from './Card.jsx';

type Props = {
  tickets: Ticket[]
  activeBlockerCounts: Record<string, number>
  show: boolean
  onToggle: () => void
  onOpen: (ticket: Ticket) => void
}

export default function ArchiveLane({ tickets, activeBlockerCounts, show, onToggle, onOpen }: Props) {
  return (
    <div className="archive-lane">
      <button className="archive-toggle" onClick={onToggle} aria-expanded={show}>
        <span className="archive-toggle-chevron">{show ? '▾' : '▸'}</span>
        Archive
        <span className="archive-count">{tickets.length}</span>
      </button>

      {show && (
        <div className="archive-cards">
          {tickets.length === 0 ? (
            <span className="archive-empty">No archived tickets yet.</span>
          ) : (
            tickets.map((t) => (
              <Card key={t.id} ticket={t} activeBlockerCount={activeBlockerCounts[t.id] ?? 0} onOpen={onOpen} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

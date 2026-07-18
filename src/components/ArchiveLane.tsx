import type { Ticket } from '../../shared/constants.js';
import Card from './Card.jsx';

type Props = {
  tickets: Ticket[]
  // Unfiltered archived count, so an empty lane can distinguish "none archived" from "none match the filter".
  totalCount: number
  activeBlockerCounts: Record<string, number>
  show: boolean
  onToggle: () => void
  onOpen: (ticket: Ticket) => void
}

export default function ArchiveLane({ tickets, totalCount, activeBlockerCounts, show, onToggle, onOpen }: Props) {
  return (
    <div className="archive-lane">
      <button className="archive-toggle" onClick={onToggle} aria-expanded={show}>
        <span className="archive-toggle-chevron">{show ? '▾' : '▸'}</span>
        Archive
        <span className="archive-count">{totalCount}</span>
      </button>

      {show && (
        <div className="archive-cards">
          {tickets.length === 0 ? (
            <span className="archive-empty">
              {totalCount === 0 ? 'No archived tickets yet.' : 'No archived tickets match the filter.'}
            </span>
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

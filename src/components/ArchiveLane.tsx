import type { Ticket } from '../../shared/constants.js'

type Props = {
  tickets: Ticket[]
  show: boolean
  onToggle: () => void
  onOpen: (ticket: Ticket) => void
}

export default function ArchiveLane({ tickets, show, onToggle, onOpen }: Props) {
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
              <div
                key={t.id}
                className={`card archive-card prio-${t.priority}`}
                onClick={() => onOpen(t)}
              >
                <div className="card-title">{t.title}</div>
                <div className="card-meta">
                  <span className={`badge prio prio-${t.priority}`}>{t.priority}</span>
                  <span className="badge">{t.type}</span>
                  {t.project && <span className="badge">{t.project}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

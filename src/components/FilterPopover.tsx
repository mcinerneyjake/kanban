import { useState, useRef, useEffect } from 'react'
import { TYPES, PRIORITIES, isPriority, type TicketType, type Priority } from '../../shared/constants.js'

export type SortBy = 'order' | 'priority' | 'created' | 'title'
export type DateField = 'created' | 'updated'

const SORT_BY_VALUES: readonly SortBy[] = ['order', 'priority', 'created', 'title']
const DATE_FIELD_VALUES: readonly DateField[] = ['created', 'updated']

function isSortBy(val: string): val is SortBy {
  return SORT_BY_VALUES.find((s) => s === val) !== undefined
}
function isDateField(val: string): val is DateField {
  return DATE_FIELD_VALUES.find((s) => s === val) !== undefined
}

export type FilterState = {
  types: TicketType[]
  priority: Priority | ''
  project: string
  sort: SortBy
  dateField: DateField
  dateFrom: string
  dateTo: string
}

export const defaultFilter: FilterState = {
  types: [],
  priority: '',
  project: '',
  sort: 'order',
  dateField: 'created',
  dateFrom: '',
  dateTo: '',
}

type Props = {
  filter: FilterState
  projects: string[]
  onChange: (f: FilterState) => void
}

export default function FilterPopover({ filter, projects, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouse = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onMouse)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouse)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggleType = (t: TicketType) => {
    const next = filter.types.includes(t)
      ? filter.types.filter((x) => x !== t)
      : [...filter.types, t]
    onChange({ ...filter, types: next })
  }

  const activeCount = [
    filter.types.length > 0,
    filter.priority !== '',
    filter.project !== '',
    filter.dateFrom !== '' || filter.dateTo !== '',
    filter.sort !== 'order',
  ].filter(Boolean).length

  return (
    <div className="fp-anchor" ref={ref}>
      <button className="btn fp-trigger" onClick={() => setOpen((v) => !v)}>
        Filters
        {activeCount > 0 && <span className="fp-badge">{activeCount}</span>}
      </button>

      {open && (
        <div className="fp-panel">
          <div className="fp-row">
            <span className="fp-label">Type</span>
            <div className="filter-group">
              {TYPES.map((t) => (
                <button
                  key={t}
                  className={`filter-pill${filter.types.includes(t) ? ' active' : ''}`}
                  onClick={() => toggleType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-row">
            <span className="fp-label">Priority</span>
            <select
              value={filter.priority}
              onChange={(e) => { const v = e.target.value; onChange({ ...filter, priority: isPriority(v) ? v : '' }) }}
              className="filter-select fp-grow"
            >
              <option value="">All</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {projects.length > 0 && (
            <div className="fp-row">
              <span className="fp-label">Project</span>
              <select
                value={filter.project}
                onChange={(e) => onChange({ ...filter, project: e.target.value })}
                className="filter-select fp-grow"
              >
                <option value="">All</option>
                {projects.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          )}

          <div className="fp-row">
            <span className="fp-label">Date</span>
            <select
              value={filter.dateField}
              onChange={(e) => { const v = e.target.value; if (isDateField(v)) onChange({ ...filter, dateField: v }) }}
              className="filter-select"
            >
              <option value="created">Created</option>
              <option value="updated">Updated</option>
            </select>
            <input
              type="date"
              value={filter.dateFrom}
              onChange={(e) => onChange({ ...filter, dateFrom: e.target.value })}
              className="filter-select filter-date fp-grow"
              title="From date"
            />
            <span className="filter-date-sep">–</span>
            <input
              type="date"
              value={filter.dateTo}
              onChange={(e) => onChange({ ...filter, dateTo: e.target.value })}
              className="filter-select filter-date fp-grow"
              title="To date"
            />
          </div>

          <div className="fp-row">
            <span className="fp-label">Sort</span>
            <select
              value={filter.sort}
              onChange={(e) => { const v = e.target.value; if (isSortBy(v)) onChange({ ...filter, sort: v }) }}
              className="filter-select fp-grow"
            >
              <option value="order">Default</option>
              <option value="priority">Priority</option>
              <option value="created">Newest first</option>
              <option value="title">Title A–Z</option>
            </select>
          </div>

          {activeCount > 0 && (
            <button className="filter-clear fp-clear" onClick={() => onChange(defaultFilter)}>
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  )
}

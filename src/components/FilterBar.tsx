import { useEffect, useState } from 'react'
import { TYPES, PRIORITIES, type TicketType, type Priority } from '../../shared/constants.js'
import { api } from '../api.js'

export type SortBy = 'order' | 'priority' | 'created' | 'title'

export type FilterState = {
  types: TicketType[]
  priority: Priority | ''
  project: string
  sort: SortBy
}

export const defaultFilter: FilterState = {
  types: [],
  priority: '',
  project: '',
  sort: 'order',
}

type Props = {
  filter: FilterState
  onChange: (f: FilterState) => void
}

export default function FilterBar({ filter, onChange }: Props) {
  const [projects, setProjects] = useState<string[]>([])

  useEffect(() => {
    api.projects().then(setProjects).catch(() => {})
  }, [])

  const toggleType = (t: TicketType) => {
    const next = filter.types.includes(t)
      ? filter.types.filter((x) => x !== t)
      : [...filter.types, t]
    onChange({ ...filter, types: next })
  }

  const isActive =
    filter.types.length > 0 ||
    filter.priority !== '' ||
    filter.project !== '' ||
    filter.sort !== 'order'

  return (
    <div className="filter-bar">
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

      <div className="filter-group">
        <select
          value={filter.priority}
          onChange={(e) => onChange({ ...filter, priority: e.target.value as Priority | '' })}
          className="filter-select"
        >
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        {projects.length > 0 && (
          <select
            value={filter.project}
            onChange={(e) => onChange({ ...filter, project: e.target.value })}
            className="filter-select"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}

        <select
          value={filter.sort}
          onChange={(e) => onChange({ ...filter, sort: e.target.value as SortBy })}
          className="filter-select"
        >
          <option value="order">Sort: default</option>
          <option value="priority">Sort: priority</option>
          <option value="created">Sort: newest</option>
          <option value="title">Sort: title A–Z</option>
        </select>

        {isActive && (
          <button className="filter-clear" onClick={() => onChange(defaultFilter)}>
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

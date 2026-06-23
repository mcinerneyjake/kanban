import { isTicketType, isPriority } from '../../shared/constants.js';
import { defaultFilter, type FilterState, type SortBy, type DateField } from '../components/FilterPopover.js';

const SORT_BY_VALUES = ['order', 'priority', 'created', 'title'] as const;
const DATE_FIELD_VALUES = ['created', 'updated'] as const;

const isSortBy = (v: string): v is SortBy => SORT_BY_VALUES.find((s) => s === v) !== undefined;
const isDateField = (v: string): v is DateField => DATE_FIELD_VALUES.find((s) => s === v) !== undefined;

export function encode(f: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  for (const t of f.types) p.append('type', t);
  if (f.priority) p.set('priority', f.priority);
  if (f.project) p.set('project', f.project);
  if (f.sort !== defaultFilter.sort) p.set('sort', f.sort);
  if (f.dateField !== defaultFilter.dateField) p.set('dateField', f.dateField);
  if (f.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo) p.set('dateTo', f.dateTo);
  return p;
}

export function decode(p: URLSearchParams): FilterState {
  const types = p.getAll('type').filter(isTicketType);
  const priorityRaw = p.get('priority') ?? '';
  const priority = isPriority(priorityRaw) ? priorityRaw : '';
  const project = p.get('project') ?? '';
  const sortRaw = p.get('sort') ?? '';
  const sort = isSortBy(sortRaw) ? sortRaw : defaultFilter.sort;
  const dateFieldRaw = p.get('dateField') ?? '';
  const dateField = isDateField(dateFieldRaw) ? dateFieldRaw : defaultFilter.dateField;
  const dateFrom = p.get('dateFrom') ?? '';
  const dateTo = p.get('dateTo') ?? '';
  return { types, priority, project, sort, dateField, dateFrom, dateTo };
}

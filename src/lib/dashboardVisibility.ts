// The dashboard's widget model + the pure parse of its persisted form. Split out
// of useDashboardConfig so the parse (localStorage boundary, JSON, per-widget
// defaulting, corrupt-value fallback) is unit-testable without React.

export const WIDGETS = [
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'recent', label: 'Recently updated' },
] as const;

export type WidgetKey = (typeof WIDGETS)[number]['key']
export type WidgetVisibility = Record<WidgetKey, boolean>

export const ALL_VISIBLE: WidgetVisibility = { status: true, priority: true, recent: true };

// The persisted shape is a partial of the visibility map: older data may omit
// widgets added later, and any field may be absent. A concrete interface (not
// `Record<string, unknown>`) so the boundary value is narrowed, not widened.
interface PersistedVisibility {
  status?: boolean
  priority?: boolean
  recent?: boolean
}

// Arrays are objects too, but they simply carry none of the keys (→ all default
// visible), so the loose object check is sufficient here.
function isPersistedVisibility(v: unknown): v is PersistedVisibility {
  return typeof v === 'object' && v !== null;
}

// Pure parse of the persisted widgets string → a full visibility map. A missing
// key / partial object defaults that widget to visible (`!== false`); an empty,
// non-object, or corrupt value falls back to all-visible. No localStorage access
// here, so it's directly unit-testable.
export function parseVisibility(raw: string | null): WidgetVisibility {
  if (!raw) return ALL_VISIBLE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPersistedVisibility(parsed)) {
      return {
        status: parsed.status !== false,
        priority: parsed.priority !== false,
        recent: parsed.recent !== false,
      };
    }
  } catch { /* corrupt JSON — fall through to defaults */ }
  return ALL_VISIBLE;
}

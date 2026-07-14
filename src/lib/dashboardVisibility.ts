export const WIDGETS = [
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'recent', label: 'Recently updated' },
] as const;

export type WidgetKey = (typeof WIDGETS)[number]['key']
export type WidgetVisibility = Record<WidgetKey, boolean>

export const ALL_VISIBLE: WidgetVisibility = { status: true, priority: true, recent: true };

// Partial of the visibility map — older data may omit widgets; concrete interface keeps the boundary narrowed.
interface PersistedVisibility {
  status?: boolean
  priority?: boolean
  recent?: boolean
}

// Arrays pass this check but carry no keys (→ all default visible), so the loose check is fine.
function isPersistedVisibility(v: unknown): v is PersistedVisibility {
  return typeof v === 'object' && v !== null;
}

// Missing/partial key defaults that widget visible (!== false); empty/corrupt falls back to all-visible.
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

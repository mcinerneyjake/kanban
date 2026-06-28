import { useEffect, useState } from 'react';

// Dashboard view configuration, lifted out of the Dashboard component so the
// sidebar can own the controls while the dashboard consumes the values. Widget
// visibility persists across sessions; project filter and auto-refresh reset on
// reload (they're session-scoped exploration, not durable preferences).

export const WIDGETS = [
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'recent', label: 'Recently updated' },
] as const;

export type WidgetKey = (typeof WIDGETS)[number]['key']
export type WidgetVisibility = Record<WidgetKey, boolean>

const ALL_VISIBLE: WidgetVisibility = { status: true, priority: true, recent: true };
const WIDGETS_KEY = 'dashboard-widgets';

function loadVisibility(): WidgetVisibility {
  try {
    const raw = localStorage.getItem(WIDGETS_KEY);
    if (!raw) return ALL_VISIBLE;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj: Record<string, unknown> = { ...parsed };
      // A widget is shown unless explicitly stored as false, so a newly added
      // widget defaults to visible against an older persisted object.
      return { status: obj.status !== false, priority: obj.priority !== false, recent: obj.recent !== false };
    }
  } catch { /* corrupt value — fall through to defaults */ }
  return ALL_VISIBLE;
}

export interface DashboardConfig {
  project: string
  setProject: (p: string) => void
  visible: WidgetVisibility
  toggleWidget: (key: WidgetKey) => void
  autoRefresh: boolean
  setAutoRefresh: (on: boolean) => void
}

export function useDashboardConfig(): DashboardConfig {
  const [project, setProject] = useState('');
  const [visible, setVisible] = useState<WidgetVisibility>(loadVisibility);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    localStorage.setItem(WIDGETS_KEY, JSON.stringify(visible));
  }, [visible]);

  const toggleWidget = (key: WidgetKey) => setVisible((v) => ({ ...v, [key]: !v[key] }));

  return { project, setProject, visible, toggleWidget, autoRefresh, setAutoRefresh };
}

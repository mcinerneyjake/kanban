import { useEffect, useState } from 'react';
import { WIDGETS, parseVisibility, type WidgetKey, type WidgetVisibility } from './lib/dashboardVisibility.js';

// Dashboard view configuration, lifted out of the Dashboard component so the
// sidebar can own the controls while the dashboard consumes the values. Widget
// visibility persists across sessions; project filter and auto-refresh reset on
// reload (they're session-scoped exploration, not durable preferences).
//
// The widget model + the pure persistence parse live in ./lib/dashboardVisibility
// (unit-tested); re-exported here so existing consumers keep their import path.
export { WIDGETS };
export type { WidgetKey, WidgetVisibility };

const WIDGETS_KEY = 'dashboard-widgets';

// Thin localStorage wrapper around the pure parse; tolerates storage being
// unavailable (e.g. disabled/blocked) by falling back to defaults.
function loadVisibility(): WidgetVisibility {
  try {
    return parseVisibility(localStorage.getItem(WIDGETS_KEY));
  } catch {
    return { status: true, priority: true, recent: true };
  }
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

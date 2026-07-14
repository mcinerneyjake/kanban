import { useEffect, useState } from 'react';
import { WIDGETS, parseVisibility, type WidgetKey, type WidgetVisibility } from './lib/dashboardVisibility.js';

// Widget visibility persists across sessions; project filter + auto-refresh reset on reload (session-scoped exploration).
export { WIDGETS };
export type { WidgetKey, WidgetVisibility };

const WIDGETS_KEY = 'dashboard-widgets';

// Tolerates localStorage being unavailable (disabled/blocked) by falling back to defaults.
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

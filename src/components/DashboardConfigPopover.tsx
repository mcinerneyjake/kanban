import { useState, useRef, useEffect } from 'react';
import { WIDGETS, type DashboardConfig } from '../useDashboardConfig.js';

type Props = {
  projects: string[]
  dash: DashboardConfig
}

// Dashboard config as a single topbar popover — mirrors FilterPopover so the
// dashboard's controls read like the board's Filters button. Holds the project
// filter, per-widget visibility, and auto-refresh. Reuses the fp-* / filter-*
// classes for visual consistency.
export default function DashboardConfigPopover({ projects, dash }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Badge counts everything diverging from the defaults: a project filter, any
  // hidden widget, and auto-refresh being on.
  const hiddenWidgets = WIDGETS.filter((w) => !dash.visible[w.key]).length;
  const activeCount = (dash.project ? 1 : 0) + hiddenWidgets + (dash.autoRefresh ? 1 : 0);

  return (
    <div className="fp-anchor" ref={ref}>
      <button className="btn fp-trigger" onClick={() => setOpen((v) => !v)}>
        Config
        {activeCount > 0 && <span className="fp-badge">{activeCount}</span>}
      </button>

      {open && (
        <div className="fp-panel">
          <div className="fp-row">
            <span className="fp-label">Project</span>
            <select
              className="filter-select fp-grow"
              value={dash.project}
              onChange={(e) => dash.setProject(e.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="fp-row">
            <span className="fp-label">Widgets</span>
            <div className="filter-group">
              {WIDGETS.map((w) => (
                <button
                  key={w.key}
                  className={`filter-pill${dash.visible[w.key] ? ' active' : ''}`}
                  onClick={() => dash.toggleWidget(w.key)}
                  title={dash.visible[w.key] ? `Hide ${w.label}` : `Show ${w.label}`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-row">
            <span className="fp-label">Refresh</span>
            <label className="dash-autorefresh">
              <input type="checkbox" checked={dash.autoRefresh} onChange={(e) => dash.setAutoRefresh(e.target.checked)} />
              Auto-refresh
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

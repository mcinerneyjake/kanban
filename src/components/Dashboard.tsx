import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import ErrorBanner from './ErrorBanner.jsx';
import { donutSegments } from '../lib/donutSegments.js';
import { type WidgetVisibility } from '../useDashboardConfig.js';
import {
  STATUSES,
  type DashboardSummary,
  type StatusId,
  type Priority,
} from '../../shared/constants.js';

// Colours pulled from CSS custom properties so the charts track the active
// theme. Priorities already have --prio-* vars; status vars are added in
// styles.css alongside this view.
const STATUS_COLOR: Record<StatusId, string> = {
  backlog: 'var(--st-backlog)',
  todo: 'var(--st-todo)',
  'in-progress': 'var(--st-in-progress)',
  qa: 'var(--st-qa)',
  done: 'var(--st-done)',
  archived: 'var(--muted)',
};

const PRIORITY_COLOR: Record<Priority, string> = {
  low: 'var(--prio-low)',
  medium: 'var(--prio-medium)',
  high: 'var(--prio-high)',
  urgent: 'var(--prio-urgent)',
};

const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  STATUSES.map((s) => [s.id, s.label]),
);

const AUTO_REFRESH_MS = 15_000;

// Donut geometry.
const RADIUS = 70;
const STROKE = 26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const pct = (n: number) => `${Math.round(n * 100)}%`;

type Props = {
  project: string
  visible: WidgetVisibility
  autoRefresh: boolean
  // Bumped by App after any ticket mutation, so the aggregated counts re-fetch
  // and stay correct without a manual refresh button.
  refreshKey: number
  onOpen: (id: string) => void
}

// Renders the aggregated board metrics. Config (project filter, widget
// visibility, auto-refresh) lives in the topbar's Config popover and arrives as
// props; this component owns only the data fetch, polling, and rendering.
export default function Dashboard({ project, visible, autoRefresh, refreshKey, onOpen }: Props) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts true so the first fetch shows the loading state; only flipped false.
  const [loading, setLoading] = useState(true);

  // setState only ever runs inside the async callbacks (never synchronously in
  // render/effect), matching App.load() and keeping the effect side-effect-free.
  const load = useCallback(() => {
    api.dashboard(project || undefined)
      .then((s) => { setSummary(s); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [project]);

  // Refresh on mount, on project change, and whenever App signals a ticket
  // mutation (refreshKey). The full-screen loading state shows only before the
  // first summary arrives; later refreshes swap the data in place.
  useEffect(() => { load(); }, [load, refreshKey]);

  // Optional polling — only while enabled.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const statusSegments = summary
    ? donutSegments(summary.byStatus.map((s) => ({ key: s.status, count: s.count })), CIRCUMFERENCE)
    : [];
  const priorityMax = summary ? Math.max(1, ...summary.byPriority.map((p) => p.count)) : 1;
  const allHidden = !visible.status && !visible.priority && !visible.recent;

  return (
    <div className="dashboard">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading && !summary ? (
        <div className="dash-empty">Loading…</div>
      ) : summary && (
        <>
          <div className="dash-total">
            <strong>{summary.total}</strong> active ticket{summary.total === 1 ? '' : 's'}
            {project && <> in <strong>{project}</strong></>}
          </div>

          {allHidden ? (
            <div className="dash-empty">All widgets hidden — re-enable one in the Config popover.</div>
          ) : (
            <div className="dash-grid">
              {visible.status && (
                <section className="dash-widget">
                  <h3 className="dash-widget-title">Tickets by status</h3>
                  {summary.total === 0 ? (
                    <p className="dash-widget-empty">No tickets to chart.</p>
                  ) : (
                    <div className="donut-wrap">
                      <svg className="donut" viewBox="0 0 180 180" role="img" aria-label="Tickets by status">
                        <g transform="rotate(-90 90 90)">
                          {statusSegments.map((seg) => (
                            <circle
                              key={seg.key}
                              cx="90" cy="90" r={RADIUS}
                              fill="none"
                              stroke={STATUS_COLOR[seg.key]}
                              strokeWidth={STROKE}
                              strokeDasharray={seg.dashArray}
                              strokeDashoffset={seg.dashOffset}
                            />
                          ))}
                        </g>
                        <text x="90" y="90" className="donut-total" textAnchor="middle" dominantBaseline="central">
                          {summary.total}
                        </text>
                      </svg>
                      <ul className="donut-legend">
                        {summary.byStatus.filter((s) => s.count > 0).map((s) => (
                          <li key={s.status}>
                            <span className="legend-swatch" style={{ background: STATUS_COLOR[s.status] }} />
                            <span className="legend-label">{STATUS_LABEL[s.status] ?? s.status}</span>
                            <span className="legend-count">{s.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

              {visible.priority && (
                <section className="dash-widget">
                  <h3 className="dash-widget-title">Tickets by priority</h3>
                  {summary.total === 0 ? (
                    <p className="dash-widget-empty">No tickets to chart.</p>
                  ) : (
                    <ul className="bar-list">
                      {summary.byPriority.map((p) => (
                        <li key={p.priority} className="bar-row">
                          <span className="bar-label">{p.priority}</span>
                          <span className="bar-track">
                            <span
                              className="bar-fill"
                              style={{ width: pct(p.count / priorityMax), background: PRIORITY_COLOR[p.priority] }}
                            />
                          </span>
                          <span className="bar-count">{p.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {visible.recent && (
                <section className="dash-widget dash-widget--wide">
                  <h3 className="dash-widget-title">Recently updated</h3>
                  {summary.recentlyUpdated.length === 0 ? (
                    <p className="dash-widget-empty">Nothing updated yet.</p>
                  ) : (
                    <ul className="recent-list">
                      {summary.recentlyUpdated.map((t) => (
                        <li key={t.id}>
                          <button className="recent-row" onClick={() => onOpen(t.id)}>
                            <span className="recent-title">{t.title}</span>
                            <span className={`badge prio prio-${t.priority}`}>{t.priority}</span>
                            <span className="recent-status" style={{ color: STATUS_COLOR[t.status] }}>
                              {STATUS_LABEL[t.status] ?? t.status}
                            </span>
                            <span className="recent-date">{new Date(t.updated).toLocaleDateString()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

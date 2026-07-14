import { useCallback } from 'react';
import { api } from '../api.js';
import ErrorBanner from './ui/ErrorBanner.jsx';
import { usePolledSummary } from '../usePolledSummary.js';
import { donutSegments } from '../lib/donutSegments.js';
import { type WidgetVisibility } from '../useDashboardConfig.js';
import {
  STATUSES,
  type DashboardSummary,
  type StatusId,
  type Priority,
} from '../../shared/constants.js';

// CSS custom properties so charts track the active theme.
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

const RADIUS = 70;
const STROKE = 26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const pct = (n: number) => `${Math.round(n * 100)}%`;

type Props = {
  project: string
  visible: WidgetVisibility
  autoRefresh: boolean
  // Bumped by App after any ticket mutation so counts re-fetch.
  refreshKey: number
  onOpen: (id: string) => void
}

export default function Dashboard({ project, visible, autoRefresh, refreshKey, onOpen }: Props) {
  // Poll only while auto-refresh is on (shared with Economics via usePolledSummary).
  const fetcher = useCallback(() => api.dashboard(project || undefined), [project]);
  const { data: summary, error, setError } = usePolledSummary<DashboardSummary>(
    fetcher, refreshKey, autoRefresh ? AUTO_REFRESH_MS : 0,
  );

  const statusSegments = summary
    ? donutSegments(summary.byStatus.map((s) => ({ key: s.status, count: s.count })), CIRCUMFERENCE)
    : [];
  const priorityMax = summary ? Math.max(1, ...summary.byPriority.map((p) => p.count)) : 1;
  const allHidden = !visible.status && !visible.priority && !visible.recent;
  // First fetch pending (no summary, no error); later refreshes swap data in place.
  const isLoading = summary === null && error === null;

  return (
    <div className="dashboard">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {isLoading ? (
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

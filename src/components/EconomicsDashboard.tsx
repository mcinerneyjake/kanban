import { useCallback } from 'react';
import { api } from '../api.js';
import ErrorBanner from './ErrorBanner.jsx';
import { usePolledSummary } from '../usePolledSummary.js';
import { linePoints, toLinePath, toAreaPath } from '../lib/linePath.js';
import {
  type EconomicsSummary, type EconomicsLine,
  LABEL_COST_PER_ACCEPTED, LABEL_NET_SAVINGS, LABEL_LOCAL_VS_CLOUD,
} from '../../shared/constants.js';

// Agent economics: a FinOps rollup over the run log (GET /api/economics), read
// only — never the board. Mirrors Dashboard.tsx's fetch/poll/render shape.
// Colors track the theme via CSS custom properties (see styles.css --econ-*).

const AUTO_REFRESH_MS = 30_000;

// Chart geometry (viewBox units).
const CHART_W = 480;
const CHART_H = 150;
const CHART_PAD = 18;
const BASELINE = CHART_H - CHART_PAD;

const fmtInt = (n: number): string => Math.round(n).toLocaleString();
const fmtUsd = (n: number): string => `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`;
// Cost-model labels are lowercase by convention; sentence-case them for display
// (the underlying strings stay lowercase — the CLI renders them its own way).
const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Render one cost line's value honestly: a null amount is "—" (never $0), with
// the notional/partial note surfaced as a tooltip, per the run-log contract.
function formatAmount(line: EconomicsLine): string {
  if (line.amount === null) return '—';
  switch (line.unit) {
    case 'USD': return fmtUsd(line.amount);
    case 'ms': return `${(line.amount / 1000).toFixed(1)}s`;
    case 'kWh':
    case 'L': return `${line.amount.toPrecision(3)} ${line.unit}`;
    case 'gCO2e': return `${Math.round(line.amount)} ${line.unit}`;
    case '%': return `${Math.round(line.amount)}%`;
    default: return `${fmtInt(line.amount)} ${line.unit}`; // tokens, count
  }
}

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="econ-tile" title={note}>
      <span className="econ-tile-value">{value}{note ? <span className="econ-notional"> *</span> : null}</span>
      <span className="econ-tile-label">{sentence(label)}</span>
    </div>
  );
}

function CostGroup({ title, kind, lines }: { title: string; kind: string; lines: EconomicsLine[] }) {
  if (lines.length === 0) return null;
  return (
    <section className={`econ-group econ-group--${kind}`}>
      <h3 className="econ-group-title">{title}</h3>
      <table className="econ-table">
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.label} ${l.unit}`}>
              <td className="econ-line-label">{sentence(l.label)}</td>
              <td className={`econ-line-amount${l.amount === null ? ' econ-notional' : ''}`} title={l.note}>
                {formatAmount(l)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type Props = { refreshKey: number };

export default function EconomicsDashboard({ refreshKey }: Props) {
  const fetcher = useCallback(() => api.economics(), []);
  const { data: summary, error, setError } = usePolledSummary<EconomicsSummary>(fetcher, refreshKey, AUTO_REFRESH_MS);

  const isLoading = summary === null && error === null;

  // Time series: tokens/day — always real, unlike cost which is notional until a
  // cost model is configured. Cost is surfaced in the headline tiles + tables.
  const series = summary?.timeSeries ?? [];
  const points = linePoints({ values: series.map((p) => p.totalTokens), width: CHART_W, height: CHART_H, pad: CHART_PAD });

  const tile = (label: string) => {
    const l = summary?.headline.find((h) => h.label === label);
    return l ? { value: formatAmount(l), note: l.note } : { value: '—', note: undefined };
  };

  return (
    <div className="econ-dashboard">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {isLoading ? (
        <div className="dash-empty">Loading…</div>
      ) : summary && summary.runs === 0 ? (
        <div className="dash-empty">No agent runs recorded yet. Run the intake agent to populate economics.</div>
      ) : summary && (
        <>
          <div className="econ-tiles">
            <StatTile label={LABEL_COST_PER_ACCEPTED} {...tile(LABEL_COST_PER_ACCEPTED)} />
            <StatTile label={LABEL_NET_SAVINGS} {...tile(LABEL_NET_SAVINGS)} />
            <StatTile label={LABEL_LOCAL_VS_CLOUD} {...tile(LABEL_LOCAL_VS_CLOUD)} />
            <StatTile label="runs" value={fmtInt(summary.runs)} />
            <StatTile label="accepted tickets" value={fmtInt(summary.totals.acceptedTickets)} />
            <StatTile label="total tokens" value={fmtInt(summary.totals.totalTokens)} />
          </div>
          {summary.partial && (
            <p className="econ-caveat">* Some figures are notional or partial — a required cost input was unset for one or more runs.</p>
          )}

          <section className="econ-chart-card">
            <h3 className="econ-group-title">Tokens per day</h3>
            {/* runs > 0 here (the empty state is handled above), so buildTimeSeries
                always yields at least one point — no empty-chart branch needed. */}
            <svg className="econ-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="Tokens per day">
              <path className="econ-area" d={toAreaPath(points, BASELINE)} />
              <path className="econ-line" d={toLinePath(points)} fill="none" />
              {points.map((p, i) => (
                <circle key={series[i].date} className="econ-dot" cx={p.x} cy={p.y} r={3}>
                  <title>{series[i].date}: {fmtInt(series[i].totalTokens)} tokens · {series[i].acceptedTickets} accepted</title>
                </circle>
              ))}
            </svg>
          </section>

          <div className="econ-groups">
            <CostGroup title="Measured" kind="measured" lines={summary.measured} />
            <CostGroup title="Assumed ($)" kind="assumed" lines={summary.assumed} />
            <CostGroup title="Externalities" kind="externality" lines={summary.externalities} />
          </div>
        </>
      )}
    </div>
  );
}

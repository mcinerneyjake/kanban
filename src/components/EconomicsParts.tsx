import { type EconomicsLine } from '../../shared/constants.js';
import { formatAmount, sentence } from '../lib/econFormat.js';

export function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="econ-tile" title={note}>
      <span className="econ-tile-value">{value}{note ? <span className="econ-notional"> *</span> : null}</span>
      <span className="econ-tile-label">{sentence(label)}</span>
    </div>
  );
}

export function CostGroup({ title, kind, lines }: { title: string; kind: string; lines: EconomicsLine[] }) {
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

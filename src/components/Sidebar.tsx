import { withBlur } from '../lib/withBlur.js';

export type View = 'board' | 'dashboard' | 'economics'

const NAV: { view: View; icon: string; label: string }[] = [
  { view: 'board', icon: '📋', label: 'Board' },
  { view: 'dashboard', icon: '📊', label: 'Dashboard' },
  { view: 'economics', icon: '⚡', label: 'Economics' },
];

type Props = {
  view: View
  onViewChange: (v: View) => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export default function Sidebar({ view, onViewChange, theme, onToggleTheme }: Props) {
  return (
    <>
      {/* Spacer keeps content clear of the collapsed rail; the panel overlays on expand, so hover never reflows. */}
      <div className="sidebar-rail" aria-hidden="true" />
      <aside className="sidebar">
        <nav className="sidebar-nav">
          {NAV.map((n) => (
            <button
              key={n.view}
              className={`sidebar-item${view === n.view ? ' active' : ''}`}
              // aria-current, not role="tab" (which would promise arrow-key nav this rail lacks).
              aria-current={view === n.view ? 'page' : undefined}
              // Drop focus after click so the button doesn't hold the rail open via :focus-within.
              onClick={withBlur(() => onViewChange(n.view))}
              title={n.label}
            >
              <span className="sidebar-icon">{n.icon}</span>
              <span className="sidebar-text">{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <button className="sidebar-item sidebar-theme" onClick={withBlur(onToggleTheme)} title="Toggle theme">
          <span className="sidebar-icon">{theme === 'dark' ? '☀️' : '🌙'}</span>
          <span className="sidebar-text">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </aside>
    </>
  );
}

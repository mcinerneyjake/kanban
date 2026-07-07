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

// Left navigation rail — pure app navigation (view switcher + theme). Sits
// collapsed to an icon strip and expands on hover, or when a button inside has
// keyboard focus (:focus-within), so tabbing into the rail reveals the labels.
// View-specific config lives in the view itself, not here.
export default function Sidebar({ view, onViewChange, theme, onToggleTheme }: Props) {
  return (
    <>
      {/* Spacer keeps page content clear of the collapsed rail; the real panel
          overlays content as it expands, so hovering never reflows the board. */}
      <div className="sidebar-rail" aria-hidden="true" />
      <aside className="sidebar">
        <nav className="sidebar-nav">
          {NAV.map((n) => (
            <button
              key={n.view}
              className={`sidebar-item${view === n.view ? ' active' : ''}`}
              // App navigation, not a tabs widget: aria-current marks the active
              // view (dropping role="tab"/tablist, which would promise arrow-key
              // navigation this rail doesn't implement).
              aria-current={view === n.view ? 'page' : undefined}
              // withBlur: drop focus after click so the button doesn't hold the
              // rail open via :focus-within once the pointer leaves.
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

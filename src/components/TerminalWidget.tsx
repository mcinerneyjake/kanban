import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Dev-only floating terminal (tkt-be809dd2b7fb): an xterm bound over a WebSocket to a
// confined, subscription-authed Claude Code session in a container. Minimize keeps the
// socket (and container) alive; close unmounts → the server tears the container down.

export type TerminalSession = { ticket?: string };
type Status = 'connecting' | 'open' | 'closed' | 'error';

// Map xterm's palette from the app's CSS theme tokens so light/dark follows the board.
function xtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--card-bg', '#1e1e1e'),
    foreground: read('--text', '#d4d4d4'),
    cursor: read('--text', '#d4d4d4'),
    selectionBackground: read('--border', '#264f78'),
  };
}

export default function TerminalWidget({ session, theme, onClose }: {
  session: TerminalSession;
  theme: 'light' | 'dark';
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [status, setStatus] = useState<Status>('connecting');
  // False until the first byte of session output arrives — covers token fetch + handshake +
  // container/claude boot (all blank), not just the WS open.
  const [booted, setBooted] = useState(false);

  // Keep the latest onClose reachable without listing it as a dep of the connection effect
  // (which would tear the pty down on every parent render).
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // One terminal + socket per session (keyed by App, so a new ticket remounts).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontSize: 13, cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let ws: WebSocket | null = null;
    let disposed = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let bootCapTimer: ReturnType<typeof setTimeout> | undefined;

    const sendResize = () => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
    };
    const dataSub = term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }));
    });
    // Refit on pane resize — but only while visible (minimized hides it → 0×0, which we must not send).
    const ro = new ResizeObserver(() => { if (container.offsetParent !== null) { fit.fit(); sendResize(); } });
    ro.observe(container);

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    fetch('/api/terminal/token')
      .then((r) => r.json())
      .then((body: { token: string }) => {
        if (disposed) return;
        const query = session.ticket ? `?ticket=${encodeURIComponent(session.ticket)}` : '';
        // Token travels as the WS subprotocol, not the URL, so it can't land in access logs.
        ws = new WebSocket(`${scheme}://${location.host}/terminal-ws${query}`, [body.token]);
        wsRef.current = ws;
        let wasOpen = false;
        let revealed = false;
        // Lift the loading overlay only once claude's initial render burst SETTLES (a quiet
        // gap after output) — revealing on the first byte would flash the freshly-cleared
        // screen before the UI paints. A hard cap covers sessions that stream continuously.
        const reveal = () => {
          if (revealed) return;
          revealed = true;
          setBooted(true);
          if (settleTimer) clearTimeout(settleTimer);
          if (bootCapTimer) clearTimeout(bootCapTimer);
        };
        ws.onopen = () => { wasOpen = true; setStatus('open'); fit.fit(); sendResize(); term.focus(); };
        ws.onmessage = (e) => {
          if (!revealed) {
            if (!bootCapTimer) bootCapTimer = setTimeout(reveal, 2500);
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(reveal, 150);
          }
          const data: unknown = e.data;
          if (typeof data === 'string') term.write(data);
          else if (data instanceof ArrayBuffer) term.write(new Uint8Array(data));
        };
        ws.onclose = () => {
          if (disposed) return;
          setStatus('closed');
          // Session ended (e.g. exiting Claude) → dismiss the widget. Deterministic: keyed off
          // the authoritative socket close, no keystroke prediction or timers. A never-opened
          // socket (auth/connect failure) stays put so its error is visible.
          if (wasOpen) onCloseRef.current();
        };
        ws.onerror = () => { if (!disposed) setStatus('error'); };
      })
      .catch(() => { if (!disposed) setStatus('error'); });

    return () => {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (bootCapTimer) clearTimeout(bootCapTimer);
      ro.disconnect();
      dataSub.dispose();
      if (ws) ws.close();
      term.dispose();
      termRef.current = null; fitRef.current = null; wsRef.current = null;
    };
  }, [session]);

  // Follow the app's light/dark toggle. Deferred a frame: this child effect runs BEFORE the
  // parent useTheme effect writes the new data-theme onto <html>, so reading the CSS vars
  // synchronously would pick up the previous theme (lagging one toggle behind).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (termRef.current) termRef.current.options.theme = xtermTheme();
    });
    return () => cancelAnimationFrame(id);
  }, [theme]);

  // Refit after restoring (the pane regains size on the next frame).
  useEffect(() => {
    if (minimized) return;
    const id = requestAnimationFrame(() => {
      const term = termRef.current;
      const ws = wsRef.current;
      fitRef.current?.fit();
      if (term && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
    });
    return () => cancelAnimationFrame(id);
  }, [minimized]);

  const title = session.ticket ? `Terminal · ${session.ticket}` : 'Terminal';
  const overlay = status === 'error' ? 'Terminal unavailable'
    : !booted ? 'Loading terminal…'
    : null;

  return (
    <div className={`terminal-widget${minimized ? ' minimized' : ''}`} role="dialog" aria-label="Embedded terminal">
      <div className="tw-header">
        <span className="tw-title">{title}</span>
        <span className={`tw-status tw-status-${status}`} title={status} aria-label={`status: ${status}`}>●</span>
        <button className="tw-btn" onClick={() => setMinimized((m) => !m)} aria-label={minimized ? 'Restore terminal' : 'Minimize terminal'}>
          {minimized ? '▢' : '—'}
        </button>
        <button className="tw-btn" onClick={onClose} aria-label="Close terminal">✕</button>
      </div>
      <div className="tw-body-wrap">
        <div className="tw-body" ref={containerRef} />
        {overlay && <div className="tw-overlay">{overlay}</div>}
      </div>
    </div>
  );
}

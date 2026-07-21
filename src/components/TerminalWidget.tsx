import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { classifyClose, reconnectDelayMs, RECONNECT, overlayFor, liveMessageFor, type TerminalStatus } from '../lib/terminalReconnect';

// Dev-only floating terminal (tkt-be809dd2b7fb): an xterm bound over a WebSocket to a
// confined, subscription-authed Claude Code session in a container. Minimize keeps the
// socket (and container) alive; close unmounts → the server tears the container down.
//
// Detach/reattach across reloads (tkt-dd308ec91efc): a Vite full reload (Claude edits a file
// from inside the container) drops the WS. Rather than kill the session, we carry a per-tab
// session id in sessionStorage and REATTACH on the reload — the server holds the container in a
// grace window and repaints the current screen. An explicit close (✕ / session swap) sends a
// terminate frame so the server disposes at once. Limitation: a `server/**` edit restarts Express
// and kills every container (not covered in v1).

export type TerminalSession = { ticket?: string };
type Status = TerminalStatus;

// Per-tab reattach identity. sessionStorage survives a reload but dies on tab close — matching
// "close tears the container down". Keyed per mount-key so a shell and a ticket session don't
// collide. Defensive read (storage may be blocked/full) per useDashboardConfig.
type SessionId = { id: string; canPersist: boolean };
function readOrMintSessionId(mountKey: string): SessionId {
  const storageKey = `terminal:session:${mountKey}`;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return { id: existing, canPersist: true };
    const id = crypto.randomUUID();
    sessionStorage.setItem(storageKey, id);
    return { id, canPersist: true };
  } catch {
    // Storage unavailable → an ephemeral id we can't reattach to; we terminate on cleanup instead.
    return { id: crypto.randomUUID(), canPersist: false };
  }
}
function clearSessionId(mountKey: string): void {
  try { sessionStorage.removeItem(`terminal:session:${mountKey}`); } catch { /* storage gone */ }
}

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

  // Distinguishes a reload/tab-close (keep the session alive for reattach) from a deliberate
  // unmount (✕ / session swap → terminate the session). Set on `pagehide`, which fires for both
  // reload and tab close but NOT for a React unmount.
  const isUnloadingRef = useRef(false);
  useEffect(() => {
    const onPageHide = () => { isUnloadingRef.current = true; };
    // Reset if the page is shown again from the bfcache (pageshow) rather than fully reloaded —
    // otherwise the flag stays stuck true and a later deliberate ✕ would skip the terminate frame
    // (review #6), stranding the container in grace + a stale session id.
    const onPageShow = () => { isUnloadingRef.current = false; };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  // One terminal per session (keyed by App, so a new ticket remounts); the SOCKET may be rebuilt in
  // place by the reconnect loop below. Auto-reconnect (tkt-af8e94856264): an Express restart drops
  // the WS as a socket DEATH (no close frame ⇒ code 1006) while the container survives server-side
  // (S3a) — so instead of dismissing the widget, we re-fetch the (per-boot, now-rotated) token and
  // reattach with bounded exponential backoff, keyed on the same sessionStorage id. An INTENTIONAL
  // server close (session ended → the server bare-closes ⇒ code 1005) still dismisses; see classifyClose.
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
    let hasEverOpened = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
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

    const mountKey = session.ticket ?? 'shell';
    const { id: sessionId, canPersist } = readOrMintSessionId(mountKey);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';

    const scheduleReconnect = () => {
      // booted ⇒ NO overlay: the last frame stays visible and the amber-pulsing header dot is the
      // only signal, so an Express-restart reconnect looks like Claude simply kept thinking.
      setStatus('connecting');
      const delay = reconnectDelayMs(reconnectAttempts, { baseMs: RECONNECT.baseMs, capMs: RECONNECT.capMs });
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => { if (!disposed) connect(); }, delay);
    };

    // Failure with no live socket (the token fetch itself failed — server likely mid-restart): retry
    // if this session had opened before, else it's an initial-connect failure.
    const onConnectFailure = () => {
      if (disposed) return;
      if (classifyClose({ code: 1006, wasOpen: false, hasEverOpened, attempts: reconnectAttempts, maxAttempts: RECONNECT.maxAttempts }) === 'reconnect') {
        scheduleReconnect();
      } else {
        setStatus('error');
      }
    };

    const connect = () => {
      if (settleTimer) clearTimeout(settleTimer);
      if (bootCapTimer) clearTimeout(bootCapTimer);
      const params = new URLSearchParams({ session: sessionId });
      if (session.ticket) params.set('ticket', session.ticket);
      // Re-fetch the token every attempt: it is minted per Express boot, so after a restart the old
      // one is invalid — reusing it would 403 the reattach. The session id is stable (sessionStorage).
      fetch('/api/terminal/token')
        .then((r) => r.json())
        .then((body: { token: string }) => {
          if (disposed) return;
          // Token travels as the WS subprotocol, not the URL, so it can't land in access logs. The
          // session id is a non-secret name (useless without the token), so the query is fine for it.
          const socket = new WebSocket(`${scheme}://${location.host}/terminal-ws?${params.toString()}`, [body.token]);
          ws = socket;
          wsRef.current = socket;
          let wasOpen = false;
          let revealed = false;
          // Lift the loading overlay only once claude's initial render burst SETTLES (a quiet gap
          // after output) — revealing on the first byte would flash the freshly-cleared screen before
          // the UI paints. A hard cap covers sessions that stream continuously.
          const reveal = () => {
            if (revealed) return;
            revealed = true;
            setBooted(true);
            if (settleTimer) clearTimeout(settleTimer);
            if (bootCapTimer) clearTimeout(bootCapTimer);
          };
          socket.onopen = () => {
            if (disposed) return;
            wasOpen = true;
            hasEverOpened = true;
            reconnectAttempts = 0; // a successful (re)connect resets the backoff budget
            setStatus('open');
            fit.fit(); sendResize(); term.focus();
            // Reveal once output SETTLES (first byte + a quiet gap) for both new and reattached
            // sessions: a reattach's SIGWINCH repaint emits bytes, so it still reveals fast — and a
            // client can't reliably tell a reattach from a server-side fresh boot (grace expired /
            // server restart). The cap from OPEN covers a session that emits nothing at all.
            bootCapTimer = setTimeout(reveal, 2500);
          };
          socket.onmessage = (e) => {
            if (disposed) return;
            if (!revealed) {
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(reveal, 150);
            }
            const data: unknown = e.data;
            if (typeof data === 'string') term.write(data);
            else if (data instanceof ArrayBuffer) term.write(new Uint8Array(data));
          };
          socket.onclose = (event) => {
            if (disposed) return;
            // A reload/tab-close drops the socket too, but the session lives on for reattach — keep
            // the widget so the reloaded page (App restores it from sessionStorage) rejoins it.
            if (isUnloadingRef.current) return;
            const action = classifyClose({
              code: event.code, wasOpen, hasEverOpened, attempts: reconnectAttempts, maxAttempts: RECONNECT.maxAttempts,
            });
            // 'reconnect' → socket death (Express restarted) but the container survives (S3a): retry
            // with backoff. 'dismiss' → intentional server close (session ended, 1005/1000).
            // 'error' → outage / retries exhausted.
            if (action === 'reconnect') scheduleReconnect();
            else if (action === 'dismiss') onCloseRef.current();
            else setStatus('error');
          };
          socket.onerror = () => { /* the onclose that always follows decides: reconnect / dismiss / error */ };
        })
        .catch(onConnectFailure);
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (bootCapTimer) clearTimeout(bootCapTimer);
      ro.disconnect();
      dataSub.dispose();
      // Terminate the server session UNLESS this is a reload (then the socket drop → grace →
      // reattach). Also terminate when we can't persist an id — a reload couldn't reattach anyway, so
      // don't strand a grace-held container. Terminating clears the id so we never try to rejoin a
      // session we just told the server to dispose. Runs even mid-reconnect (ws may be null then).
      const terminate = !canPersist || !isUnloadingRef.current;
      if (terminate) clearSessionId(mountKey);
      if (ws) {
        if (terminate && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ t: 'e' })); } catch { /* closing */ } }
        ws.close();
      }
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
  // Once booted, a reconnect shows NO overlay — the frozen frame stays and the dot carries the signal.
  const overlay = overlayFor(status, booted);
  const liveMsg = liveMessageFor(status, booted);
  // A booted reconnect reads better as "reconnecting" than the raw "connecting" state name.
  const statusLabel = booted && status === 'connecting' ? 'reconnecting' : status;

  return (
    <div className={`terminal-widget${minimized ? ' minimized' : ''}`} role="dialog" aria-label="Embedded terminal">
      <div className="tw-header">
        <span className="tw-title">{title}</span>
        <span className={`tw-status tw-status-${status}`} title={statusLabel} aria-hidden="true">●</span>
        <button className="tw-btn" onClick={() => setMinimized((m) => !m)} aria-label={minimized ? 'Restore terminal' : 'Minimize terminal'}>
          {minimized ? '▢' : '—'}
        </button>
        <button className="tw-btn" onClick={onClose} aria-label="Close terminal">✕</button>
      </div>
      <div className="tw-body-wrap">
        <div className="tw-body" ref={containerRef} />
        {overlay && <div className="tw-overlay">{overlay}</div>}
      </div>
      {/* Screen readers get the reconnect/recovery cue that used to live in the (now removed) overlay. */}
      <span className="sr-only" role="status" aria-live="polite">{liveMsg}</span>
    </div>
  );
}

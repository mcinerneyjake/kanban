import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { execSync, spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as pty from 'node-pty';
import { getTicket } from './tickets.js';
import { projectRoots, kanbanRoot } from './terminalProjects.js';
import { terminalToken } from './terminalToken.js';
import {
  authorizeUpgrade, authorizeReattach, buildSessionEnv, isValidSessionId, parseClientFrame,
  parseSessionParam, parseTicketParam, resolveSessionCommand, rootMountArgs, type CredMount,
} from './terminalAuth.js';
import { TerminalRegistry, type TerminalEntry } from './terminalRegistry.js';

// Bidirectional terminal transport (tkt-be809dd2b7fb): a WS on /terminal-ws whose bytes are piped,
// verbatim, to a node-pty that wraps `docker run -it` for a confined Claude Code session. Dev-only
// — attached from index.ts solely when KANBAN_TERMINAL=1. The security decision + framing are pure
// functions in terminalAuth (unit-tested); the session lifecycle is TerminalRegistry (unit-tested);
// this file is the I/O wiring around them.
//
// Detach/reattach (tkt-dd308ec91efc): a browser reload drops the WS but the pty/container survive
// server-side, keyed by a client-minted session id, and a reload REATTACHES rather than killing the
// session. Known limitations (v1): does NOT survive an Express restart (a `server/**` edit under
// `tsx watch` kills every container); scrollback produced while detached is not restored (the
// current screen is, via a SIGWINCH repaint); a detached session is held for GRACE_MS then reaped.

const WS_PATH = '/terminal-ws';
const MAX_SESSIONS = 2;
const GRACE_MS = 60_000;   // how long a detached (reloading) session waits to be reattached
const NUDGE_MS = 50;       // gap between the two-step SIGWINCH resize halves on reattach
const IMAGE = process.env.KANBAN_TERMINAL_IMAGE ?? 'kanban-terminal';

const registry = new TerminalRegistry({
  graceMs: GRACE_MS,
  nudgeMs: NUDGE_MS,
  killContainer: (name) => {
    spawnChild('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => { /* already gone */ });
  },
});

// Populate each root's node_modules volume with Linux deps in a one-shot container BEFORE the
// interactive session, so the install never runs inside the PTY (which would delay claude and
// mistime the ticket prefill). Serialized per root-set via an in-flight promise so concurrent
// sessions can't race the same volume into corruption (tkt-76fcbfb608a4). The image entrypoint
// no-ops when the lockfile is unchanged, so steady-state this is a fast stamp check.
const depsInFlight = new Map<string, Promise<void>>();
function ensureDeps(roots: string[]): Promise<void> {
  const key = roots.join(':');
  let inFlight = depsInFlight.get(key);
  if (!inFlight) {
    inFlight = new Promise<void>((resolve) => {
      const args = ['run', '--rm', ...rootMountArgs(roots), IMAGE, 'true'];
      const proc = spawnChild('docker', args, { stdio: 'ignore', env: buildSessionEnv(process.env) });
      // Best-effort: on failure the interactive session still starts (degraded MCP, logged in-container).
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
    }).finally(() => depsInFlight.delete(key));
    depsInFlight.set(key, inFlight);
  }
  return inFlight;
}

// Containers still running, so an abrupt process exit doesn't orphan them (+ their in-container
// claude/MCP children). Normal detach/dispose is handled by the registry per-session.
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const entry of registry.values()) {
      try { execSync(`docker kill ${entry.containerName}`, { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  });
}

// Persistent HOME for the session, so login/onboarding survive between the --rm containers
// (no re-sign-in each time) — this captures ~/.claude AND ~/.claude.json, both of which
// hold sign-in state. Seeded by scripts/terminal-setup-cred.mjs and stored OUTSIDE any
// mounted project root, so the session can't read the token back through a project mount.
// Ensured to exist (incl. .claude/) so docker doesn't create it root-owned.
function credMount(): CredMount {
  const hostHome = process.env.KANBAN_TERMINAL_HOME ?? path.join(homedir(), '.kanban-terminal', 'home');
  mkdirSync(path.join(hostHome, '.claude'), { recursive: true, mode: 0o700 });
  return { hostHome, containerHome: '/kanban-home' };
}

// Host git identity so in-container commits are attributed correctly.
function gitIdentity(): { name: string; email: string } | undefined {
  try {
    const name = execSync('git config user.name', { encoding: 'utf8' }).trim();
    const email = execSync('git config user.email', { encoding: 'utf8' }).trim();
    if (name && email) return { name, email };
  } catch { /* no identity configured → git uses its own */ }
  return undefined;
}

function rejectSocket(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

export function attachTerminal(server: Server): void {
  installExitHook();
  // Echo the offered subprotocol (the token) so the browser completes the handshake.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => { const [first] = protocols; return first ?? false; },
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestPath = (req.url ?? '').split('?')[0];
    const protocol = req.headers['sec-websocket-protocol'];
    const token = typeof protocol === 'string' ? protocol : null;
    const origin = req.headers.origin;
    const sessionId = parseSessionParam(req.url ?? '');

    // A known live session id → reattach (cap does not apply). Everything else (incl. an unknown
    // or grace-expired id) → new session, subject to the cap.
    if (requestPath === WS_PATH && isValidSessionId(sessionId) && registry.has(sessionId)) {
      const decision = authorizeReattach({ origin, token, expected: terminalToken(), lookup: registry.lookup(sessionId) });
      if (!decision.ok) { rejectSocket(socket, decision.status, decision.reason); return; }
      wss.handleUpgrade(req, socket, head, (ws) => reattachSession(sessionId, ws));
      return;
    }

    // Free a slot from a lingering reload/closed-tab grace window before capping — a detached
    // session must never block a genuinely new terminal (only live, attached sessions count).
    if (registry.size() >= MAX_SESSIONS) registry.reapDetached();
    const decision = authorizeUpgrade({
      path: requestPath, wsPath: WS_PATH, origin, token, expected: terminalToken(),
      activeSessions: registry.size(), maxSessions: MAX_SESSIONS,
    });
    if (!decision.ok) {
      // 404 = not our path; leave the socket for other upgrade listeners (Vite HMR).
      if (decision.status === 404) return;
      rejectSocket(socket, decision.status, decision.reason);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The client mints the session id; fall back to a server id only if it sent none.
      const id = isValidSessionId(sessionId) ? sessionId : randomUUID();
      openSession(ws, req, id).catch(() => { try { ws.close(); } catch { /* noop */ } });
    });
  });
}

// Wire a socket's input/terminate handlers to its session (message frames only). Close is bound
// separately by each caller so a socket isn't double-bound. Shared by the new-session and
// reattach paths so both speak the same protocol.
function bindMessages(id: string, entry: TerminalEntry, ws: WebSocket): void {
  ws.on('message', (raw: RawData) => {
    const frame = parseClientFrame(raw.toString());
    if (!frame) return;
    if (frame.t === 'e') { registry.terminate(id); return; } // explicit close → dispose now, no grace
    const term = entry.pty;
    if (!term) return;
    // Guard the pty call: it may have exited between frames (write/resize would throw).
    try {
      if (frame.t === 'i') { term.write(frame.d); }
      else {
        // A real client resize is authoritative — cancel any pending reattach nudge-restore so it
        // can't revert the pty to stale pre-reload dimensions.
        registry.cancelNudge(id);
        term.resize(frame.cols, frame.rows);
      }
    } catch { /* pty gone — ignore */ }
  });
}

async function openSession(ws: WebSocket, req: IncomingMessage, id: string): Promise<void> {
  const ticket = parseTicketParam(req.url ?? '');
  const containerName = `kanban-term-${randomUUID().slice(0, 8)}`;
  // Reserve the slot synchronously so the cap can't be undercounted during async setup, and bind
  // close BEFORE the await so a disconnect mid-setup still frees the slot.
  const entry = registry.create(id, containerName, ws);
  ws.on('close', () => registry.detach(id, ws));

  let command: { cmd: string; args: string[]; prefill?: string; roots: string[] };
  try {
    command = await resolveSessionCommand({
      ticket, getTicket, projectRoots: projectRoots(), kanbanRoot: kanbanRoot(),
      credMount: credMount(), image: IMAGE, containerName, gitIdentity: gitIdentity(),
    });
  } catch (err) {
    // Bad/unknown ticket → tell the terminal and close, rather than spawn a shell silently.
    // Errors go to the CURRENT socket (a reload may have reattached during the await).
    const message = err instanceof Error ? err.message : 'failed to start session';
    const w = entry.currentWs;
    if (w && w.readyState === WebSocket.OPEN) { w.send(`\r\n[terminal] ${message}\r\n`); w.close(); }
    registry.disposeIfCurrent(id, entry);
    return;
  }

  // Install Linux deps (once, serialized) before the interactive session so it never runs in
  // the PTY. The client sees the "Loading…" overlay meanwhile.
  await ensureDeps(command.roots);

  // Torn down during setup (client vanished with no reattach) → stop. NOT keyed on the original
  // socket: a reload that reattached mid-boot swapped entry.currentWs and closed the old socket,
  // and we must CONTINUE booting so the reattached client gets a working session (tkt review #1/#2).
  if (entry.disposed) return;

  let term: pty.IPty;
  try {
    term = pty.spawn(command.cmd, command.args, {
      name: 'xterm-256color', cols: 80, rows: 24, env: buildSessionEnv(process.env),
    });
  } catch (err) {
    // e.g. node-pty's spawn-helper lacks +x → posix_spawnp failed. Don't leak the slot.
    const message = err instanceof Error ? err.message : 'failed to start terminal';
    const w = entry.currentWs;
    if (w && w.readyState === WebSocket.OPEN) { w.send(`\r\n[terminal] ${message}\r\n`); w.close(); }
    registry.disposeIfCurrent(id, entry);
    return;
  }
  registry.attachPty(id, term);

  // Type the ticket seed into claude's input box once its startup output settles (prefill runs on
  // the NEW-session path only — never on reattach). No trailing newline → editable, not submitted.
  if (command.prefill) setupPrefill(term, command.prefill, entry);

  // Route pty output via the ENTRY's current socket (looked up per-chunk), so a reattach rebinds
  // the stream without re-subscribing. Output produced while detached (currentWs null) is dropped
  // — acceptable; the reattach repaint restores the screen.
  term.onData((data) => {
    const w = entry.currentWs;
    if (w && w.readyState === WebSocket.OPEN) w.send(data);
  });
  term.onExit(({ exitCode, signal }) => {
    // The container/claude ended for real → dispose immediately (bypass grace). Log a non-zero
    // exit so a crash/misconfig is diagnosable server-side rather than a silent vanish. Guarded by
    // identity: if this entry was already replaced under a reused id, don't tear down its successor.
    if (exitCode) console.error(`[terminal] session ${id} (${containerName}) exited: code=${exitCode}${signal ? ` signal=${signal}` : ''}`);
    if (registry.get(id) === entry) {
      const w = entry.currentWs;
      if (w && w.readyState === WebSocket.OPEN) w.close();
    }
    registry.disposeIfCurrent(id, entry);
  });

  bindMessages(id, entry, ws);
}

// Rejoin a live session on a reloaded socket: rebind + repaint (registry.reattach), then wire the
// new socket's handlers. No prefill, no container work, and the client ?ticket is IGNORED — the
// container's roots/confinement were frozen at spawn and must not be re-derived from client input.
function reattachSession(id: string, ws: WebSocket): void {
  const entry = registry.reattach(id, ws);
  if (!entry) { try { ws.close(); } catch { /* noop */ } return; } // raced with disposal
  bindMessages(id, entry, ws);
  // A bare drop of THIS socket (another reload) → detach + grace; a newer reattach makes it a no-op.
  ws.on('close', () => registry.detach(id, ws));
}

// Prefill machinery: type the seed once claude's startup output settles (a quiet gap = the UI is
// ready and waiting). A cap covers the case where output never quiets. Torn down via entry.cleanup
// when the session disposes.
function setupPrefill(term: pty.IPty, seed: string, entry: TerminalEntry): void {
  let prefilled = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  // Held in an object because `clear` (below) closes over them before they're assigned.
  const timers: { sub?: pty.IDisposable; cap?: ReturnType<typeof setTimeout> } = {};
  const clear = () => {
    if (timers.sub) timers.sub.dispose();
    if (settle) clearTimeout(settle);
    if (timers.cap) clearTimeout(timers.cap);
  };
  const typeSeed = () => {
    if (prefilled || entry.disposed) return;
    prefilled = true;
    clear();
    try { term.write(seed); } catch { /* pty gone */ }
  };
  timers.sub = term.onData(() => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(typeSeed, 600);
  });
  timers.cap = setTimeout(typeSeed, 5000);
  entry.cleanup = clear;
}

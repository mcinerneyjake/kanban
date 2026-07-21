import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as pty from 'node-pty';
import { getTicket } from './tickets.js';
import { TERMINAL_STARTUP_FAILURE_CODE } from '../shared/constants.js';
import { projectRoots, kanbanRoot } from './terminalProjects.js';
import { terminalToken } from './terminalToken.js';
import {
  authorizeUpgrade, authorizeReattach, buildAttachArgs, buildSessionEnv, CONTAINER_NAME_PREFIX,
  dtachSocket, filterAdoptable, isValidSessionId, parseClientFrame, parseSessionParam, parseTicketParam,
  resolveSessionCommand, rootMountArgs, ROOT_LABEL_KEY, SESSION_LABEL_KEY, SESSION_CREATED_LABEL_KEY,
} from './terminalAuth.js';
import { TerminalRegistry, type TerminalEntry } from './terminalRegistry.js';
import { spawnDockerCli } from './terminalDocker.js';
import { startReaper } from './terminalReaper.js';
import { seedSessionHome, removeSessionHome } from './terminalHome.js';

// Bidirectional terminal transport (tkt-be809dd2b7fb): a WS on /terminal-ws whose bytes are piped,
// verbatim, to a node-pty that wraps `docker run -it` for a confined Claude Code session. Dev-only
// — attached from index.ts solely when KANBAN_TERMINAL=1. The security decision + framing are pure
// functions in terminalAuth (unit-tested); the session lifecycle is TerminalRegistry (unit-tested);
// this file is the I/O wiring around them.
//
// Detach/reattach (tkt-dd308ec91efc): a browser reload drops the WS but the pty/container survive
// server-side, keyed by a client-minted session id, and a reload REATTACHES rather than killing the
// session. Sessions also survive an Express restart (S3a, tkt-5b21136f3317): containers run detached
// with claude under dtach and are re-adopted from `docker ps` on boot. Known limitations: the browser
// widget doesn't yet auto-reconnect after a restart (the user reopens the terminal to trigger the
// reattach); quitting the dev server leaves containers until the next boot re-adopts+reaps them (or
// the reaper / `terminal:clean`); scrollback while detached isn't restored (the current screen is).

const WS_PATH = '/terminal-ws';
const MAX_SESSIONS = 2;
const GRACE_MS = 60_000;   // how long a detached (reloading) session waits to be reattached
const NUDGE_MS = 50;       // gap between the two-step SIGWINCH resize halves on reattach
const IMAGE = process.env.KANBAN_TERMINAL_IMAGE ?? 'kanban-terminal';

// Reaper (S3b, tkt-b4412f11b790): reconcile docker state against the registry to clean up orphaned
// session containers (a failed dispose-rm, or a prior process's containers a boot adoption didn't
// claim). Only orphans the registry doesn't track are ever removed — see terminalReaper.ts.
const REAPER_INTERVAL_MS = 5 * 60_000;
const REAPER_GRACE_MS = GRACE_MS;                 // spare an orphan younger than the reattach grace
const REAPER_MAX_AGE_MS = 12 * 60 * 60_000;       // 12h absolute cap — a session this old is a runaway
const REAPER_CAP = MAX_SESSIONS * 2;              // orphans beyond this (oldest-first) are reclaimed

// All `docker` CLI access goes through this seam — never a shell string (tkt-e1144d4ef7f5).
const docker = spawnDockerCli();

const registry = new TerminalRegistry({
  graceMs: GRACE_MS,
  nudgeMs: NUDGE_MS,
  killContainer: (name) => docker.remove(name),
  // Remove the session's isolated HOME when it disposes, so per-session copies don't accumulate (S4).
  cleanupSession: (id) => removeSessionHome(id),
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
    // Best-effort: on failure the interactive session still starts (degraded MCP, logged in-container).
    const args = ['run', '--rm', ...rootMountArgs(roots), IMAGE, 'true'];
    inFlight = docker.run(args, { env: buildSessionEnv(process.env) })
      .then(() => undefined)
      .finally(() => depsInFlight.delete(key));
    depsInFlight.set(key, inFlight);
  }
  return inFlight;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll until dtach has created its session socket inside the container (it does so at startup), so
// the first `dtach -a` attach can't race container boot. The window is generous because a COLD
// node_modules install (if ensureDeps silently failed) runs in the entrypoint before dtach starts;
// but if the container has EXITED (claude/dtach crashed immediately — `docker run -d` returns 0
// regardless), we fail fast instead of hanging the whole window (review of tkt-00dd79b261d7).
async function waitForDtachSocket(containerName: string, socket: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await docker.run(['exec', containerName, 'test', '-S', socket]) === 0) return true;
    // `exec` into a stopped container fails → the container died during startup; stop waiting.
    if (await docker.run(['exec', containerName, 'true']) !== 0) return false;
    await sleep(1000);
  }
  return false;
}

// Re-adopt session containers that outlived a previous Express process (a `tsx watch` restart), so
// a running Claude session survives the restart instead of being killed (S3a, tkt-5b21136f3317).
// Ran once at boot. Only OUR containers (name prefix + a valid id label) are adopted, and never a
// live entry. Adopted entries hold a grace timer, so any that nobody reattaches to is still reaped.
// NOTE (deliberate trade-off): with the old process-'exit' kill-all removed, quitting the dev server
// leaves detached containers running until the next boot re-adopts (then reaps) them, or S3b's
// reaper / `terminal:clean` removes them.
async function adoptRunningSessions(): Promise<void> {
  // Scope to THIS checkout's containers (kanban.root label) so a second dev server on the same
  // daemon isn't adopted (and later reaped) by us (review F3). Async so a hung daemon can't block
  // the event loop at boot (review G6).
  const rows = await docker.ps(
    SESSION_LABEL_KEY, SESSION_CREATED_LABEL_KEY,
    [SESSION_LABEL_KEY, `${ROOT_LABEL_KEY}=${kanbanRoot()}`], 'adoption',
  );
  const adoptable = filterAdoptable(rows, (id) => registry.has(id));
  // Cap adoption at MAX_SESSIONS (docker ps is newest-first): adopt the most recent, force-remove any
  // excess — with cap 2, extras for THIS root are crash-orphans, never live user sessions (review F6).
  adoptable.slice(0, MAX_SESSIONS).forEach(({ name, session }) => registry.adopt(session, name));
  // Force-remove the excess crash-orphans AND drop their isolated HOME dirs — once the container is
  // gone, neither the reaper nor `terminal:clean` (both docker-ps-driven) would ever revisit them, so
  // the token-bearing HOME would leak forever otherwise (S4 review F2). `session` is a valid UUID here.
  adoptable.slice(MAX_SESSIONS).forEach(({ name, session }) => { docker.remove(name); removeSessionHome(session); });
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
  // Re-adopt containers that survived a previous process (S3a), THEN arm the reaper (S3b). Ordering
  // matters: the reaper reaps orphans the registry doesn't track, so it must not run until adoption
  // has populated the registry — else a still-unadopted survivor would look like a reapable orphan.
  // adoptRunningSessions never rejects (docker.ps resolves [] on failure), so `.finally` always runs.
  let adoptionSettled = false;
  const adoptionDone = adoptRunningSessions().finally(() => {
    adoptionSettled = true;
    startReaper({
      docker,
      isTracked: (session) => registry.has(session),
      rootLabel: kanbanRoot(),
      config: { graceMs: REAPER_GRACE_MS, maxAgeMs: REAPER_MAX_AGE_MS, cap: REAPER_CAP },
      intervalMs: REAPER_INTERVAL_MS,
      onReaped: (session) => removeSessionHome(session), // drop the orphan's isolated HOME too (S4)
    });
  });
  // Echo the offered subprotocol (the token) so the browser completes the handshake.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => { const [first] = protocols; return first ?? false; },
  });

  // Route a terminal-path upgrade to reattach-or-new. Split out so the boot handler can DEFER it until
  // adoption has populated the registry (see the `upgrade` listener).
  const routeUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        reattachSession(sessionId, ws).catch(() => { try { ws.close(); } catch { /* noop */ } });
      });
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
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only terminal-path upgrades are ours — everything else (Vite HMR) must pass untouched to its
    // own listener, so filter FIRST and never defer a non-terminal socket.
    if ((req.url ?? '').split('?')[0] !== WS_PATH) return;
    // During the boot adoption window the registry isn't populated yet, so a reopened survivor would
    // wrongly route to the NEW-session path — spawning a duplicate container AND (S4) clobbering the
    // live survivor's per-session HOME, which seedSessionHome rm's before re-seeding. Defer terminal
    // upgrades until adoption settles so a reopen reattaches instead (also closes the S3a
    // reopen-during-boot gap). The window is short (one `docker ps`, ≤5s); a settled server routes
    // synchronously. Skip a socket the client already abandoned during the wait.
    if (adoptionSettled) { routeUpgrade(req, socket, head); return; }
    void adoptionDone.finally(() => { if (!socket.destroyed) routeUpgrade(req, socket, head); });
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
  const containerName = `${CONTAINER_NAME_PREFIX}${randomUUID().slice(0, 8)}`;
  // Reserve the slot synchronously so the cap can't be undercounted during async setup, and bind
  // close BEFORE the await so a disconnect mid-setup still frees the slot.
  const entry = registry.create(id, containerName, ws);
  ws.on('close', () => registry.detach(id, ws));

  const fail = (message: string) => {
    // Errors go to the CURRENT socket (a reload may have reattached during the await). Close with the
    // startup-failure code (not a bare close) so the client can tell a container that never started
    // from a clean session end and KEEP the widget with an error, rather than self-dismissing
    // (tkt-171759eb29f6). The message is written first so `docker logs` hints are visible server-side.
    const w = entry.currentWs;
    if (w && w.readyState === WebSocket.OPEN) { w.send(`\r\n[terminal] ${message}\r\n`); w.close(TERMINAL_STARTUP_FAILURE_CODE, 'startup failure'); }
    registry.disposeIfCurrent(id, entry);
  };

  let command;
  try {
    command = await resolveSessionCommand({
      ticket, sessionId: id, getTicket, projectRoots: projectRoots(), kanbanRoot: kanbanRoot(),
      createdAt: Date.now(), credMount: seedSessionHome(id), image: IMAGE, containerName, gitIdentity: gitIdentity(),
    });
  } catch (err) {
    // Bad/unknown ticket → tell the terminal and close, rather than spawn a shell silently.
    fail(err instanceof Error ? err.message : 'failed to start session');
    return;
  }

  // Install Linux deps (once, serialized) before the session so the container entrypoint's `npm ci`
  // no-ops and dtach/claude come up fast. The client sees the "Loading…" overlay meanwhile.
  await ensureDeps(command.roots);
  // Torn down during setup (client vanished with no reattach) → stop. NOT keyed on the original
  // socket: a reload that reattached mid-boot swapped entry.currentWs and closed the old socket,
  // and we must CONTINUE booting so the reattached client gets a working session (tkt review #1/#2).
  if (entry.disposed) return;

  // Start the DETACHED container (claude under dtach). `docker run -d` returns once it's launched;
  // claude then runs independent of any browser connection so it survives a reload (and, once S3a
  // lands, an Express restart).
  const runCode = await docker.run(command.runArgs, { env: buildSessionEnv(process.env) });
  // Disposed mid-run → the container may have been created AFTER dispose's rm -f no-op'd against a
  // not-yet-existing name; force-remove it by name now so it can't leak (review of tkt-00dd79b261d7).
  if (entry.disposed) { docker.remove(containerName); return; }
  if (runCode !== 0) { fail('failed to start session container'); return; }
  // A live container now exists — a reload from here on must reattach, not dispose it.
  entry.containerStarted = true;

  // Wait for dtach to create its socket before attaching (a fresh container needs a moment even
  // with deps pre-installed). Then a browser connection is a `docker exec … dtach -a` pty.
  const ready = await waitForDtachSocket(containerName, command.socket);
  if (entry.disposed) { docker.remove(containerName); return; }
  if (!ready) { fail(`session container did not become ready (see: docker logs ${containerName})`); return; }

  if (!spawnAttach(id, entry, command.attachArgs, containerName, command.prefill)) { fail('failed to start terminal'); return; }
  bindMessages(id, entry, ws);
}

// Spawn a fresh `docker exec … dtach -a` pty and wire it to the entry. Returns the pty, or null if
// node-pty can't spawn — the CALLER decides what a failure means (a new session fails; an adopted
// reattach leaves the container for a retry). Prefill runs on the new-session path only.
function spawnAttach(id: string, entry: TerminalEntry, attachArgs: string[], containerName: string, prefill?: string): pty.IPty | null {
  let term: pty.IPty;
  try {
    term = pty.spawn('docker', attachArgs, {
      name: 'xterm-256color', cols: 80, rows: 24, env: buildSessionEnv(process.env),
    });
  } catch (err) {
    // Log the real cause (e.g. spawn-helper lost +x → posix_spawnp/EACCES); the caller shows the
    // user a generic message, but the server must record why (review G4, log-external-failures rule).
    console.error('[terminal] pty spawn (docker exec) failed:', err instanceof Error ? err.message : err);
    return null; // caller handles: new session fails; adopted reattach leaves the container for a retry
  }
  registry.attachPty(id, term);
  if (prefill) setupPrefill(term, prefill, entry);
  // Route pty output via the ENTRY's current socket (looked up per-chunk), so a reattach rebinds
  // the stream without re-subscribing. Output while detached (currentWs null) is dropped.
  term.onData((data) => {
    const w = entry.currentWs;
    if (w && w.readyState === WebSocket.OPEN) w.send(data);
  });
  term.onExit(({ exitCode, signal }) => {
    // The container/claude ended → dispose immediately (bypass grace). Guarded by identity: don't tear
    // down a reused-id successor. A NON-ZERO exit is a crash/misconfig (claude died on launch, OOM):
    // log it AND close with the startup-failure code so the client surfaces an error and KEEPS the
    // widget, rather than a bare close (1005 → dismiss) that silently vanishes the failure
    // (tkt-171759eb29f6). A clean exit (code 0 — user typed exit / claude finished) stays a bare close.
    if (exitCode) console.error(`[terminal] session ${id} (${containerName}) exited: code=${exitCode}${signal ? ` signal=${signal}` : ''}`);
    if (registry.get(id) === entry) {
      const w = entry.currentWs;
      if (w && w.readyState === WebSocket.OPEN) {
        if (exitCode) w.close(TERMINAL_STARTUP_FAILURE_CODE, 'session crashed');
        else w.close();
      }
    }
    registry.disposeIfCurrent(id, entry);
  });
  return term;
}

// Rejoin a live session on a reloaded socket: rebind (registry.reattach), then wire the new socket's
// handlers. Three cases keyed off the entry: a NORMAL reload still has the persistent exec pty and
// just rebinds; a still-booting NEW session has no pty but openSession is its sole spawner (don't
// double-spawn, review F2); an ADOPTED survivor (restart) has no pty, so spawn a FRESH exec — but
// only after confirming the container is still alive (F5), and never disposing it on a transient
// spawn failure (F4). The client ?ticket is IGNORED — confinement was frozen at spawn.
async function reattachSession(id: string, ws: WebSocket): Promise<void> {
  const entry = registry.reattach(id, ws); // sync: cancel grace, rebind ws, close a stale socket
  if (!entry) { try { ws.close(); } catch { /* noop */ } return; } // raced with disposal
  bindMessages(id, entry, ws);
  ws.on('close', () => registry.detach(id, ws));

  if (entry.pty || !entry.adopted || entry.attaching) return; // reload / booting-new / already attaching
  entry.attaching = true;
  try {
    // The adopted container may have died during the grace window — confirm it's alive + dtach is
    // ready before attaching, so we don't flash a docker error and tear it down (review F5).
    const ready = await waitForDtachSocket(entry.containerName, dtachSocket(id), 30_000);
    if (entry.disposed) return;
    // Close the CURRENT socket (a newer reattach may have swapped it in — review G5) so it re-graces.
    const closeCurrent = () => { const w = entry.currentWs; if (w && w.readyState === WebSocket.OPEN) w.close(); };
    // Not ready → the container may be slow-but-alive; do NOT force-remove it (review G3). Re-grace and
    // let a later reattach retry; a genuinely-dead container is reaped by its grace timer.
    if (!ready) { closeCurrent(); return; }
    // Transient spawn failure → same: leave the container, re-grace so another reattach can retry (F4).
    if (!spawnAttach(id, entry, buildAttachArgs(entry.containerName, id), entry.containerName)) closeCurrent();
  } finally {
    entry.attaching = false;
  }
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

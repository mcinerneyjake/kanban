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
  authorizeUpgrade, buildSessionEnv, parseClientFrame, parseTicketParam, resolveSessionCommand, type CredMount,
} from './terminalAuth.js';

// Bidirectional terminal transport (tkt-be809dd2b7fb): a WS on /terminal-ws whose bytes
// are piped, verbatim, to a node-pty that wraps `docker run -it` for a confined Claude
// Code session. Dev-only — attached from index.ts solely when KANBAN_TERMINAL=1. The
// security decision + framing are pure functions in terminalAuth (unit-tested); this file
// is the I/O wiring around them.

const WS_PATH = '/terminal-ws';
const MAX_SESSIONS = 2;
const IMAGE = process.env.KANBAN_TERMINAL_IMAGE ?? 'kanban-terminal';

// Containers still running, so an abrupt process exit doesn't orphan them (+ their
// in-container claude/MCP children). Normal close is handled per-socket below.
const activeContainers = new Set<string>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const name of activeContainers) {
      try { execSync(`docker kill ${name}`, { stdio: 'ignore' }); } catch { /* already gone */ }
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

export function attachTerminal(server: Server): void {
  installExitHook();
  // Echo the offered subprotocol (the token) so the browser completes the handshake.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => { const [first] = protocols; return first ?? false; },
  });
  const sessions = new Set<WebSocket>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestPath = (req.url ?? '').split('?')[0];
    const protocol = req.headers['sec-websocket-protocol'];
    const decision = authorizeUpgrade({
      path: requestPath,
      wsPath: WS_PATH,
      origin: req.headers.origin,
      token: typeof protocol === 'string' ? protocol : null,
      expected: terminalToken(),
      activeSessions: sessions.size,
      maxSessions: MAX_SESSIONS,
    });
    if (!decision.ok) {
      // 404 = not our path; leave the socket for other upgrade listeners (Vite HMR).
      if (decision.status === 404) return;
      socket.write(`HTTP/1.1 ${decision.status} ${decision.reason}\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      openSession(ws, req, sessions).catch(() => { try { ws.close(); } catch { /* noop */ } });
    });
  });
}

async function openSession(ws: WebSocket, req: IncomingMessage, sessions: Set<WebSocket>): Promise<void> {
  sessions.add(ws); // reserve the slot synchronously so the session cap can't be undercounted
  const ticket = parseTicketParam(req.url ?? '');
  const containerName = `kanban-term-${randomUUID().slice(0, 8)}`;

  let term: pty.IPty | null = null;
  let disposed = false;
  // Pre-fill machinery (typed once claude's startup output settles); torn down with the session.
  let prefillSub: pty.IDisposable | undefined;
  let prefillSettle: ReturnType<typeof setTimeout> | undefined;
  let prefillCap: ReturnType<typeof setTimeout> | undefined;
  // Idempotent teardown, safe on every path (disconnect during setup, spawn failure, exit).
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (prefillSub) prefillSub.dispose();
    if (prefillSettle) clearTimeout(prefillSettle);
    if (prefillCap) clearTimeout(prefillCap);
    if (term) { try { term.kill(); } catch { /* already exited */ } }
    // Kill the container directly in case killing the pty leader didn't cascade to `docker run`.
    if (activeContainers.delete(containerName)) {
      spawnChild('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => { /* gone */ });
    }
    sessions.delete(ws);
  };
  // Attach BEFORE the await: a disconnect during async setup must still free the slot.
  ws.on('close', dispose);

  let command: { cmd: string; args: string[]; prefill?: string };
  try {
    command = await resolveSessionCommand({
      ticket, getTicket, projectRoots: projectRoots(), kanbanRoot: kanbanRoot(),
      credMount: credMount(), image: IMAGE, containerName, gitIdentity: gitIdentity(),
    });
  } catch (err) {
    // Bad/unknown ticket → tell the terminal and close, rather than spawn a shell silently.
    const message = err instanceof Error ? err.message : 'failed to start session';
    if (ws.readyState === WebSocket.OPEN) { ws.send(`\r\n[terminal] ${message}\r\n`); ws.close(); }
    dispose();
    return;
  }

  // Client vanished during the await → don't start a container for a dead socket.
  if (ws.readyState !== WebSocket.OPEN) { dispose(); return; }

  try {
    term = pty.spawn(command.cmd, command.args, {
      name: 'xterm-256color', cols: 80, rows: 24, env: buildSessionEnv(process.env),
    });
  } catch (err) {
    // e.g. node-pty's spawn-helper lacks +x → posix_spawnp failed. Don't leak the slot.
    const message = err instanceof Error ? err.message : 'failed to start terminal';
    if (ws.readyState === WebSocket.OPEN) { ws.send(`\r\n[terminal] ${message}\r\n`); ws.close(); }
    dispose();
    return;
  }
  activeContainers.add(containerName);

  // Type the ticket seed into claude's input box once its startup output settles (a quiet
  // gap = the UI is ready and waiting). No trailing newline → it pre-fills, editable, and is
  // NOT submitted. A cap covers the case where output never quiets.
  if (command.prefill) {
    const spawned = term;
    const seed = command.prefill;
    let prefilled = false;
    const typeSeed = () => {
      if (prefilled || disposed) return;
      prefilled = true;
      if (prefillSub) prefillSub.dispose();
      if (prefillSettle) clearTimeout(prefillSettle);
      if (prefillCap) clearTimeout(prefillCap);
      try { spawned.write(seed); } catch { /* pty gone */ }
    };
    prefillSub = spawned.onData(() => {
      if (prefillSettle) clearTimeout(prefillSettle);
      prefillSettle = setTimeout(typeSeed, 600);
    });
    prefillCap = setTimeout(typeSeed, 5000);
  }

  term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  term.onExit(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); dispose(); });

  ws.on('message', (raw: RawData) => {
    const frame = parseClientFrame(raw.toString());
    if (!frame || !term) return;
    // Guard the pty call: it may have exited between frames (write/resize would throw).
    try {
      if (frame.t === 'i') term.write(frame.d);
      else term.resize(frame.cols, frame.rows);
    } catch { /* pty gone — ignore */ }
  });
}

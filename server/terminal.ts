import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { execSync, spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as pty from 'node-pty';
import { getTicket } from './tickets.js';
import { projectRoots, kanbanRoot } from './terminalProjects.js';
import { terminalToken } from './terminalToken.js';
import {
  authorizeUpgrade, buildSessionEnv, parseClientFrame, resolveSessionCommand, type CredMount,
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

// Subscription credential mounted read-only into the container (created once by
// scripts/terminal-setup-cred.mjs) — kept off `env` so it can't leak on camera.
function credMount(): CredMount {
  const hostFile = process.env.KANBAN_TERMINAL_CRED ?? path.join(kanbanRoot(), '.terminal', 'credentials.json');
  return { hostFile, containerPath: '/root/.claude/.credentials.json' };
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
    wss.handleUpgrade(req, socket, head, (ws) => { void openSession(ws, req, sessions); });
  });
}

async function openSession(ws: WebSocket, req: IncomingMessage, sessions: Set<WebSocket>): Promise<void> {
  sessions.add(ws);
  const ticket = new URL(req.url ?? '', 'http://localhost').searchParams.get('ticket');
  const containerName = `kanban-term-${randomUUID().slice(0, 8)}`;

  let command: { cmd: string; args: string[] };
  try {
    command = await resolveSessionCommand({
      ticket, getTicket, projectRoots: projectRoots(), kanbanRoot: kanbanRoot(),
      credMount: credMount(), image: IMAGE, containerName, gitIdentity: gitIdentity(),
    });
  } catch (err) {
    // Bad/unknown ticket → tell the terminal and close, rather than spawn a shell silently.
    const message = err instanceof Error ? err.message : 'failed to start session';
    if (ws.readyState === WebSocket.OPEN) ws.send(`\r\n[terminal] ${message}\r\n`);
    ws.close();
    sessions.delete(ws);
    return;
  }

  const term = pty.spawn(command.cmd, command.args, {
    name: 'xterm-256color', cols: 80, rows: 24, env: buildSessionEnv(process.env),
  });
  activeContainers.add(containerName);

  term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  term.onExit(() => {
    activeContainers.delete(containerName);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    sessions.delete(ws);
  });

  ws.on('message', (raw: RawData) => {
    const frame = parseClientFrame(raw.toString());
    if (!frame) return;
    if (frame.t === 'i') term.write(frame.d);
    else term.resize(frame.cols, frame.rows);
  });

  ws.on('close', () => {
    try { term.kill(); } catch { /* already exited */ }
    // Belt-and-suspenders: kill the container directly in case killing the pty leader
    // didn't cascade to `docker run`.
    spawnChild('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => { /* gone */ });
    activeContainers.delete(containerName);
    sessions.delete(ws);
  });
}

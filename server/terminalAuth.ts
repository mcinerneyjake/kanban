import type { Ticket } from '../shared/constants.js';

// Pure core for the embedded terminal (tkt-be809dd2b7fb): WS-upgrade guards, the
// curated session env, filesystem-confinement roots, and the `docker run` argv.
// No I/O here — everything is a tested pure function so the security boundary is
// provable (each guard has a test that watches it reject).

// ── WS upgrade guards ────────────────────────────────────────────────────────

// Only same-machine dev origins may open a terminal socket. Browsers can't forge
// Origin, so this blocks drive-by connections from other sites — the primary gate.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3001',
]);

export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin !== undefined && ALLOWED_ORIGINS.has(origin);
}

// An empty expected token (misconfig) must never authorize — guard it explicitly
// rather than letting '' === '' pass.
export function isValidToken(provided: string | null | undefined, expected: string): boolean {
  return expected.length > 0 && provided === expected;
}

// ── Session environment (host `docker` process) ──────────────────────────────

// Allowlist for the env handed to the spawned `docker` CLI. An allowlist (not a
// denylist) means a secret-shaped host var can't leak through by omission — nothing
// enters unless named here. The container's own env is set separately in
// buildContainerArgs (and carries no secrets).
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL',
  // docker CLI daemon selection (colima/rootless/remote/Desktop) — not secrets. Without
  // these, `docker run` can fail to reach the daemon on non-default setups.
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
];

export function buildSessionEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.TERM = 'xterm-256color'; // correct color/rendering through the PTY → xterm.js
  return env;
}

// ── Confinement roots ────────────────────────────────────────────────────────

// The project directories a session may touch: the ticket's own project (if mapped)
// first, as the working dir, plus the kanban root (board MCP + workflow). No ticket,
// or an unmapped project → kanban-only. Never the whole disk.
export function allowedRootsFor(opts: {
  ticket: Ticket | null;
  projectRoots: Record<string, string>;
  kanbanRoot: string;
}): string[] {
  const roots: string[] = [];
  const project = opts.ticket?.project ?? null;
  const projectRoot = project ? opts.projectRoots[project] : undefined;
  if (projectRoot) roots.push(projectRoot);
  if (!roots.includes(opts.kanbanRoot)) roots.push(opts.kanbanRoot);
  return roots;
}

// ── docker run argv ──────────────────────────────────────────────────────────

export interface CredMount {
  hostHome: string;      // persistent host dir used as the container's HOME
  containerHome: string; // mount point inside the container (its HOME)
}

export function buildContainerArgs(opts: {
  roots: string[];
  credMount: CredMount;
  image: string;
  containerName: string;
  innerCmd: string[];
  gitIdentity?: { name: string; email: string };
}): string[] {
  const [primaryRoot] = opts.roots;
  if (primaryRoot === undefined) throw new Error('buildContainerArgs: roots must be non-empty');

  const args = ['run', '-it', '--rm', '--name', opts.containerName];
  // Only the allowed roots are mounted → everything else on the host is unreachable.
  for (const root of opts.roots) args.push('-v', `${root}:${root}`);
  // Persistent HOME so ALL of claude's state survives the --rm container — not just ~/.claude
  // but also ~/.claude.json (onboarding/account/trust), which lives in home. One whole-dir
  // mount (vs a single-file mount) survives claude's atomic-rename writes. Outside every
  // project mount, so the token still isn't reachable via a project's file tree; HOME isn't a secret.
  args.push('-v', `${opts.credMount.hostHome}:${opts.credMount.containerHome}`);
  args.push('-e', `HOME=${opts.credMount.containerHome}`);
  if (opts.gitIdentity) {
    const { name, email } = opts.gitIdentity;
    args.push(
      '-e', `GIT_AUTHOR_NAME=${name}`, '-e', `GIT_AUTHOR_EMAIL=${email}`,
      '-e', `GIT_COMMITTER_NAME=${name}`, '-e', `GIT_COMMITTER_EMAIL=${email}`,
    );
  }
  args.push('-w', primaryRoot, opts.image, ...opts.innerCmd);
  return args;
}

// ── Session resolution (id → validated ticket → seeded command) ──────────────

const TICKET_ID_RE = /^tkt-[0-9a-f]{12}$/;

export function buildSeedPrompt(ticket: Ticket): string {
  return `Start ticket ${ticket.id} — "${ticket.title}" — and follow the ticket workflow in CLAUDE.md.`;
}

export interface SessionCommand { cmd: string; args: string[] }

// ── WS upgrade authorization (pure decision, so the gate is testable) ─────────

export type UpgradeDecision = { ok: true } | { ok: false; status: number; reason: string };

// Ordered checks: wrong path (let HMR/others through) → origin → token → session cap.
// Returns a status so the caller can reply then destroy the socket. Fail-closed: any
// failed check returns { ok:false } — a green result requires every gate to pass.
export function authorizeUpgrade(opts: {
  path: string;
  wsPath: string;
  origin: string | undefined;
  token: string | null;
  expected: string;
  activeSessions: number;
  maxSessions: number;
}): UpgradeDecision {
  if (opts.path !== opts.wsPath) return { ok: false, status: 404, reason: 'not the terminal path' };
  if (!isAllowedOrigin(opts.origin)) return { ok: false, status: 403, reason: 'origin not allowed' };
  if (!isValidToken(opts.token, opts.expected)) return { ok: false, status: 403, reason: 'invalid token' };
  if (opts.activeSessions >= opts.maxSessions) return { ok: false, status: 503, reason: 'session limit reached' };
  return { ok: true };
}

// ── Client → server framing ──────────────────────────────────────────────────

export type ClientFrame = { t: 'i'; d: string } | { t: 'r'; cols: number; rows: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Largest terminal dimension we'll forward. Guards against absurd values; well above any real pane.
const MAX_DIM = 1000;

// Keystroke input ({t:'i',d}) or a resize ({t:'r',cols,rows}); anything else is dropped.
// Resize dims are clamped to positive integers ≤ MAX_DIM: node-pty's resize THROWS on 0/
// negative/NaN, and xterm's FitAddon legitimately computes 0×0 for a hidden pane (our
// minimize state) — an unclamped value there would crash the server.
export function parseClientFrame(raw: string): ClientFrame | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!isRecord(data)) return null;
  if (data.t === 'i' && typeof data.d === 'string') return { t: 'i', d: data.d };
  if (data.t === 'r' && typeof data.cols === 'number' && typeof data.rows === 'number') {
    const { cols, rows } = data;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
    return { t: 'r', cols: Math.min(cols, MAX_DIM), rows: Math.min(rows, MAX_DIM) };
  }
  return null;
}

export async function resolveSessionCommand(opts: {
  ticket?: string | null;
  getTicket: (id: string) => Promise<Ticket>;
  projectRoots: Record<string, string>;
  kanbanRoot: string;
  credMount: CredMount;
  image: string;
  containerName: string;
  gitIdentity?: { name: string; email: string };
}): Promise<SessionCommand> {
  let ticket: Ticket | null = null;
  if (opts.ticket) {
    // Validate the id shape before any lookup so a crafted value never reaches getTicket.
    if (!TICKET_ID_RE.test(opts.ticket)) throw new Error(`Invalid ticket id: ${opts.ticket}`);
    ticket = await opts.getTicket(opts.ticket); // throws if unknown → caller rejects the socket
  }
  const roots = allowedRootsFor({ ticket, projectRoots: opts.projectRoots, kanbanRoot: opts.kanbanRoot });
  // Always launch `claude` as the container's PID 1 — never a raw shell. The session IS the
  // Claude Code TUI; when it exits the container exits (no shell to drop into), so the user
  // can't run commands directly — everything goes through Claude's confined tools. Seeded
  // with the ticket when present, bare otherwise.
  const addDirs = roots.flatMap((root) => ['--add-dir', root]);
  const innerCmd = ticket
    ? ['claude', ...addDirs, buildSeedPrompt(ticket)]
    : ['claude', ...addDirs];
  const args = buildContainerArgs({
    roots,
    credMount: opts.credMount,
    image: opts.image,
    containerName: opts.containerName,
    innerCmd,
    gitIdentity: opts.gitIdentity,
  });
  return { cmd: 'docker', args };
}

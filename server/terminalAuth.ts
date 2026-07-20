import { createHash } from 'node:crypto';
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

// Docker volume name for a project root's node_modules. Hash the full path (not a lossy
// char-substitution, which could collide two distinct roots onto one volume → wrong deps).
function nodeModulesVolume(root: string): string {
  return `kanbanterm-nm-${createHash('sha1').update(root).digest('hex').slice(0, 16)}`;
}

// Shared mount set for a session OR install container: each allowed root (everything else on
// the host is unreachable) + its node_modules shadowed by a per-root NAMED volume (the host's
// is the wrong platform → the kanban MCP server would crash), + the install-dirs env the image
// entrypoint reads to populate those volumes. (tkt-76fcbfb608a4)
export function rootMountArgs(roots: string[]): string[] {
  const args: string[] = [];
  for (const root of roots) {
    args.push('-v', `${root}:${root}`);
    args.push('-v', `${nodeModulesVolume(root)}:${root}/node_modules`);
  }
  args.push('-e', `KANBAN_INSTALL_DIRS=${roots.join(':')}`);
  return args;
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

  const args = ['run', '-it', '--rm', '--name', opts.containerName, ...rootMountArgs(opts.roots)];
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

// The seed is TYPED into the pty as a prefill, so any control byte in the (board-controlled)
// title would act as a keystroke: CR/LF = Enter (auto-submitting the seed, defeating the
// "editable, not submitted" guarantee), ESC = a control sequence. Strip C0 controls + DEL and
// cap the length so no title can inject keystrokes or produce a pathological prefill. The id
// is already regex-validated hex, so only the title needs sanitizing.
function sanitizeForInput(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: matching control bytes in order to strip them
  return text.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 200);
}

export function buildSeedPrompt(ticket: Ticket): string {
  return `Start ticket ${ticket.id} — "${sanitizeForInput(ticket.title)}" — and follow the ticket workflow in CLAUDE.md.`;
}

// prefill: the ticket seed the transport types into claude's input box once it's ready (no
// trailing newline → editable, not auto-submitted). Absent for a bare (no-ticket) session.
// roots: the confinement roots — the transport pre-installs their node_modules before the
// interactive session (so the install never delays claude / mistimes the prefill).
export interface SessionCommand { cmd: string; args: string[]; prefill?: string; roots: string[] }

// Parse the ?ticket= param the widget puts on the WS URL (it encodeURIComponent's the board
// id). Shared with the server and the seam test so the client→server hop can't silently drift.
export function parseTicketParam(rawUrl: string): string | null {
  return new URL(rawUrl, 'http://localhost').searchParams.get('ticket');
}

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
  // Launch BARE `claude` as the container's PID 1 — never a raw shell, and never the ticket
  // as a positional prompt (that auto-submits). The ticket seed is returned as `prefill`,
  // which the transport types into the input box once claude is ready — editable, not run.
  // Confinement is enforced by the container mounts, so we don't pass --add-dir either.
  const args = buildContainerArgs({
    roots,
    credMount: opts.credMount,
    image: opts.image,
    containerName: opts.containerName,
    innerCmd: ['claude'],
    gitIdentity: opts.gitIdentity,
  });
  return { cmd: 'docker', args, prefill: ticket ? buildSeedPrompt(ticket) : undefined, roots };
}

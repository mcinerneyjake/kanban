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

// Docker label carrying the session id, so a restarted server can rediscover its running
// containers via `docker ps --filter label=…` and re-adopt them (S3a, tkt-5b21136f3317).
export const SESSION_LABEL_KEY = 'kanban.session';

// The dtach session socket inside the container (per session id). `claude` runs under
// `dtach -N <socket>`; each browser connection attaches via `dtach -a <socket>`, decoupling the
// exec stream from claude's lifetime so the session survives an Express restart (epic tkt-d7e129290ff7).
export function dtachSocket(sessionId: string): string {
  return `/tmp/kanban-term-${sessionId}.dtach`;
}

// Shared mount/HOME/git middle of the container argv (between the run flags and -w/image/cmd).
function containerBaseArgs(opts: {
  roots: string[];
  credMount: CredMount;
  gitIdentity?: { name: string; email: string };
}): string[] {
  const args = [...rootMountArgs(opts.roots)];
  // Persistent HOME so ALL of claude's state survives the container — not just ~/.claude but also
  // ~/.claude.json (onboarding/account/trust). One whole-dir mount survives claude's atomic-rename
  // writes. Outside every project mount, so the token isn't reachable via a project's file tree.
  args.push('-v', `${opts.credMount.hostHome}:${opts.credMount.containerHome}`);
  args.push('-e', `HOME=${opts.credMount.containerHome}`);
  if (opts.gitIdentity) {
    const { name, email } = opts.gitIdentity;
    args.push(
      '-e', `GIT_AUTHOR_NAME=${name}`, '-e', `GIT_AUTHOR_EMAIL=${email}`,
      '-e', `GIT_COMMITTER_NAME=${name}`, '-e', `GIT_COMMITTER_EMAIL=${email}`,
    );
  }
  return args;
}

// Detached run (tkt-00dd79b261d7): start the session container in the background with `claude` under
// `dtach -N` (create the session but do NOT attach, and stay in the foreground as the container's
// main process — `-c` would try to attach, which needs a terminal a `docker run -d` doesn't have).
// claude thus outlives any single browser connection. `--rm` is intentionally DROPPED — the
// container must persist independent of the `docker run` client; dispose force-removes it. The
// `kanban.session` label lets a restarted server rediscover the container (S3a). Bare `claude`,
// never a shell or a positional prompt (the seed is typed in as prefill); confinement is the mounts.
export function buildDetachedRunArgs(opts: {
  roots: string[];
  sessionId: string;
  credMount: CredMount;
  image: string;
  containerName: string;
  gitIdentity?: { name: string; email: string };
}): string[] {
  const [primaryRoot] = opts.roots;
  if (primaryRoot === undefined) throw new Error('buildDetachedRunArgs: roots must be non-empty');
  return [
    'run', '-d', '--name', opts.containerName, '--label', `${SESSION_LABEL_KEY}=${opts.sessionId}`,
    ...containerBaseArgs(opts),
    '-w', primaryRoot, opts.image,
    'dtach', '-N', dtachSocket(opts.sessionId), 'claude',
  ];
}

// Attach a fresh interactive pty to the running container's dtach session. `-r winch` makes dtach
// redraw claude's current screen via SIGWINCH on attach — so a reload/reattach repaints for free.
export function buildAttachArgs(containerName: string, sessionId: string): string[] {
  return ['exec', '-it', containerName, 'dtach', '-a', dtachSocket(sessionId), '-E', '-r', 'winch'];
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
export interface SessionCommand {
  runArgs: string[];    // `docker run -d …` — start the detached session container
  attachArgs: string[]; // `docker exec -it … dtach -a …` — stream a fresh pty from it
  socket: string;       // the dtach socket path inside the container (for the ready-probe)
  prefill?: string;
  roots: string[];
}

// Parse the ?ticket= param the widget puts on the WS URL (it encodeURIComponent's the board
// id). Shared with the server and the seam test so the client→server hop can't silently drift.
export function parseTicketParam(rawUrl: string): string | null {
  return new URL(rawUrl, 'http://localhost').searchParams.get('ticket');
}

// ── Reattach session identity (detach/reattach across browser reloads, tkt-dd308ec91efc) ─────

// The reattach session id is a client-minted crypto.randomUUID() (v4). It's a non-secret NAME,
// not a capability — reattach is still gated by origin + the per-boot token, so this only needs
// a shape guard (mirrors TICKET_ID_RE), never a secret comparison. v4: version nibble 4, variant
// nibble 8/9/a/b.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

// Parse the ?session= param the widget puts on the WS URL, mirroring parseTicketParam so the
// client→server identity hop is covered by the same seam test.
export function parseSessionParam(rawUrl: string): string | null {
  return new URL(rawUrl, 'http://localhost').searchParams.get('session');
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

// Reattach authorization for a browser reload rejoining a still-running session. The registry
// Map/timer stay in terminal.ts; only the *result* of the lookup is passed in as data, keeping
// this a pure decision. Same origin + token gate as authorizeUpgrade — reattach grants no new
// privilege (see the plan's security pass). The MAX_SESSIONS cap is NOT applied here: a reattach
// rejoins an existing entry and must never consume a second slot.
//
// lookup semantics:
//   'found'             — a detached entry waiting in its grace window → reattach.
//   'attached-elsewhere'— an entry whose socket is still bound (a reload race: the new WS beat the
//                         old close). Still authorized; terminal.ts resolves it last-writer-wins
//                         (per-tab sessionStorage + token gate mean this can only be the same tab
//                         reloading, not a hijack).
//   'not-found'         — no such live session (grace already expired). Defensive reject; the
//                         caller normally routes an unknown id to the new-session path instead.
export type ReattachLookup = 'found' | 'attached-elsewhere' | 'not-found';

export function authorizeReattach(opts: {
  origin: string | undefined;
  token: string | null;
  expected: string;
  lookup: ReattachLookup;
}): UpgradeDecision {
  if (!isAllowedOrigin(opts.origin)) return { ok: false, status: 403, reason: 'origin not allowed' };
  if (!isValidToken(opts.token, opts.expected)) return { ok: false, status: 403, reason: 'invalid token' };
  if (opts.lookup === 'not-found') return { ok: false, status: 404, reason: 'no such session' };
  return { ok: true };
}

// ── Client → server framing ──────────────────────────────────────────────────

// 'e' = an explicit terminate: the client is going away deliberately (✕ or a session swap), so
// the server disposes NOW, bypassing the reload grace window (a bare socket drop = a reload).
export type ClientFrame = { t: 'i'; d: string } | { t: 'r'; cols: number; rows: number } | { t: 'e' };

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
  if (data.t === 'e') return { t: 'e' };
  return null;
}

export async function resolveSessionCommand(opts: {
  ticket?: string | null;
  sessionId: string;
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
  const runArgs = buildDetachedRunArgs({
    roots,
    sessionId: opts.sessionId,
    credMount: opts.credMount,
    image: opts.image,
    containerName: opts.containerName,
    gitIdentity: opts.gitIdentity,
  });
  return {
    runArgs,
    attachArgs: buildAttachArgs(opts.containerName, opts.sessionId),
    socket: dtachSocket(opts.sessionId),
    prefill: ticket ? buildSeedPrompt(ticket) : undefined,
    roots,
  };
}

import { createHash } from 'node:crypto';
import type { Ticket } from '../shared/constants.js';
import { apiPort, webPort } from '../shared/ports.js';
import { MAX_INPUT_CHARS } from '../shared/terminalProtocol.js';

// Pure core for the embedded terminal (tkt-be809dd2b7fb): WS-upgrade guards, the
// curated session env, filesystem-confinement roots, and the `docker run` argv.
// No I/O here — everything is a tested pure function so the security boundary is
// provable (each guard has a test that watches it reject).

// ── WS upgrade guards ────────────────────────────────────────────────────────

// Only same-machine dev origins may open a terminal socket; browsers can't forge Origin. Ports come
// from shared/ports.ts so a KANBAN_PORT_OFFSET worktree isn't locked out (tkt-9ee5a1dfa141). Stays
// port-pinned, unlike the Host gate below — Origin is the page's own, so the ports are knowable.
export function isAllowedOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (origin === undefined) return false;
  const ports = [webPort(env), apiPort(env)];
  return ['localhost', '127.0.0.1'].some((host) => ports.some((port) => origin === `http://${host}:${port}`));
}

// Host gate for the whole API (tkt-fc40f49495c1; started life on GET /api/terminal/token,
// tkt-b6eb52013662). Origin can't do this job: browsers omit it on same-origin GETs, and a
// DNS-rebound page IS same-origin — which is also why the loopback bind does not help, the browser
// being on loopback itself. Host still carries the name the browser dialed — `evil.com` for a rebound
// page, never loopback. Matched on hostname only, deliberately port-blind: the Vite proxy may forward
// either its own or the API's Host, and KANBAN_PORT_OFFSET moves both, so pinning ports would break
// real setups without adding security (a port is not an authenticator). Parsing through URL
// normalizes ports, brackets and `user@host` tricks — a bare `localhost@evil.com` resolves to
// hostname evil.com and is rejected.
export function isAllowedHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    const { hostname } = new URL(`http://${host}`);
    // Two names `isLoopbackHost` accepts that must not pass as a DIALED name. That predicate answers
    // "does this URL point at this machine", which is the right question for `containerizeLoopbackUrl`
    // and the wrong one here — this gate asks what the browser typed, and only some of the loopback
    // space is ever typed.
    //
    // `0.0.0.0` reaches loopback services in browsers that never took the 2024 fix, without any name
    // needing to resolve — a way in that rebinding doesn't even require.
    if (hostname === '0.0.0.0') return false;
    // `*.localhost` is loopback only if the resolver honours RFC 6761. Where it doesn't — Safari, or
    // any attacker-influenced resolver — `x.localhost` is a name the attacker can publish, serve a
    // page from, and then rebind to 127.0.0.1: the one class of name this gate exists to refuse.
    if (hostname.endsWith('.localhost')) return false;
    return isLoopbackHost(hostname);
  } catch {
    return false; // unparseable Host is not a loopback Host
  }
}

// An empty expected token (misconfig) must never authorize — guard it explicitly
// rather than letting '' === '' pass.
export function isValidToken(provided: string | null | undefined, expected: string): boolean {
  return expected.length > 0 && provided === expected;
}

// ── Session environment (host `docker` process) ──────────────────────────────

// Allowlist for the env handed to the spawned `docker` CLI. An allowlist (not a
// denylist) means a secret-shaped host var can't leak through by omission — nothing
// enters unless named here.
//
// The container's own env is built by `containerBaseArgs` via `llmEnvArgs`. That argv used to carry
// endpoint URLs as `-e NAME=value`, so a credential in the URL was readable by any process able to
// list ours (`ps aux`) (tkt-281272b5ef77). It now carries NAMES ONLY, and the values ride this env —
// which is why the LLM values below are deliberate secret-bearing additions, and why "carries no
// secrets" is now true of the argv specifically, not of this env.
//
// LIMIT, so nobody reads more into the fix than it delivers: the value still lands in the container's
// environment, so `docker inspect` and `/proc/1/environ` show it either way. What changes is that it
// is no longer in the *host* process table for the container's whole lifetime.
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
  // Values for the name-only `-e` flags. Same source as the flags themselves (`llmContainerEnv`), so
  // a name can never be emitted without a value — which for `docker exec` would blank it.
  Object.assign(env, llmContainerEnv(parentEnv));
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

// Second label carrying the kanban repo root, so adoption is scoped to THIS server's checkout — a
// second dev server on the same Docker daemon can't adopt (and later reap) our containers, and vice
// versa. A restart of the same checkout has the same root, so it still re-adopts its own (review F3).
export const ROOT_LABEL_KEY = 'kanban.root';

// Third label carrying the container's creation time (epoch ms), so the reaper can compute an
// absolute age from `docker ps` alone — no locale/timezone parsing of docker's own timestamp
// string (S3b, tkt-b4412f11b790). The value is stamped by the caller (Date.now()) to keep
// buildDetachedRunArgs pure/testable.
export const SESSION_CREATED_LABEL_KEY = 'kanban.created';

// Prefix for every session container name — the marker adoption uses to recognize OUR containers.
export const CONTAINER_NAME_PREFIX = 'kanban-term-';

// Which discovered containers a booting server may adopt: only OUR containers (name prefix), with a
// valid session-id label, that aren't already tracked. Pure so the adoption gate is testable (F10).
// Root-scoping is enforced by the `docker ps` label filter upstream, so it isn't re-checked here.
export function filterAdoptable(
  rows: Array<{ name: string; session: string }>,
  isKnown: (id: string) => boolean,
): Array<{ name: string; session: string }> {
  return rows.filter((r) => r.name.startsWith(CONTAINER_NAME_PREFIX) && isValidSessionId(r.session) && !isKnown(r.session));
}

// The dtach session socket inside the container (per session id). `claude` runs under
// `dtach -N <socket>`; each browser connection attaches via `dtach -a <socket>`, decoupling the
// exec stream from claude's lifetime so the session survives an Express restart (epic tkt-d7e129290ff7).
export function dtachSocket(sessionId: string): string {
  return `/tmp/kanban-term-${sessionId}.dtach`;
}

// The host as seen from inside a container. Docker Desktop proxies this to the host's loopback; on
// Linux the --add-host below maps it to the bridge gateway, which reaches a host service only if that
// service binds beyond 127.0.0.1 (LM Studio: "serve on local network"). Not full parity — noted so a
// Linux ECONNREFUSED isn't mistaken for this alias being absent.
const CONTAINER_HOST_ALIAS = 'host.docker.internal';

// Mirrors agent/runtime/llm.ts + agent/retrieval/models.ts. Only ever used pre-rewrite, so what a
// container actually receives is the containerized form, never this.
const DEFAULT_HOST_ENDPOINT = 'http://localhost:1234/v1';

// A literal-spelling list missed most of the loopback space, so this tests the ranges instead
// (tkt-c0cf617fdcc4 review). URL.hostname has already normalized 127.1, 0177.0.0.1 and 2130706433 to
// 127.0.0.1, and always returns IPv6 bracketed — an unbracketed '::1' can never appear here.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // RFC 6761 reserves `localhost` and everything under `.localhost` as loopback.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // all of 127/8, not just 127.0.0.1
  const v6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (v6 === '::1') return true;
  // IPv4-mapped IPv6. URL normalizes ::ffff:127.0.0.1 to hex (::ffff:7f00:1), so match both: the
  // first hextet of a mapped 127/8 address is 0x7f00–0x7fff.
  if (v6.startsWith('::ffff:')) {
    const mapped = v6.slice('::ffff:'.length);
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mapped)) return true;
    if (/^7f[0-9a-f]{2}:/.test(mapped)) return true;
  }
  return false;
}

// Docker QUOTES the offending value (`%q`), so the real text is `add-host: "host-gateway"` — verified
// against docker 29.6.2, not guessed. Matching the phrase plus host-gateway anywhere on the same line
// covers quoted, unquoted and whole-pair spellings while still rejecting `add-host: "not-an-ip"`.
// An engine that words its rejection differently won't match and keeps the old hard failure
// (tkt-1cb370e16c55).
export function isHostGatewayRejection(stderr: string): boolean {
  return /invalid IP address in add-host:[^\n]*host-gateway/i.test(stderr);
}

// Two adjacent argv entries, matched on the exact value we emit so a foreign --add-host survives.
export function withoutHostGateway(args: readonly string[]): string[] {
  const i = args.indexOf('--add-host');
  if (i === -1 || args[i + 1] !== `${CONTAINER_HOST_ALIAS}:host-gateway`) return [...args];
  return [...args.slice(0, i), ...args.slice(i + 2)];
}

// Rewrite a host-loopback URL so a container can reach it (tkt-c0cf617fdcc4). Inside a container
// `localhost` is the container itself, so the agent's default endpoint resolves to nothing listening.
// Only loopback is rewritten — a LAN or remote endpoint is already reachable and must pass through
// untouched. An unparseable value is returned as-is rather than guessed at.
export function containerizeLoopbackUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  if (!isLoopbackHost(parsed.hostname)) return url;
  parsed.hostname = CONTAINER_HOST_ALIAS;
  return parsed.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
}

// The LLM endpoints a session container needs, taken from the HOST's own config so a custom endpoint
// carries through instead of being overridden by a second hardcoded default that could drift.
//
// An UNSET endpoint still emits the containerized default rather than nothing (tkt-c0cf617fdcc4
// review): `.env` is optional, and falling through to the agent's own `localhost` default is the one
// value guaranteed unreachable inside a container — so "emit nothing" would leave the default install,
// the exact case this exists to fix, still broken.
/**
 * The LLM values the container should receive — the SINGLE source for both the `-e` flag names and
 * the values `buildSessionEnv` hands the docker CLI (tkt-281272b5ef77).
 *
 * One function rather than two hardcoded lists tied by a comment: emitting a flag whose value nothing
 * supplies is not harmless, because `docker exec -e NAME` with NAME unset **clears** it inside the
 * container (verified on docker 29.6.2 — `run` skips it, `exec` blanks it). Deriving the flags from
 * the values makes that state unreachable.
 */
export function llmContainerEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  // Always present: an unset endpoint still needs the containerized default, because the agent's own
  // `localhost` fallback is the one address a container can never reach.
  for (const key of ['LLM_BASE_URL', 'EMBED_BASE_URL'] as const) {
    out[key] = containerizeLoopbackUrl(parentEnv[key]?.trim() || DEFAULT_HOST_ENDPOINT);
  }
  // Only when the host actually has one — see the exec-blanking note above.
  const apiKey = parentEnv.LLM_API_KEY?.trim();
  if (apiKey) out.LLM_API_KEY = apiKey;
  return out;
}

export function llmEnvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  // Endpoint URLs and the API key are passed by NAME ONLY (`-e LLM_BASE_URL`, no `=value`), so docker
  // reads the value from its own environment and it never enters the argv (tkt-281272b5ef77). argv is
  // world-readable through `ps aux`; the CLI process environment is not.
  //
  // Name-only rather than sanitizing the URL, because a credential can hide in userinfo OR in a query
  // parameter, and stripping the query would break the endpoint it was authenticating. Passing the
  // whole value out-of-band needs no guess about which part is the secret.
  //
  // Scope, deliberately: this closes the HOST process table. The container's own `Config.Env` still
  // holds the value and `docker inspect` still shows it — unavoidable while the agent reads it from
  // the environment, and gated behind docker-daemon access rather than being readable by any local user.
  //
  // Forwarding LLM_API_KEY at all is the other half of the fix: the agent reads it
  // (agent/runtime/llm.ts) but nothing ever sent it to the container, so embedding the credential in
  // the URL was the ONLY way to reach an authenticated endpoint. Stripping the URL without this would
  // break that use case rather than secure it.
  for (const key of Object.keys(llmContainerEnv(env))) args.push('-e', key);
  // Model ids are opaque strings — no loopback rewrite, and no invented default (unlike the endpoints
  // above). An unset host model means both host and container fall through to the SAME agent code
  // default, so forwarding nothing keeps them in agreement; emitting a guessed id would be the drift
  // this fixes. Forward only a non-empty host value — the exact mismatch case: host
  // LLM_MODEL=openai/gpt-oss-20b vs the agent default qwen/qwen3.5-9b (tkt-2c8af65c114e).
  for (const key of ['LLM_MODEL', 'EMBED_MODEL'] as const) {
    const value = env[key]?.trim();
    if (value) args.push('-e', `${key}=${value}`);
  }
  return args;
}

// Shared mount/HOME/git middle of the container argv (between the run flags and -w/image/cmd).
function containerBaseArgs(opts: {
  roots: string[];
  credMount: CredMount;
  gitIdentity?: { name: string; email: string };
  env?: NodeJS.ProcessEnv;
}): string[] {
  const args = [...rootMountArgs(opts.roots)];
  // Persistent HOME so ALL of claude's state survives the container — not just ~/.claude but also
  // ~/.claude.json (onboarding/account/trust). One whole-dir mount survives claude's atomic-rename
  // writes. Outside every project mount, so the token isn't reachable via a project's file tree.
  args.push('-v', `${opts.credMount.hostHome}:${opts.credMount.containerHome}`);
  args.push('-e', `HOME=${opts.credMount.containerHome}`);
  // Reach the host's LM Studio from inside the container. Docker Desktop resolves the alias itself;
  // --add-host makes the same name work on Linux, where it isn't provided (tkt-c0cf617fdcc4).
  args.push('--add-host', `${CONTAINER_HOST_ALIAS}:host-gateway`);
  args.push(...llmEnvArgs(opts.env));
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
  rootLabel: string; // the kanban repo root — scopes adoption to this checkout (kanban.root label)
  createdAt: number; // epoch ms stamped into the kanban.created label (reaper age); Date.now() at call site
  credMount: CredMount;
  image: string;
  containerName: string;
  gitIdentity?: { name: string; email: string };
  env?: NodeJS.ProcessEnv; // host env the container inherits its LLM endpoints from; defaults to process.env
}): string[] {
  const [primaryRoot] = opts.roots;
  if (primaryRoot === undefined) throw new Error('buildDetachedRunArgs: roots must be non-empty');
  return [
    'run', '-d', '--name', opts.containerName,
    '--label', `${SESSION_LABEL_KEY}=${opts.sessionId}`, '--label', `${ROOT_LABEL_KEY}=${opts.rootLabel}`,
    '--label', `${SESSION_CREATED_LABEL_KEY}=${opts.createdAt}`,
    ...containerBaseArgs(opts),
    '-w', primaryRoot, opts.image,
    'dtach', '-N', dtachSocket(opts.sessionId), 'claude',
  ];
}

// Attach a fresh interactive pty to the running container's dtach session. `-r winch` makes dtach
// redraw claude's current screen via SIGWINCH on attach — so a reload/reattach repaints for free.
// Re-supplies the LLM env on EVERY attach, not just at create (tkt-c0cf617fdcc4 review). A container
// adopted after an Express restart was built with whatever env existed then — possibly none — and
// `docker exec` is the only lever left, since --add-host is fixed at create. `-e` on exec covers the
// env half, so a reattached session picks up current config without being disposed and reopened.
export function buildAttachArgs(containerName: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return ['exec', '-it', ...llmEnvArgs(env), containerName, 'dtach', '-a', dtachSocket(sessionId), '-E', '-r', 'winch'];
}

// Reattach has no SessionCommand to read the pair off, so it builds both halves from ONE host env
// here rather than at the call site — the `-e NAME` flags and the values docker inherits cannot be
// sourced separately (tkt-281272b5ef77).
export function buildReattachCommand(
  containerName: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): AttachCommand {
  return { attachArgs: buildAttachArgs(containerName, sessionId, env), env: buildSessionEnv(env) };
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
// argv and the env docker inherits are ONE value, never two parameters. The `-e NAME` flags carry no
// values (tkt-281272b5ef77), so a call site free to supply a different env drops a custom endpoint on
// `run` and CLEARS it on `exec` — both halves separately correct, the pair silently wrong, and no
// unit test able to see it. Bundling them is what makes that unexpressible rather than merely untested.
export interface RunCommand {
  runArgs: string[];    // `docker run -d …` — start the detached session container
  env: Record<string, string>;
}
export interface AttachCommand {
  attachArgs: string[]; // `docker exec -it … dtach -a …` — stream a fresh pty from it
  env: Record<string, string>;
}
export interface SessionCommand extends RunCommand, AttachCommand {
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
  env?: NodeJS.ProcessEnv; // threaded so the ports → origin-gate path is pinnable without ambient env
}): UpgradeDecision {
  if (opts.path !== opts.wsPath) return { ok: false, status: 404, reason: 'not the terminal path' };
  if (!isAllowedOrigin(opts.origin, opts.env)) return { ok: false, status: 403, reason: 'origin not allowed' };
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
  env?: NodeJS.ProcessEnv;
}): UpgradeDecision {
  if (!isAllowedOrigin(opts.origin, opts.env)) return { ok: false, status: 403, reason: 'origin not allowed' };
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

// Largest input payload we'll write to a pty in one frame. Sits well above the client's paste cap,
// so it only fires for a client that skipped that guard — the client cap is UX, this is the boundary.
export { MAX_INPUT_CHARS };

// Keystroke input ({t:'i',d}) or a resize ({t:'r',cols,rows}); anything else is dropped.
// Resize dims are clamped to positive integers ≤ MAX_DIM: node-pty's resize THROWS on 0/
// negative/NaN, and xterm's FitAddon legitimately computes 0×0 for a hidden pane (our
// minimize state) — an unclamped value there would crash the server.
export function parseClientFrame(raw: string): ClientFrame | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!isRecord(data)) return null;
  if (data.t === 'i' && typeof data.d === 'string') {
    return data.d.length > MAX_INPUT_CHARS ? null : { t: 'i', d: data.d };
  }
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
  createdAt: number;
  credMount: CredMount;
  image: string;
  containerName: string;
  gitIdentity?: { name: string; email: string };
  // Threaded explicitly rather than left to the leaf default, so the host→argv path is pinnable in a
  // test instead of depending on ambient process.env (tkt-c0cf617fdcc4 review).
  env?: NodeJS.ProcessEnv;
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
    rootLabel: opts.kanbanRoot,
    createdAt: opts.createdAt,
    credMount: opts.credMount,
    image: opts.image,
    containerName: opts.containerName,
    gitIdentity: opts.gitIdentity,
    env: opts.env,
  });
  return {
    runArgs,
    attachArgs: buildAttachArgs(opts.containerName, opts.sessionId, opts.env),
    env: buildSessionEnv(opts.env ?? process.env),
    socket: dtachSocket(opts.sessionId),
    prefill: ticket ? buildSeedPrompt(ticket) : undefined,
    roots,
  };
}

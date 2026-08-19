import { lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Where the embedded terminal's credential SEED lives. Plain .mjs, not .ts, because
// scripts/terminal-setup-cred.mjs runs under bare `node` and cannot import TypeScript — while
// server/terminalHome.ts needs the same answer. Three call sites disagreeing is not academic
// (tkt-812b2b71acbe): the preflight checked the overridden path, the setup script wrote to the
// default, and #161's rmSync then wiped a directory unrelated to the seed in use.
export function seedHomePath(env = process.env) {
  return env.KANBAN_TERMINAL_HOME ?? path.join(homedir(), '.kanban-terminal', 'home');
}

// Per-session HOMEs live in a sibling of the seed, so the override moves both together.
export function sessionsRootPath(env = process.env) {
  return path.join(path.dirname(seedHomePath(env)), 'sessions');
}

// `claude setup-token` values are `sk-ant-oat…` + ~100 chars. The length floor sits far below the
// observed 108–110 so a real token can never trip it — it catches a paste that grabbed a fragment.
// `oat` (not the full `oat01`) tolerates a future version bump; `sk-ant-` alone would NOT, because it
// also matches an API key `sk-ant-api03-…`, the single most likely wrong clipboard (tkt-bfb3bc9f98d4).
const TOKEN_PREFIX = 'sk-ant-oat';
const MIN_TOKEN_LENGTH = 40;

// Shared so the writer (terminal-setup-cred) and the reader (preflight's describeSeedCredential)
// agree on what a usable token looks like — otherwise the preflight keeps calling a seed "stable"
// that the seeder would have refused to write. `force` is the escape hatch for a legitimate token
// whose shape changes before this code does.
export function validateSetupToken(token, { force = false } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'No token provided.' };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, reason: `Token is only ${token.length} characters — that looks like a truncated paste, not a setup-token.` };
  }
  // DO NOT reject embedded whitespace. It looks like a truncated paste, and `readline.question`
  // returning only the first line makes that a real risk — but real tokens contain internal
  // whitespace, so it cannot discriminate. Measured against the live working credential: raw length
  // 110, trimmed length 110 (so it is not edge whitespace), and a whitespace match survives the trim.
  // The rule shipped in tkt-bfb3bc9f98d4 and locked that token out entirely, since `force` was
  // deliberately not allowed to override it (tkt-7b21fb0b3307). The truncation risk is real and is
  // addressed at its source instead — see tkt-dba03a3b6bda.
  if (!token.startsWith(TOKEN_PREFIX) && !force) {
    return { ok: false, reason: `Token does not start with "${TOKEN_PREFIX}" — an API key (sk-ant-api…) or a URL is the usual mistake here. Re-run with --force if you are certain it is correct.` };
  }
  return { ok: true, reason: null };
}

// ── Seed size budget (tkt-ce65b2532e47) ──────────────────────────────────────
//
// `seedSessionHome` copies this directory WHOLE into a fresh HOME on every session start, so anything
// that lands in the template is paid for on every session, forever. It reached 502 MB once — a
// pre-S4 session's `.local/share/claude` install, back when the seed was mounted read-write — and
// nothing noticed: not the preflight, not `terminal:clean`, not session start (tkt-c3e9c928bcec).
//
// The budget sits here, beside the path, for the same reason the path does: two consumers (session
// start and the dev preflight) reading two different numbers is the drift tkt-812b2b71acbe paid for.
// 50 MB is ~5x the largest healthy reading (8.9 MB, straight after that cleanup; 56 KB once the
// re-seed prune landed) and ~10x under the observed pollution, so ordinary growth cannot trip it.
export const SEED_SIZE_WARN_BYTES = 50 * 1024 * 1024;

// Bytes are only half of "what does the copy cost" — a seed bloated by FILE COUNT copies slowly while
// measuring healthy, and walking it would block session start and `npm run dev`, whose preflight
// promises never to hang. Exceeding this aborts the walk into the unknown-size warning, which is the
// right verdict either way: a template holding this many entries is polluted by definition.
export const SEED_ENTRY_LIMIT = 20_000;

// Sum the bytes cpSync would copy. Three deliberate choices:
//   lstat, never stat — cpSync defaults to `dereference: false`, so a symlink costs the LINK, not its
//   target. Following it would fire this guard on a seed that copies twenty bytes.
//   lstat decides directory-ness, NOT Dirent.isDirectory() — that reads libuv's d_type, which is
//   UV_DIRENT_UNKNOWN on filesystems that do not report it (XFS with ftype=0, several FUSE/NFS
//   mounts, and $HOME is exactly where a network mount turns up). isDirectory() then answers false
//   for a real directory, so the walk would lstat it and never recurse — silently undercounting the
//   nested .local/share/claude bloat this guard exists for. The file branch already lstats, so
//   deciding from the same stat costs nothing.
//   THROWS on an unreadable entry rather than skipping it — a skipped entry undercounts, and an
//   undercount is the permissive answer from a guard whose whole subject is an unnoticed 502 MB.
export function measureDirBytes(dir, remaining = { entries: SEED_ENTRY_LIMIT }) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (--remaining.entries < 0) {
      throw new Error(`the seed holds more than ${SEED_ENTRY_LIMIT} entries, so the walk was abandoned — a template that large by file COUNT is polluted too, and every session start copies all of it`);
    }
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    total += stat.isDirectory() ? measureDirBytes(full, remaining) : stat.size;
  }
  return total;
}

// I/O half. An ABSENT seed is not a size fault: there is nothing to copy, and describeSeedCredential
// already reports the missing credential — so it reads as 0. A read FAILURE is an error and must
// never read as 0, which is the same answer as a healthy empty seed.
//
// statSync, NOT existsSync: existsSync answers `false` for ANY stat failure — an unreadable ancestor
// (EACCES), a symlink loop (ELOOP), ENAMETOOLONG — so it erases the very distinction this function is
// built on, and a 60 MB seed under a chmod-000 parent measured "✓ 0 B". statSync returns undefined
// only for a genuine ENOENT and throws everything else into the error branch below.
export function measureSeedSize(env = process.env) {
  const dir = seedHomePath(env);
  try {
    if (statSync(dir, { throwIfNoEntry: false }) === undefined) return { dir, bytes: 0, error: null };
    return { dir, bytes: measureDirBytes(dir), error: null };
  } catch (err) {
    return { dir, bytes: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// Decision half — inputs to a verdict, no I/O, so the thresholds are unit-testable. Mirrors
// describeSeedCredential's { level, message } shape; the preflight prints ✓/⚠ from it and
// seedSessionHome logs only the warn.
export function describeSeedSize({ bytes, error = null, dir = '', warnBytes = SEED_SIZE_WARN_BYTES } = {}) {
  const where = dir ? ` (${dir})` : '';
  const copied = 'Every embedded-terminal session start copies this directory whole.';
  if (error) {
    return { level: 'warn', message: `could not measure the terminal seed home${where}: ${error} — its size is UNKNOWN, not fine. ${copied}` };
  }
  // A caller handing us a non-measurement must not fall through to the comparison below: `null > n`
  // is false, so an unmeasured seed would render as a passing one — the permissive answer again.
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return { level: 'warn', message: `terminal seed home${where} was not measured (got ${JSON.stringify(bytes)}) — treat its size as unknown. ${copied}` };
  }
  // The budget is a public knob (tests inject one), and it was the single input this function did not
  // validate: `502e6 > NaN` is false, so a garbage budget rendered a 502 MB seed as healthy — the same
  // permissive-on-garbage shape guarded against two lines up.
  if (typeof warnBytes !== 'number' || !Number.isFinite(warnBytes) || warnBytes < 0) {
    return { level: 'warn', message: `terminal seed home${where} was not checked: the size budget is ${JSON.stringify(warnBytes)}, not a usable number. ${copied}` };
  }
  if (bytes > warnBytes) {
    return {
      level: 'warn',
      message: `terminal seed home${where} is ${formatBytes(bytes)}, over the ${formatBytes(warnBytes)} budget — ${copied} The seed is a template: a credential plus a little config, so something has polluted it. Find it with \`du -sh ${dir || seedHomePath()}/.[!.]* ${dir || seedHomePath()}/*\`; re-running scripts/terminal-setup-cred.mjs prunes the seed back to SEED_HOME_KEEP.`,
    };
  }
  return { level: 'ok', message: `\u2713 terminal seed home is ${formatBytes(bytes)} (budget ${formatBytes(warnBytes)})` };
}

// Seed-home pruning keep-lists (tkt-fc6f493e2033). Both setup scripts (terminal-setup-cred +
// terminal-setup-github) prune the seed home to a template, so they must agree on ONE union of
// top-level entries — otherwise re-seeding Claude wipes the GitHub auth, or vice versa. Centralized
// here (not duplicated in each script) so the two can't drift, the same reason the seed PATH lives here.
//   .claude / .claude.json — Claude credential + onboarding state
//   .config / .gitconfig    — GitHub auth (gh hosts.yml under .config/gh, git credential+insteadOf)
export const SEED_HOME_KEEP = ['.claude', '.claude.json', '.config', '.gitconfig'];
// Inside .claude/, keep only the credential + settings (used by the Claude script alone).
export const SEED_CLAUDE_KEEP = ['.credentials.json', 'settings.json'];

// GitHub PAT shapes: `github_pat_…` (fine-grained, ~93 chars) and `ghp_…` (classic, 40). The length
// floor catches a truncated paste while clearing a 40-char classic token. A FINE-GRAINED, repo-scoped
// token is strongly preferred (least authority) — `force` is the escape hatch if GitHub changes the
// prefix. Mirrors validateSetupToken so the writer (terminal-setup-github) and any reader agree.
const GITHUB_TOKEN_PREFIXES = ['github_pat_', 'ghp_'];
const MIN_GITHUB_TOKEN_LENGTH = 30;

export function validateGithubToken(token, { force = false } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, reason: 'No token provided.' };
  }
  if (token.length < MIN_GITHUB_TOKEN_LENGTH) {
    return { ok: false, reason: `Token is only ${token.length} characters — that looks like a truncated paste, not a GitHub PAT.` };
  }
  if (!GITHUB_TOKEN_PREFIXES.some((p) => token.startsWith(p)) && !force) {
    return { ok: false, reason: 'Token does not start with "github_pat_" (fine-grained) or "ghp_" (classic) — a fine-grained, repo-scoped token is strongly preferred. Re-run with --force if you are certain it is correct.' };
  }
  return { ok: true, reason: null };
}

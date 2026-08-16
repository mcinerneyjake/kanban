#!/usr/bin/env node
// One-time local setup for the embedded terminal (tkt-be809dd2b7fb).
// Turns a `claude setup-token` SUBSCRIPTION token into the credentials.json the container
// mounts read-only — so auth works with no API billing and the token never appears in `env`.
//
// Usage (keep the token off your shell history / this repo):
//   claude setup-token            # in your own terminal; copy the printed token
//   node scripts/terminal-setup-cred.mjs   # paste when prompted (hidden), then Ctrl-D
// or pipe it:  printf '%s' "$TOKEN" | node scripts/terminal-setup-cred.mjs
//
// Ctrl-D, not Enter, ends the interactive paste (tkt-dba03a3b6bda): Enter used to submit, which
// meant a token pasted across lines was cut at the first newline and the rest silently dropped.
//   --force    accept a token whose prefix isn't recognized (see validateSetupToken)
//
// Seeds <seed home>/.claude/.credentials.json (mode 0600, dir 0700). That home dir is the read-only
// SEED/template: each session gets its own COPY of it as HOME (S4, tkt-db09c3a52655), so concurrent
// sessions can't corrupt a shared ~/.claude.json and one session can't tamper another's auth. Kept
// OUTSIDE the repo so the in-container session can't read the raw token via a project mount.
//
// The ONLY sanctioned way to seed (tkt-ea48dbc56f19). Never `/login` into the seed home: sessions
// only COPY the seed, so a refreshable credential's refresh lands in a throwaway copy and the seed
// rots into "login expired" (tkt-da1caf5316f7). Re-seeding resets the home to credentials-only.
import { mkdirSync, writeFileSync, chmodSync, rmSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { seedHomePath, validateSetupToken, SEED_HOME_KEEP, SEED_CLAUDE_KEEP } from '../shared/terminalSeed.mjs';

export async function readToken({ input = process.stdin, output = process.stdout, isTTY = process.stdin.isTTY } = {}) {
  if (!isTTY) {
    // piped input
    const chunks = [];
    for await (const c of input) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = readline.createInterface({ input, output, terminal: true });
  rl._writeToOutput = () => {}; // suppress echo — set before the prompt, which is written directly
  output.write('Paste your `claude setup-token` token, then press Ctrl-D (input is hidden): ');
  const { token, lineCount } = await assemblePastedLines(rl);
  rl.close();
  // Line count + length, never the token: a paste that arrived wrapped is otherwise INVISIBLE — the
  // old failure was a credential that looked fine, validated, and did not work.
  output.write(`\nRead ${lineCount} line(s), ${token.length} characters.\n`);
  return token;
}

/**
 * Assemble a paste that may span several lines. EOF is the terminator, which is what makes this
 * symmetric with the piped branch above; `rl.question` stopped at the first newline and discarded
 * everything after it (tkt-dba03a3b6bda).
 *
 * Joined with '\n' — the lines are preserved, not silently welded together. Stripping the newlines
 * would "repair" a wrapped paste, but it would also corrupt a token whose own internal whitespace is
 * a newline, and that cannot be ruled out: the measurement behind `tkt-7b21fb0b3307` established
 * real tokens contain internal whitespace but never identified WHICH character, and its own summary
 * records that the confirming read was blocked. So this preserves the input and lets the validator
 * judge it; a reader must not invent a repair it cannot verify.
 *
 * Pure over any async iterable of lines, so it is testable without a TTY — the reason this defect
 * survived is that nothing could drive the interactive branch. `lineCount` is returned rather than
 * derived from the token, because the trim can drop trailing blank lines the user did type.
 */
export async function assemblePastedLines(lines) {
  const collected = [];
  for await (const line of lines) collected.push(String(line));
  return { token: collected.join('\n').trim(), lineCount: collected.length };
}

// Replace the credential FILE atomically, then prune everything around it. There is deliberately no
// directory swap: POSIX cannot swap two directories atomically, so the earlier staging/retired dance
// had a window where a crash left NO seed at all, plus fixed scratch paths a second run would delete
// out from under the first (tkt-bfb3bc9f98d4 review). rename() over a single file has no such window
// — readers see the old credential or the new one, never neither.
//
// Pruning afterwards keeps the seed a small template rather than an accumulating home
// (tkt-ea48dbc56f19). It runs last on purpose: a crash mid-prune leaves stale files beside a valid
// credential, which is untidy, not broken.
//
// It keeps CONFIG and drops STATE. tkt-ea48dbc56f19 wiped everything, on the rationale that
// "accumulated .claude.json/session state is how rotating credentials crept back in" — but the token
// lives in .credentials.json, and .claude.json holds onboarding flags, theme and caches, no
// refreshable credential. The rot came from `/login` writing .credentials.json directly. So wiping
// config bought no safety and cost every session its onboarding state (tkt-bfb3bc9f98d4).
//
// SEED_HOME_KEEP / SEED_CLAUDE_KEEP are centralized in shared/terminalSeed.mjs (tkt-fc6f493e2033):
// SEED_HOME_KEEP now also lists .config/.gitconfig so a Claude re-seed preserves the GitHub auth that
// terminal-setup-github seeds alongside — the two scripts share one union or they wipe each other.
export function installSeed(seedHome, credentials) {
  const claudeDir = path.join(seedHome, '.claude');
  const target = path.join(claudeDir, '.credentials.json');
  const tmp = path.join(claudeDir, `.credentials.json.tmp-${process.pid}`);
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  chmodSync(claudeDir, 0o700); // enforce even if the dir pre-existed with looser perms

  try {
    writeFileSync(tmp, JSON.stringify(credentials), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target); // atomic: the credential is never missing
  } finally {
    // A failed write must not leave a live token lying in an unmanaged temp file.
    rmSync(tmp, { force: true });
  }

  keepOnly(seedHome, SEED_HOME_KEEP);
  keepOnly(claudeDir, SEED_CLAUDE_KEEP);
}

function keepOnly(dir, keep) {
  for (const entry of readdirSync(dir)) {
    if (!keep.includes(entry)) rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function main() {
  const force = process.argv.includes('--force');
  const token = await readToken();
  const verdict = validateSetupToken(token, { force });
  if (!verdict.ok) { console.error(verdict.reason); process.exit(1); }

  // Claude Code's OAuth credential shape (verified to authenticate on the subscription).
  // refreshToken:'' is load-bearing — it's what survives being copied, and the preflight's "stable" tell.
  // The +10y expiry is a LOCAL stamp only: a setup-token really lasts ~1y server-side, so the seed can
  // die while this still claims a decade — nothing local can detect that, only a live session.
  const expiresAt = (Math.floor(Date.now() / 1000) + 315_360_000) * 1000; // +10y, ms
  const credentials = {
    claudeAiOauth: { accessToken: token, refreshToken: '', expiresAt, scopes: ['user:inference'] },
  };

  const seedHome = seedHomePath();
  installSeed(seedHome, credentials);
  console.log(`Replaced ${seedHome} with a credentials-only seed (0600). The terminal will mount it read-only.`);
  console.log('Open a terminal session to confirm — a setup-token\'s real expiry is only visible in use.');
}

// Run the I/O only when invoked directly, so installSeed/main stay importable by tests. Compare
// REAL paths: node resolves symlinks for import.meta.url but sets argv[1] via path.resolve, so a
// plain href comparison silently no-ops when the script is run through a symlink (a ~/bin shim, an
// npm bin link) — exit 0, no output, and the user believes a rotation happened (tkt-bfb3bc9f98d4
// review). Resolving both makes the symlinked invocation simply work, which is the behavior a user
// invoking it expects; a genuine `import` still leaves it silent.
const selfPath = fileURLToPath(import.meta.url);
const invokedReal = process.argv[1] ? (() => {
  try { return realpathSync(process.argv[1]); } catch { return null; }
})() : null;
if (invokedReal === selfPath) {
  await main();
}

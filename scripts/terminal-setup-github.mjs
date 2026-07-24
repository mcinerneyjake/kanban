#!/usr/bin/env node
// One-time local setup for GitHub-in-terminal (tkt-fc6f493e2033). Seeds a scoped GitHub PAT into the
// embedded terminal's HOME seed so an in-container session can `git push` + `gh pr create` — WITHOUT
// the token ever touching the docker argv (it rides in via the mounted HOME, like the Claude token),
// and WITHOUT SSH (git remotes are rewritten to HTTPS, sidestepping host-key verification).
//
// Least authority BY DESIGN: use a GitHub FINE-GRAINED PAT scoped to ONLY this repo, permissions
// Contents: Read+Write (push) and Pull requests: Read+Write (open PR). NOT merge — the container never
// merges; that stays a human decision. Give it an expiry; revoke instantly if it ever appears on screen.
//
// Usage (keep the token off your shell history):
//   node scripts/terminal-setup-github.mjs [--user <github-username>]     # paste when prompted (hidden)
//   printf '%s' "$PAT" | node scripts/terminal-setup-github.mjs --user <github-username>
//   --force   accept a token whose prefix isn't recognized (see validateGithubToken)
//
// Seeds <seed home>/.config/gh/hosts.yml (0600) + <seed home>/.gitconfig (0600). The seed home is the
// read-only TEMPLATE each session COPIES as HOME (S4), and lives OUTSIDE the repo so a session can't
// read the raw token via a project mount. Re-running this preserves the Claude credential and vice
// versa — both scripts prune to the shared SEED_HOME_KEEP (shared/terminalSeed.mjs).
import { mkdirSync, writeFileSync, chmodSync, rmSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { seedHomePath, validateGithubToken, SEED_HOME_KEEP } from '../shared/terminalSeed.mjs';

async function readToken() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await new Promise((resolve) => {
    rl.question('Paste your GitHub fine-grained PAT (hidden): ', resolve);
    rl._writeToOutput = () => {}; // suppress echo — the token must not land on screen/scrollback
  });
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

// gh's hosts.yml (2.x). `user` is optional — gh fills it from the API on first use if omitted — so a
// bad/absent username never blocks auth; the oauth_token is what authenticates. git_protocol:https
// pairs with the .gitconfig rewrite so every remote goes over HTTPS-with-token, not SSH.
export function buildHostsYml(token, user) {
  return [
    'github.com:',
    `    oauth_token: ${token}`,
    ...(user ? [`    user: ${user}`] : []),
    '    git_protocol: https',
    '',
  ].join('\n');
}

// git config for the seed HOME (~/.gitconfig inside the container). Two things:
//  - credential helper delegates HTTPS auth to `gh` (installed in the image) — so the token lives in
//    ONE place (hosts.yml), never a second .git-credentials copy.
//  - url.insteadOf rewrites SSH remotes to HTTPS at git-time, so the host worktree's `git@github.com:`
//    origin pushes over HTTPS with the token and never hits SSH host-key verification (tkt-683a7651c716).
export function buildGitconfig() {
  return [
    '[credential "https://github.com"]',
    '\thelper = !gh auth git-credential',
    '[url "https://github.com/"]',
    '\tinsteadOf = git@github.com:',
    '\tinsteadOf = ssh://git@github.com/',
    '',
  ].join('\n');
}

// Atomic single-file write at `mode`: a crash mid-write leaves the old file or the new one, never a
// half-written credential (mirrors terminal-setup-cred's installSeed).
function writeFileAtomic(target, contents, mode) {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function keepOnly(dir, keep) {
  for (const entry of readdirSync(dir)) {
    if (!keep.includes(entry)) rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

// Write the GitHub auth into the seed home, then prune to the shared keep-list so the Claude
// credential (.claude/.claude.json) survives — and a later Claude re-seed likewise preserves this.
export function installGithubSeed(seedHome, { token, user }) {
  const configDir = path.join(seedHome, '.config');
  const ghDir = path.join(configDir, 'gh');
  mkdirSync(ghDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700); // enforce even if .config pre-existed looser
  chmodSync(ghDir, 0o700);
  writeFileAtomic(path.join(ghDir, 'hosts.yml'), buildHostsYml(token, user), 0o600);
  writeFileAtomic(path.join(seedHome, '.gitconfig'), buildGitconfig(), 0o600);
  keepOnly(seedHome, SEED_HOME_KEEP); // preserve the Claude seed; drop stray session state
  keepOnly(configDir, ['gh']); // keep .config a template: gh only
}

function parseUser(argv) {
  const i = argv.indexOf('--user');
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
  const force = process.argv.includes('--force');
  const user = parseUser(process.argv);
  const token = await readToken();
  const verdict = validateGithubToken(token, { force });
  if (!verdict.ok) { console.error(verdict.reason); process.exit(1); }

  const seedHome = seedHomePath();
  installGithubSeed(seedHome, { token, user });
  console.log(`Seeded GitHub auth into ${seedHome} (.config/gh/hosts.yml + .gitconfig, 0600).`);
  console.log('Open a terminal and confirm: `gh auth status`, then push a throwaway branch + `gh pr create`.');
  console.log('The container has PUSH + OPEN-PR authority only — merging to main stays a human step.');
}

// Run I/O only when invoked directly (realpath-compared, so a symlinked bin still works), so the pure
// builders + installGithubSeed stay importable by tests. Mirrors terminal-setup-cred.mjs.
const selfPath = fileURLToPath(import.meta.url);
const invokedReal = process.argv[1] ? (() => {
  try { return realpathSync(process.argv[1]); } catch { return null; }
})() : null;
if (invokedReal === selfPath) {
  await main();
}

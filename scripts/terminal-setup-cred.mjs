#!/usr/bin/env node
// One-time local setup for the embedded terminal (tkt-be809dd2b7fb).
// Turns a `claude setup-token` SUBSCRIPTION token into the credentials.json the container
// mounts read-only — so auth works with no API billing and the token never appears in `env`.
//
// Usage (keep the token off your shell history / this repo):
//   claude setup-token            # in your own terminal; copy the printed token
//   node scripts/terminal-setup-cred.mjs   # paste when prompted (input is hidden)
// or pipe it:  printf '%s' "$TOKEN" | node scripts/terminal-setup-cred.mjs
//
// Seeds ~/.kanban-terminal/home/.claude/.credentials.json (mode 0600, dir 0700). That home dir is
// the read-only SEED/template: each session gets its own COPY of it as HOME (S4, tkt-db09c3a52655),
// so concurrent sessions can't corrupt a shared ~/.claude.json and one session can't tamper another's
// auth. Kept OUTSIDE the repo so the in-container session can't read the raw token via a project
// mount. Re-run to rotate.
//
// The ONLY sanctioned way to seed (tkt-ea48dbc56f19). Never `/login` into the seed home: sessions
// only COPY the seed, so a refreshable credential's refresh lands in a throwaway copy and the seed
// rots into "login expired" (tkt-da1caf5316f7). Re-seeding resets the home to credentials-only.
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SEED_HOME = path.join(homedir(), '.kanban-terminal', 'home');
const OUT_DIR = path.join(SEED_HOME, '.claude');
const OUT_FILE = path.join(OUT_DIR, '.credentials.json');

async function readToken() {
  if (!process.stdin.isTTY) {
    // piped input
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Best-effort hide: mute the output stream while typing.
  const answer = await new Promise((resolve) => {
    rl.question('Paste your `claude setup-token` token (hidden): ', resolve);
    rl._writeToOutput = () => {}; // suppress echo
  });
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

const token = await readToken();
if (!token) { console.error('No token provided.'); process.exit(1); }

// Claude Code's OAuth credential shape (verified to authenticate on the subscription).
// refreshToken:'' is load-bearing — it's what survives being copied, and the preflight's "stable" tell.
// The +10y expiry is a LOCAL stamp only: a setup-token really lasts ~1y server-side, so the seed can
// die while this still claims a decade — nothing local can detect that, only a live session.
const expiresAt = (Math.floor(Date.now() / 1000) + 315_360_000) * 1000; // +10y, ms
const credentials = {
  claudeAiOauth: { accessToken: token, refreshToken: '', expiresAt, scopes: ['user:inference'] },
};

// Reset the whole home, not just the credential — accumulated .claude.json/session state is how
// rotating credentials crept back in. Runs only after the token validates, so a bad paste can't
// destroy a working seed.
rmSync(SEED_HOME, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
chmodSync(OUT_DIR, 0o700); // enforce even if the dir pre-existed with looser perms
writeFileSync(OUT_FILE, JSON.stringify(credentials), { mode: 0o600 });
chmodSync(OUT_FILE, 0o600);
console.log(`Reset ${SEED_HOME} and wrote ${OUT_FILE} (0600). The terminal will mount it read-only.`);
console.log('Open a terminal session to confirm — a setup-token\'s real expiry is only visible in use.');

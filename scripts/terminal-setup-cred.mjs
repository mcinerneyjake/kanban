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
// Writes .terminal/credentials.json (gitignored, mode 0600). Re-run to rotate.
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const OUT_DIR = path.join(process.cwd(), '.terminal');
const OUT_FILE = path.join(OUT_DIR, 'credentials.json');

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
// Far-future expiry so a never-refreshed long-lived token isn't treated as stale.
const expiresAt = (Math.floor(Date.now() / 1000) + 315_360_000) * 1000; // +10y, ms
const credentials = {
  claudeAiOauth: { accessToken: token, refreshToken: '', expiresAt, scopes: ['user:inference', 'user:profile'] },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(credentials), { mode: 0o600 });
chmodSync(OUT_FILE, 0o600);
console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (0600). The terminal will mount it read-only.`);

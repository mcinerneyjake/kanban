import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { installSeed, readToken, assemblePastedLines } from './terminal-setup-cred.mjs';

const SCRIPT = fileURLToPath(new URL('./terminal-setup-cred.mjs', import.meta.url));
const GOOD = `sk-ant-oat01-${'a'.repeat(97)}`; // 110 chars, the observed live length
const CREDS = { claudeAiOauth: { accessToken: GOOD, refreshToken: '', expiresAt: 1, scopes: ['user:inference'] } };

describe('terminal-setup-cred end to end', () => {
  let base, seedHome, env;

  const seedExisting = (marker) => {
    mkdirSync(path.join(seedHome, '.claude'), { recursive: true });
    writeFileSync(path.join(seedHome, '.claude', '.credentials.json'), marker);
    writeFileSync(path.join(seedHome, '.claude', 'settings.json'), '{"theme":"auto"}');           // config — kept
    writeFileSync(path.join(seedHome, '.claude', 'history.jsonl'), 'per-session state\n');        // state — pruned
    writeFileSync(path.join(seedHome, '.claude.json'), '{"hasCompletedOnboarding":true}');        // config — kept
    mkdirSync(path.join(seedHome, '.local', 'bin'), { recursive: true });                          // 502MB of stray CLI on the real seed
    mkdirSync(path.join(seedHome, 'projects', 'old-session'), { recursive: true });
  };
  const run = (token, args = []) => execFileSync('node', [SCRIPT, ...args], { input: token, env, encoding: 'utf8' });
  const credentialsFile = () => path.join(seedHome, '.claude', '.credentials.json');

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'seedcred-'));
    seedHome = path.join(base, 'kanban-terminal', 'home');
    env = { ...process.env, KANBAN_TERMINAL_HOME: seedHome };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('writes a credentials-only seed with locked-down permissions', () => {
    run(GOOD);
    const written = JSON.parse(readFileSync(credentialsFile(), 'utf8'));
    expect(written.claudeAiOauth.accessToken).toBe(GOOD);
    expect(written.claudeAiOauth.refreshToken).toBe(''); // the tell the preflight reads
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(seedHome, '.claude')).mode & 0o777).toBe(0o700);
  });

  // Config survives, state does not. Wiping config bought no safety — the token lives in
  // .credentials.json, not .claude.json — and cost every session its onboarding state.
  it('prunes accumulated state but keeps config', () => {
    seedExisting('{"old":true}');
    run(GOOD);
    expect(readdirSync(seedHome).sort()).toEqual(['.claude', '.claude.json']);
    expect(readdirSync(path.join(seedHome, '.claude')).sort()).toEqual(['.credentials.json', 'settings.json']);
    expect(readFileSync(path.join(seedHome, '.claude.json'), 'utf8')).toBe('{"hasCompletedOnboarding":true}');
    expect(readFileSync(path.join(seedHome, '.claude', 'settings.json'), 'utf8')).toBe('{"theme":"auto"}');
  });

  it('works when no seed exists yet', () => {
    run(GOOD);
    expect(existsSync(credentialsFile())).toBe(true);
  });

  // Each rejection must leave the seed untouched — the bug was that ANY non-empty input replaced it.
  // Both branches are covered: >40 chars exercises the prefix check (a short value never reaches it).
  it.each([
    ['a truncated fragment', 'sk-ant-oat01-abc'],
    ['an Anthropic API key', `sk-ant-api03-${'x'.repeat(95)}`],
    ['a pasted URL', 'https://console.anthropic.com/settings/keys?tab=oauth&extra=padding-to-clear-40'],
  ])('leaves an existing seed byte-identical when given %s', (_label, token) => {
    seedExisting('{"original":"do not clobber"}');
    const before = readFileSync(credentialsFile(), 'utf8');
    expect(() => run(token)).toThrow(); // non-zero exit
    expect(readFileSync(credentialsFile(), 'utf8')).toBe(before);
    expect(existsSync(path.join(seedHome, 'projects', 'old-session'))).toBe(true);
  });

  it('accepts an unrecognized prefix only under --force', () => {
    const odd = `weird-prefix-${'b'.repeat(60)}`;
    expect(() => run(odd)).toThrow();
    run(odd, ['--force']);
    expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).claudeAiOauth.accessToken).toBe(odd);
  });

  // A differently-named symlink (a ~/bin shim, an npm bin link) used to make the entry-point guard
  // fall through: exit 0, no output, no seeding, and the user believing a rotation happened.
  it('still seeds when invoked through a symlink under another name', () => {
    const shim = path.join(base, 'seed-terminal');
    symlinkSync(SCRIPT, shim);
    execFileSync('node', [shim], { input: GOOD, env, encoding: 'utf8' });
    expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).claudeAiOauth.accessToken).toBe(GOOD);
  });

  it('leaves no temp files behind', () => {
    run(GOOD);
    expect(readdirSync(path.join(seedHome, '.claude'))).toEqual(['.credentials.json']);
    expect(readdirSync(path.dirname(seedHome))).toEqual(['home']);
  });
});

// The atomicity itself — the point of the ticket. Driving the CLI cannot reach these paths, because
// every bad token is rejected before installSeed runs; that gap let a reverted installSeed keep the
// suite green (tkt-bfb3bc9f98d4 review). These call installSeed directly and inject a failure.
describe('installSeed atomicity', () => {
  let base, seedHome;
  const credentialsFile = () => path.join(seedHome, '.claude', '.credentials.json');

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'seedatomic-'));
    seedHome = path.join(base, 'home');
    mkdirSync(path.join(seedHome, '.claude'), { recursive: true });
    writeFileSync(credentialsFile(), '{"original":"survivor"}');
  });
  afterEach(() => { chmodSync(path.join(seedHome, '.claude'), 0o700); rmSync(base, { recursive: true, force: true }); });

  it('keeps the previous credential when serialization fails mid-install', () => {
    const circular = {};
    circular.self = circular; // JSON.stringify throws
    expect(() => installSeed(seedHome, circular)).toThrow();
    expect(readFileSync(credentialsFile(), 'utf8')).toBe('{"original":"survivor"}');
  });

  // Attempting to deny the write via directory mode does NOT fail the install — installSeed chmods
  // the dir back to 0700 first. That repair is the behavior worth pinning; a loose seed dir is how a
  // token becomes world-readable.
  it('repairs a loosened .claude directory instead of writing into it', () => {
    chmodSync(path.join(seedHome, '.claude'), 0o755);
    installSeed(seedHome, CREDS);
    expect(statSync(path.join(seedHome, '.claude')).mode & 0o777).toBe(0o700);
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind after a failed install', () => {
    const circular = {};
    circular.self = circular;
    expect(() => installSeed(seedHome, circular)).toThrow();
    expect(readdirSync(path.join(seedHome, '.claude'))).toEqual(['.credentials.json']);
  });

  it('never leaves the credential missing — it is the old one or the new one', () => {
    installSeed(seedHome, CREDS);
    expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).claudeAiOauth.accessToken).toBe(GOOD);
  });

  // A trailing slash on KANBAN_TERMINAL_HOME used to place scratch dirs INSIDE the live seed.
  it('is unaffected by a trailing slash on the seed path', () => {
    installSeed(`${seedHome}${path.sep}`, CREDS);
    expect(JSON.parse(readFileSync(credentialsFile(), 'utf8')).claudeAiOauth.accessToken).toBe(GOOD);
    expect(readdirSync(seedHome)).toEqual(['.claude']);
  });
});

// tkt-dba03a3b6bda. `rl.question` resolves on the FIRST newline, so a token pasted across lines was
// silently truncated there — and the remainder was long enough to clear the validator's length floor,
// so the seeder reported success and wrote an unusable credential. Nothing caught it because the
// interactive branch needed a TTY; `terminal: true` on a plain stream is what makes it drivable here.
describe('interactive paste (TTY branch)', () => {
  const feed = async (text) => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume(); // drain the muted prompt, or the writes back up
    const pending = readToken({ input, output, isTTY: true });
    input.end(text);
    return pending;
  };

  it('keeps every line of a multi-line paste (written first, observed red)', async () => {
    // Two lines, each on its own well past the 50-char floor — so the truncated first line alone
    // still VALIDATES. That is the whole defect: a silent partial credential, not a rejection.
    const pasted = `sk-ant-oat01-${'a'.repeat(60)}\n${'b'.repeat(40)}`;
    expect(await feed(pasted)).toBe(pasted);
  });

  it('is unchanged for the ordinary single-line paste', async () => {
    expect(await feed(`${GOOD}\n`)).toBe(GOOD);
  });

  it('trims the edges but never the middle, exactly as the piped branch does', async () => {
    // The validator deliberately tolerates INTERNAL whitespace (tkt-7b21fb0b3307), so the reader must
    // not quietly normalise it away — that would make the two intake paths disagree.
    expect(await feed(`  ${GOOD}  \n`)).toBe(GOOD);
  });
});

describe('assemblePastedLines (the pure half)', () => {
  const from = async (...lines) => assemblePastedLines((async function* () { yield* lines; })());

  it('joins the lines it was given and reports how many there were', async () => {
    expect(await from('one', 'two', 'three')).toEqual({ token: 'one\ntwo\nthree', lineCount: 3 });
  });

  it('counts lines the trim removes, so a trailing blank line is still visible to the caller', async () => {
    // lineCount is NOT derived from the token: `'x\n\n'.trim()` loses the evidence that the user's
    // paste had a trailing blank, which is exactly the shape worth reporting back.
    expect(await from('x', '', '')).toEqual({ token: 'x', lineCount: 3 });
  });

  it('returns an empty token for empty input rather than throwing', async () => {
    expect(await from()).toEqual({ token: '', lineCount: 0 });
  });
});

describe('the two intake paths agree', () => {
  // The defect was one branch reading to EOF and the other stopping at a newline. This is the
  // property that was violated, asserted directly rather than inferred from the two separately.
  // Delivered in THREE chunks, not one. A single `end(text)` arrives as one chunk, so a piped branch
  // mutated to `break` after the first chunk still read everything and stayed green — the test could
  // not see the accumulation it was supposed to be checking. A real paste arrives in several reads.
  // AWAITING between writes is load-bearing, not decoration: three synchronous `write()` calls are
  // coalesced into a single chunk before the reader sees them, so a piped branch mutated to `break`
  // after the first chunk still read everything and the suite stayed green. Yielding the event loop
  // is what makes them arrive as separate reads — the thing this is supposed to be checking.
  const inChunks = async (input, text) => {
    const third = Math.ceil(text.length / 3);
    for (const part of [text.slice(0, third), text.slice(third, third * 2), text.slice(third * 2)]) {
      input.write(part);
      await new Promise((r) => setImmediate(r));
    }
    input.end();
  };
  const viaTTY = async (text) => {
    const input = new PassThrough(); const output = new PassThrough(); output.resume();
    const pending = readToken({ input, output, isTTY: true });
    await inChunks(input, text);
    return pending;
  };
  const viaPipe = async (text) => {
    const input = new PassThrough();
    const pending = readToken({ input, output: new PassThrough(), isTTY: false });
    await inChunks(input, text);
    return pending;
  };

  it.each([
    ['single line', `${GOOD}\n`],
    ['no trailing newline', GOOD],
    ['wrapped across lines', `sk-ant-oat01-${'a'.repeat(60)}\n${'b'.repeat(40)}`],
    ['padded edges', `  ${GOOD}  \n`],
    ['internal spaces, which real tokens have', `sk-ant-oat01-${'a'.repeat(50)} ${'b'.repeat(50)}`],
  ])('produce the same token for %s', async (_name, text) => {
    expect(await viaTTY(text)).toBe(await viaPipe(text));
  });
});

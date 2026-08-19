import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, truncateSync, chmodSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEED_SIZE_WARN_BYTES, SEED_ENTRY_LIMIT, measureDirBytes, measureSeedSize, describeSeedSize } from './terminalSeed.mjs';

// The seed is copied whole on every session start, so these two halves answer different questions:
// measureDirBytes/measureSeedSize — "how much would the copy cost?"; describeSeedSize — "is that a
// fault, and can I even tell?" (tkt-ce65b2532e47).

describe('measureDirBytes', () => {
  let base;
  beforeEach(() => { base = mkdtempSync(path.join(tmpdir(), 'kanban-seedsize-')); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('is 0 for an empty directory', () => {
    expect(measureDirBytes(base)).toBe(0);
  });

  // The real 502 MB lived in .local/share/claude/versions/…, not in a top-level file. A top-level-only
  // sum would have reported that seed as healthy.
  it('counts bloat nested several levels down', () => {
    const deep = path.join(base, '.local', 'share', 'claude', 'versions');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'blob'), 'x'.repeat(5000));
    writeFileSync(path.join(base, '.claude.json'), '{}'); // 2 bytes, top level
    expect(measureDirBytes(base)).toBe(5002);
  });

  // cpSync defaults to dereference:false, so it copies the LINK. Counting the target would fire the
  // guard on a seed whose copy costs twenty bytes.
  it('counts a symlink as the link, not its target', () => {
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    const fat = path.join(outside, 'fat');
    writeFileSync(fat, '');
    truncateSync(fat, 40 * 1024 * 1024);

    const seed = path.join(base, 'seed');
    mkdirSync(seed);
    symlinkSync(fat, path.join(seed, 'link'));
    const linked = measureDirBytes(seed);
    expect(linked).toBe(lstatSync(path.join(seed, 'link')).size);
    expect(linked).toBeLessThan(4096);

    // The control that makes the assertion above evidence: the same bytes, counted when they are a
    // real file rather than a link. Without it, a measurer that returned 0 for everything would pass.
    const real = path.join(base, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'fat'), '');
    truncateSync(path.join(real, 'fat'), 40 * 1024 * 1024);
    expect(measureDirBytes(real)).toBe(40 * 1024 * 1024);
  });

  // A skipped entry undercounts, and an undercount is the permissive answer from a guard whose whole
  // subject is an unnoticed 502 MB. Root bypasses the mode bits, so the case is SKIPPED there rather
  // than passing vacuously — a green run as root would witness nothing.
  it.skipIf(process.getuid?.() === 0)('throws on an unreadable entry rather than skipping it', () => {
    const locked = path.join(base, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(() => measureDirBytes(base)).toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe('measureSeedSize', () => {
  let base;
  beforeEach(() => { base = mkdtempSync(path.join(tmpdir(), 'kanban-seedsize-')); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('reads an absent seed as 0, not as an error — there is nothing to copy', () => {
    const result = measureSeedSize({ KANBAN_TERMINAL_HOME: path.join(base, 'nope') });
    expect(result).toEqual({ dir: path.join(base, 'nope'), bytes: 0, error: null });
    expect(describeSeedSize(result).level).toBe('ok');
  });

  it('reports an unreadable seed as an error, never as 0 bytes', () => {
    const asFile = path.join(base, 'seed-is-a-file');
    writeFileSync(asFile, 'not a directory');
    const result = measureSeedSize({ KANBAN_TERMINAL_HOME: asFile });
    expect(result.bytes).toBeNull();
    expect(result.error).toBeTruthy();
    // 0 and "could not read" are the same answer to `bytes > budget`; only this keeps them apart.
    expect(describeSeedSize(result).level).toBe('warn');
  });

  // The fail-open a review found: existsSync answers `false` for ANY stat failure, so an unreadable
  // ANCESTOR read as an absent seed and a 60 MB tree rendered "✓ 0 B". Absent and inaccessible are
  // different states and only one of them is fine. Skipped as root, which bypasses the mode bits.
  it.skipIf(process.getuid?.() === 0)('does not mistake an inaccessible seed for an absent one', () => {
    const locked = path.join(base, 'locked');
    const seed = path.join(locked, 'home');
    mkdirSync(seed, { recursive: true });
    writeFileSync(path.join(seed, 'blob'), 'x'.repeat(5000));
    chmodSync(locked, 0o000);
    try {
      const result = measureSeedSize({ KANBAN_TERMINAL_HOME: seed });
      expect(result.bytes).not.toBe(0); // the whole finding: 0 and "cannot read" are not the same
      expect(result.bytes).toBeNull();
      expect(result.error).toBeTruthy();
      expect(describeSeedSize(result).level).toBe('warn');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('honors KANBAN_TERMINAL_HOME and sums what is actually there', () => {
    const seed = path.join(base, 'home');
    mkdirSync(path.join(seed, '.claude'), { recursive: true });
    writeFileSync(path.join(seed, '.claude', '.credentials.json'), 'x'.repeat(300));
    expect(measureSeedSize({ KANBAN_TERMINAL_HOME: seed })).toEqual({ dir: seed, bytes: 300, error: null });
  });
});

describe('describeSeedSize', () => {
  it('passes a healthy seed', () => {
    const { level, message } = describeSeedSize({ bytes: 56 * 1024, dir: '/seed' });
    expect(level).toBe('ok');
    expect(message).toContain('56.0 KB');
  });

  it('warns over the budget, naming the measured size and the budget', () => {
    const { level, message } = describeSeedSize({ bytes: 502 * 1024 * 1024, dir: '/seed' });
    expect(level).toBe('warn');
    expect(message).toContain('502.0 MB');
    expect(message).toContain('50.0 MB');
    expect(message).toContain('/seed');
  });

  // The boundary, both sides. A guard tested only at 502 MB cannot tell `>` from `>=`.
  it('is a strict ceiling: exactly at budget passes, one byte over warns', () => {
    expect(describeSeedSize({ bytes: SEED_SIZE_WARN_BYTES }).level).toBe('ok');
    expect(describeSeedSize({ bytes: SEED_SIZE_WARN_BYTES + 1 }).level).toBe('warn');
  });

  it('warns when the measurement failed, and says the size is unknown', () => {
    const { level, message } = describeSeedSize({ bytes: null, error: 'EACCES', dir: '/seed' });
    expect(level).toBe('warn');
    expect(message).toContain('UNKNOWN');
    expect(message).toContain('EACCES');
  });

  // The fail-open this guard would otherwise have: `null > 52428800` is false, so a non-measurement
  // with no error attached falls through the comparison and renders as a passing seed.
  it('warns on a non-measurement even when no error came with it', () => {
    for (const bytes of [null, undefined, NaN, Infinity, -1, '0']) {
      expect(describeSeedSize({ bytes }).level, String(bytes)).toBe('warn');
    }
  });

  it('respects an injected budget, so the threshold is not baked into the comparison', () => {
    expect(describeSeedSize({ bytes: 2000, warnBytes: 1000 }).level).toBe('warn');
    expect(describeSeedSize({ bytes: 2000, warnBytes: 4000 }).level).toBe('ok');
  });

  // The budget is the knob the case above makes public, and it was the one input left unvalidated:
  // `502e6 > NaN` is false, so a garbage budget passed a 502 MB seed.
  it('warns on an unusable budget instead of passing whatever it was given', () => {
    for (const warnBytes of [NaN, Infinity, null, undefined, -1, '50']) {
      expect(describeSeedSize({ bytes: 502 * 1024 * 1024, warnBytes }).level, String(warnBytes)).toBe('warn');
    }
  });
});

// The invariant the budget lives in shared/ for: two consumers reading two different numbers is the
// drift tkt-812b2b71acbe paid for. Comparing exports cannot prove the consumers USE them — the old
// drift was a pasted literal — so this asserts the source.
//
// The first cut of this block was VACUOUS in the half that mattered: `toMatch(/warnOnSeedSize\(/)` is
// satisfied by the declaration line `function warnOnSeedSize(env…)`, so deleting the CALL left it
// green. terminalHome.ts is caught by the behavioural cases in server/terminalHome.test.ts either way,
// but scripts/preflight-dev.mjs has no test at all — so the consumer this block is named for could be
// unwired with the whole suite green. Each assertion below is anchored inside the CALLER's body, and
// the negatives are scoped to the seed function rather than to the whole file, which would have gone
// red on any unrelated future readdirSync or MB arithmetic in a general-purpose dev preflight.
describe('both consumers read the one budget, and are actually wired in', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

  // Brace-free extraction: from `function <name>(` to the first line-initial `}`, which is where every
  // top-level function in these two files ends.
  const bodyOf = (src, fn) => {
    const start = src.indexOf(`function ${fn}(`);
    expect(start, `${fn} is not declared`).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    expect(end, `${fn} has no line-initial close`).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it.each([
    ['../server/terminalHome.ts', 'warnOnSeedSize', 'seedSessionHome'],
    ['../scripts/preflight-dev.mjs', 'checkTerminalSeedSize', 'main'],
  ])('%s: %s derives its verdict from the shared budget', (file, fn, _caller) => {
    const body = bodyOf(read(file), fn);
    expect(body).toMatch(/describeSeedSize\(measureSeedSize\(/);
    expect(body).not.toMatch(/1024 \* 1024/); // a re-rolled byte budget
    expect(body).not.toMatch(/readdirSync/);  // a re-rolled walk
  });

  // Order-independent: the first cut required measureSeedSize to appear BEFORE describeSeedSize, so an
  // alphabetical import sort — what perfectionist/sort-imports produces — would have reddened it while
  // the code stayed correct.
  it.each([['../server/terminalHome.ts'], ['../scripts/preflight-dev.mjs']])('%s imports both halves from shared/', (file) => {
    const imported = read(file).match(/import \{([^}]*)\} from '[^']*terminalSeed\.mjs'/);
    expect(imported, 'no terminalSeed.mjs import').toBeTruthy();
    const names = imported[1].split(',').map((n) => n.trim());
    expect(names).toContain('measureSeedSize');
    expect(names).toContain('describeSeedSize');
  });

  // The half that was vacuous. Asserts the CALL, inside the caller that must make it — deleting
  // `warnOnSeedSize(env);` or `checkTerminalSeedSize();` reddens this and nothing else.
  it.each([
    ['../server/terminalHome.ts', 'seedSessionHome', 'warnOnSeedSize'],
    ['../scripts/preflight-dev.mjs', 'main', 'checkTerminalSeedSize'],
  ])('%s: %s calls %s', (file, caller, fn) => {
    expect(bodyOf(read(file), caller)).toMatch(new RegExp(`\\n\\s*${fn}\\(`));
  });
});

describe('entry-count cap (a seed bloated by file COUNT, not bytes)', () => {
  let base;
  beforeEach(() => { base = mkdtempSync(path.join(tmpdir(), 'kanban-seedcap-')); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // Bytes alone would call this seed healthy while every session start copies 40k inodes, and the walk
  // itself would block `npm run dev`. Aborting into "size UNKNOWN" is the right verdict either way.
  it('abandons the walk past the cap and reports unknown, never healthy', () => {
    for (let i = 0; i <= SEED_ENTRY_LIMIT; i++) writeFileSync(path.join(base, `f${i}`), '');
    const result = measureSeedSize({ KANBAN_TERMINAL_HOME: base });
    expect(result.bytes).toBeNull();
    expect(result.error).toContain('more than');
    const { level, message } = describeSeedSize(result);
    expect(level).toBe('warn');
    expect(message).toContain('UNKNOWN');
  });

  // The control: one entry under the cap still measures. Without it, a cap that fired on everything
  // would pass the case above identically.
  it('measures normally just under the cap', () => {
    for (let i = 0; i < 50; i++) writeFileSync(path.join(base, `f${i}`), 'x');
    expect(measureSeedSize({ KANBAN_TERMINAL_HOME: base })).toEqual({ dir: base, bytes: 50, error: null });
  });
});

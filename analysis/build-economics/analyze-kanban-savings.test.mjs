import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldWrite, isMain, emitSnapshot } from './analyze-kanban-savings.mjs';

const MODULE = fileURLToPath(new URL('./analyze-kanban-savings.mjs', import.meta.url));

// tkt-48680743ed36. The whole module was top-level, so merely IMPORTING it ran the full analysis and
// OVERWROTE the tracked snapshot — observed 2026-08-11 changing asOf, mergedPRs (155→246) and loc,
// caught only because `git status` happened to flag the file. The snapshot is a deliberately frozen,
// asOf-dated source for src/components/EconomicsBuildSection.tsx and published figures.
describe('analyze-kanban-savings is inert unless run deliberately', () => {
  // KANBAN_REPO drives the transcript search path, so pointing it at an empty dir makes the analysis
  // find nothing and exit 1 — on ANY machine, with or without real ~/.claude sessions. That is what
  // lets the direct-run control below be deterministic here and in CI alike, without needing the
  // multi-second real analysis.
  const run = (args, extraEnv = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'econ-guard-'));
    const out = path.join(dir, 'snapshot.json');
    try {
      const r = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...process.env, OUT: out, KANBAN_REPO: path.join(dir, 'no-such-repo') },
        ...extraEnv,
      });
      return { ...r, wroteFile: existsSync(out) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('an IMPORT writes nothing and runs nothing — the incident', () => {
    const r = run(['-e', `import(${JSON.stringify(MODULE)})`]);
    expect(r.wroteFile).toBe(false);
    expect(r.status).toBe(0);
    // Silent, not merely write-free: the analysis parses every transcript, so an unguarded import
    // also cost seconds and a page of output. Reaching the analysis at all would print this.
    expect(r.stderr).not.toContain('No transcripts found');
  });

  it('a DIRECT run does reach the analysis — the control that isMain is not simply always false', () => {
    // Without this, a guard that never lets main() run would pass the test above identically.
    const r = run([MODULE, '--write']);
    expect(r.stderr).toContain('No transcripts found');
    expect(r.status).toBe(1);
  });

  // KNOWN GAP, stated rather than papered over: nothing here asserts that main() still CALLS
  // emitSnapshot. Deleting that call leaves this suite green, because reaching it needs the real
  // multi-second transcript analysis, which does not exist in CI. Asserting the source text instead
  // would be a substring match on code — the weak form this repo already calls out.
  //
  // The residual is acceptable because it is LOUD, unlike the bug being fixed: a main() that stopped
  // writing prints neither "Wrote" nor "DRY RUN", so `--write` producing nothing is immediately
  // visible. The defect this ticket exists for was silent — an import that overwrote a tracked file
  // with nobody looking.
  it('exports isMain as false when imported', () => {
    expect(isMain).toBe(false); // vitest imports this file; the module is not argv[1]
  });

  describe('the --write gate', () => {
    it('requires the flag, and is not satisfied by a lookalike', () => {
      expect(shouldWrite(['--write'])).toBe(true);
      expect(shouldWrite(['--foo', '--write'])).toBe(true);
      for (const argv of [[], ['--dry-run'], ['-w'], ['--write-snapshot'], ['write']]) {
        expect(shouldWrite(argv), JSON.stringify(argv)).toBe(false);
      }
    });

    it('is WIRED to the write, not merely consulted', () => {
      // Testing shouldWrite alone was not enough: mutating the call site to `if (true)` left the
      // suite green, because no test could reach the write past the transcript analysis. This drives
      // the write path directly, so the wiring itself is what goes red.
      const dir = mkdtempSync(path.join(tmpdir(), 'econ-emit-'));
      const file = path.join(dir, 'snapshot.json');
      const payload = { asOf: '2026-01-01' };
      try {
        expect(emitSnapshot([], file, payload)).toBe(false);
        expect(existsSync(file)).toBe(false);

        expect(emitSnapshot(['--write'], file, payload)).toBe(true);
        expect(existsSync(file)).toBe(true);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(payload);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

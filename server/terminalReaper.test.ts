import { describe, it, expect, vi } from 'vitest';
import { planReap, reapOnce, startReaper, type ReaperConfig } from './terminalReaper.js';
import { parsePsLines, type PsRow } from './terminalDocker.js';
import { buildDetachedRunArgs, SESSION_LABEL_KEY, SESSION_CREATED_LABEL_KEY } from './terminalAuth.js';

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const CFG: ReaperConfig = { graceMs: MIN, maxAgeMs: 60 * MIN, cap: 2 };

// A row created `agoMs` before NOW (or with no created label when agoMs is null).
function row(name: string, session: string, agoMs: number | null): PsRow {
  return agoMs === null ? { name, session } : { name, session, createdAtMs: NOW - agoMs };
}

// planReap never protects anything unless isTracked says so; default: nothing is tracked.
const untracked = () => false;

describe('planReap', () => {
  it('reaps an untracked orphan past the absolute max-age', () => {
    const rows = [row('c-old', 's-old', 120 * MIN)];
    const reap = planReap({ rows, isTracked: untracked, now: NOW, config: CFG });
    expect(reap).toEqual([{ name: 'c-old', session: 's-old', reason: 'max-age', ageMs: 120 * MIN }]);
  });

  it('never reaps a registry-tracked container, however ancient (the safety invariant)', () => {
    const rows = [row('c-live', 's-live', 300 * MIN)];
    const reap = planReap({ rows, isTracked: (s) => s === 's-live', now: NOW, config: CFG });
    expect(reap).toEqual([]);
  });

  it('spares an orphan younger than the grace window', () => {
    const rows = [row('c-new', 's-new', 30_000)]; // 30s < 60s grace
    expect(planReap({ rows, isTracked: untracked, now: NOW, config: CFG })).toEqual([]);
  });

  it('spares a past-grace orphan that is under max-age and under the cap', () => {
    const rows = [row('c-mid', 's-mid', 10 * MIN)]; // past grace, < 60min max-age, 1 ≤ cap 2
    expect(planReap({ rows, isTracked: untracked, now: NOW, config: CFG })).toEqual([]);
  });

  it('enforces the cap oldest-first, keeping the youngest `cap` survivors', () => {
    const rows = [
      row('c10', 's10', 10 * MIN), row('c20', 's20', 20 * MIN),
      row('c30', 's30', 30 * MIN), row('c40', 's40', 40 * MIN),
    ]; // 4 orphans, all past grace & under max-age; cap 2 → reap the 2 oldest
    const reap = planReap({ rows, isTracked: untracked, now: NOW, config: CFG });
    expect(reap.map((r) => r.name)).toEqual(['c40', 'c30']); // oldest first
    expect(reap.every((r) => r.reason === 'cap')).toBe(true);
  });

  it('cap never culls a within-grace orphan (a fresh burst is not reaped early)', () => {
    const rows = [row('c-old', 's-old', 30 * MIN), row('c-young', 's-young', 5_000)];
    const reap = planReap({ rows, isTracked: untracked, now: NOW, config: { graceMs: MIN, maxAgeMs: 60 * MIN, cap: 1 } });
    expect(reap.map((r) => r.name)).toEqual(['c-old']); // the young one is spared even though count > cap
  });

  it('spares an over-cap set when every orphan is still within grace', () => {
    const rows = [row('a', 'sa', 5_000), row('b', 'sb', 8_000), row('c', 'sc', 3_000)];
    expect(planReap({ rows, isTracked: untracked, now: NOW, config: { graceMs: MIN, maxAgeMs: 60 * MIN, cap: 1 } })).toEqual([]);
  });

  it('treats a missing/unparseable created label as unknown age → never reaped', () => {
    const rows = [row('c-nolabel', 's-nolabel', null)];
    const tiny: ReaperConfig = { graceMs: MIN, maxAgeMs: 1, cap: 0 }; // aggressive: would reap any real age
    expect(planReap({ rows, isTracked: untracked, now: NOW, config: tiny })).toEqual([]);
  });

  it('a misconfigured max-age below the grace window still never reaps a within-grace container', () => {
    const rows = [row('c', 's', 30_000)]; // 30s old
    const bad: ReaperConfig = { graceMs: MIN, maxAgeMs: 10, cap: 10 }; // maxAge < grace
    expect(planReap({ rows, isTracked: untracked, now: NOW, config: bad })).toEqual([]);
  });

  it('combines max-age and cap in one pass', () => {
    const rows = [
      row('ancient', 'sanc', 120 * MIN), // max-age
      row('c30', 's30', 30 * MIN), row('c20', 's20', 20 * MIN), row('c10', 's10', 10 * MIN),
    ]; // after max-age removes ancient, 3 remain, cap 2 → reap oldest (c30)
    const reap = planReap({ rows, isTracked: untracked, now: NOW, config: CFG });
    expect(reap.map((r) => ({ name: r.name, reason: r.reason }))).toEqual([
      { name: 'ancient', reason: 'max-age' },
      { name: 'c30', reason: 'cap' },
    ]);
  });
});

// A fake DockerCli exposing only ps + remove (what the reaper touches).
function fakeDocker(rows: PsRow[]) {
  const removed: string[] = [];
  return {
    removed,
    docker: {
      ps: vi.fn(async () => rows),
      remove: (name: string) => { removed.push(name); },
    },
  };
}

describe('reapOnce', () => {
  it('scopes the ps query by session + root labels and tags the context', async () => {
    const { docker } = fakeDocker([]);
    await reapOnce({ docker, isTracked: untracked, rootLabel: '/repo/kanban', config: CFG, now: () => NOW });
    expect(docker.ps).toHaveBeenCalledWith(
      'kanban.session', 'kanban.created',
      ['kanban.session', 'kanban.root=/repo/kanban'], 'reaper',
    );
  });

  it('removes exactly the planned orphans and returns the decisions', async () => {
    const rows = [row('c-old', 's-old', 120 * MIN), row('c-live', 's-live', 200 * MIN), row('c-new', 's-new', 5_000)];
    const { docker, removed } = fakeDocker(rows);
    const decisions = await reapOnce({
      docker, isTracked: (s) => s === 's-live', rootLabel: '/r', config: CFG, now: () => NOW,
    });
    expect(removed).toEqual(['c-old']);          // live is tracked; new is within grace
    expect(decisions.map((d) => d.name)).toEqual(['c-old']);
  });

  it('does nothing when ps resolves empty', async () => {
    const { docker, removed } = fakeDocker([]);
    const decisions = await reapOnce({ docker, isTracked: untracked, rootLabel: '/r', config: CFG, now: () => NOW });
    expect(removed).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it('invokes onReaped(session) for each reaped orphan so its isolated HOME is cleaned (S4)', async () => {
    const rows = [row('c-old', 's-old', 120 * MIN), row('c-live', 's-live', 200 * MIN), row('c-new', 's-new', 5_000)];
    const { docker } = fakeDocker(rows);
    const cleaned: string[] = [];
    await reapOnce({
      docker, isTracked: (s) => s === 's-live', rootLabel: '/r', config: CFG, now: () => NOW,
      onReaped: (session) => cleaned.push(session),
    });
    expect(cleaned).toEqual(['s-old']); // only the reaped orphan; live is protected, new is within grace
  });
});

// Mandatory integration-seam round-trip (CLAUDE.md): the createdAt epoch threads
// buildDetachedRunArgs (label) → docker ps --format → parsePsLines → planReap across 3 modules.
// Each layer is unit-tested, but nothing else drives the WHOLE path — a label-key or format drift
// would pass every unit test yet break age-based reaping. Fidelity invariant: the stamped epoch is
// the exact epoch planReap sees.
describe('createdAt seam round-trip (run label → docker ps → parse → planReap)', () => {
  // Pull a --label's value out of the run argv exactly as `docker ps --format {{.Label "k"}}` re-emits it.
  function labelValue(args: string[], key: string): string {
    const idx = args.findIndex((a, i) => args[i - 1] === '--label' && a.startsWith(`${key}=`));
    return idx >= 0 ? args[idx].slice(key.length + 1) : '';
  }

  it('threads the stamped epoch end-to-end and drives the age-based reap decision', () => {
    const sessionId = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
    const createdAt = NOW - 120 * MIN; // 2h old → past the 60min max-age
    const args = buildDetachedRunArgs({
      roots: ['/repo/kanban'], sessionId, rootLabel: '/repo/kanban', createdAt,
      credMount: { hostHome: '/host/home', containerHome: '/kanban-home' },
      image: 'kanban-terminal', containerName: 'kanban-term-xy',
    });
    // Reconstruct the exact `docker ps --format '{{.Names}}\t{{sess}}\t{{created}}'` line.
    const psLine = `kanban-term-xy\t${labelValue(args, SESSION_LABEL_KEY)}\t${labelValue(args, SESSION_CREATED_LABEL_KEY)}\n`;
    const rows = parsePsLines(psLine);
    // Fidelity: session id + createdAt epoch survive the whole hop, nothing dropped/mangled.
    expect(rows).toEqual([{ name: 'kanban-term-xy', session: sessionId, createdAtMs: createdAt }]);

    const reap = planReap({ rows, isTracked: untracked, now: NOW, config: CFG });
    expect(reap).toEqual([{ name: 'kanban-term-xy', session: sessionId, reason: 'max-age', ageMs: 120 * MIN }]);
  });
});

describe('startReaper', () => {
  it('arms the scheduler at the given interval, sweeps on tick, and stop() cancels', async () => {
    const rows = [row('c-old', 's-old', 120 * MIN)];
    const { docker, removed } = fakeDocker(rows);
    let captured: (() => void) | undefined;
    let armedMs = 0;
    const stopSpy = vi.fn();
    const scheduler = {
      every: vi.fn((intervalMs: number, cb: () => void) => { armedMs = intervalMs; captured = cb; return stopSpy; }),
    };

    const stop = startReaper({
      docker, isTracked: untracked, rootLabel: '/r', config: CFG, intervalMs: 1000, now: () => NOW, scheduler,
    });
    expect(armedMs).toBe(1000);

    captured?.(); // simulate one interval firing
    await vi.waitFor(() => expect(removed).toEqual(['c-old']));

    stop();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('default (node) scheduler returns a stop fn and never throws when armed + stopped', () => {
    const { docker } = fakeDocker([]);
    // Huge interval so the real timer never fires during the test; unref keeps it from holding the loop.
    const stop = startReaper({ docker, isTracked: untracked, rootLabel: '/r', config: CFG, intervalMs: 1_000_000 });
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });
});

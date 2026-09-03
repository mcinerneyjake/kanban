// tkt-999d1adc3aa4 — one case per dimension of the launcher's adversary list.
//
// The guarantee under test: `night:start` reports a started night ONLY when the runner itself
// confirmed its pre-flight, and every other outcome — a refused claim, an early exit, a FAILED
// verdict, silence to the deadline, a spawn that never happened — exits non-zero and says so. A
// launcher that cannot tell those apart is worse than none, because its success line is what an
// operator trusts before walking away.
//
// Everything is injected: spawn, the clock, the sentinel root, `ps`, and `process.kill`. No test
// touches the real `.night-run/` or `tickets/`, and the virtual clock keeps a 420s deadline a
// millisecond of wall time.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, readVerdict, ownerState, withinBoundary, CLAIM_WAIT_MS, DEFAULT_WAIT_MS, CONTROL_USAGE } from './night-control.mjs';
import { main as nightMain, run as nightRun, EXIT, PROBE_CAP_MS, sentinelPaths } from './night-run.mjs';

const A = 'tkt-00000000000a';
const B = 'tkt-00000000000b';
const PID = 424242;

// Fixtures live INSIDE the repo, not os.tmpdir(): no suite may write outside the workspace. The
// directory is gitignored and each test removes its own subtree.
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), '.tmp-test');

let root;
beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'night-control-'));
  mkdirSync(join(root, '.night-run'), { recursive: true });
  mkdirSync(join(root, 'tickets'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sink = () => {
  const s = { text: '' };
  s.write = (t) => { s.text += t; return true; };
  return s;
};

// A child that never really runs. `fire` is how a test decides WHEN it exits or fails to spawn.
const makeChild = (pid) => {
  const ls = {};
  return {
    pid,
    unrefs: 0,
    unref() { this.unrefs += 1; },
    on(ev, fn) { (ls[ev] ??= []).push(fn); return this; },
    fire(ev, ...a) { (ls[ev] ?? []).forEach((f) => f(...a)); },
  };
};

// Virtual time. `script` maps a poll number to the event that happens just before that poll, so a
// test says "the marker lands on the third poll" without sleeping.
const driver = (script = {}) => {
  let t = 0;
  let tick = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; tick += 1; script[tick]?.(); },
    ticks: () => tick,
  };
};

const claim = (pid) => writeFileSync(sentinelPaths(root).active, `${pid}\n`);

const harness = ({ script = {}, childPid = PID } = {}) => {
  const out = sink();
  const err = sink();
  const log = { path: null };
  const spawned = [];
  const killed = [];
  const child = makeChild(childPid);
  const d = driver(script);
  const deps = {
    resolveRoot: () => root,
    boundary: FIXTURES,
    spawnFn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
    openLog: (p) => { log.path = p; return openSync(p, 'a'); },
    now: d.now,
    sleep: d.sleep,
    alive: () => true,
    commandOf: () => `node ${join(root, 'scripts', 'night-run.mjs')} ${A}`,
    pgidOf: (pid) => pid, // launched detached ⇒ the runner leads its own group
    kill: (pid, sig) => killed.push([pid, sig]),
    out,
    err,
  };
  return { deps, out, err, log, spawned, killed, child, ticks: d.ticks };
};

const emit = (log, text) => appendFileSync(log.path, text);
const OK_LINE = 'pre-flight: merge guard arms and disarms correctly (probes: /x/preflight-probes.log)\n';

describe('readVerdict — the line that decides a night started', () => {
  it('reads the runner’s success line', () => {
    expect(readVerdict(`booting\n${OK_LINE}`)).toBe('ok');
  });

  // The control for the case above: silence is undecided, never success.
  it('returns null while the runner has said nothing', () => {
    expect(readVerdict('')).toBeNull();
    expect(readVerdict('took over a stale sentinel left by pid 12\n')).toBeNull();
  });

  it('reads the failure line, and prefers it over anything else in the log', () => {
    expect(readVerdict('pre-flight FAILED: the merge guard did not block\n')).toBe('failed');
    expect(readVerdict(`${OK_LINE}pre-flight FAILED: later\n`)).toBe('failed');
  });

  // Anchored, not a substring search: the runner's own inlined probe report quotes the phrase back.
  it('does not read a quoted mention mid-line as a verdict', () => {
    expect(readVerdict('the operator asked about pre-flight: was it ok?  see pre-flight FAILED docs')).toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults the deadline to both probe caps plus a margin', () => {
    expect(DEFAULT_WAIT_MS).toBe(PROBE_CAP_MS * 2 + 60_000);
    expect(parseArgs(['start', A]).waitMs).toBe(DEFAULT_WAIT_MS);
  });

  it('takes --no-wait, --now and --wait-seconds', () => {
    expect(parseArgs(['start', A, '--no-wait']).wait).toBe(false);
    expect(parseArgs(['stop', '--now']).hard).toBe(true);
    expect(parseArgs(['start', A, '--wait-seconds', '90']).waitMs).toBe(90_000);
  });

  // An unreadable value is a usage error, never a default — the same rule as CAP_SECONDS.
  it('rejects a non-numeric or unknown flag rather than defaulting', () => {
    expect(parseArgs(['start', A, '--wait-seconds', 'soon']).ok).toBe(false);
    expect(parseArgs(['start', A, '--wait-seconds', '0']).ok).toBe(false);
    expect(parseArgs(['start', A, '--turbo']).ok).toBe(false);
  });
});

describe('start — dimension: the ids, checked before anything is spawned', () => {
  it('refuses a malformed id and spawns nothing', async () => {
    const h = harness();
    expect(await main(['start', 'tkt-abc'], h.deps)).toBe(EXIT.usage);
    expect(h.spawned).toEqual([]);
    expect(h.err.text).toMatch(/not a ticket id: tkt-abc/);
  });

  it('refuses an empty queue', async () => {
    const h = harness();
    expect(await main(['start'], h.deps)).toBe(EXIT.usage);
    expect(h.spawned).toEqual([]);
  });

  it('refuses an unknown verb, and names the usage', async () => {
    const h = harness();
    expect(await main(['begin', A], h.deps)).toBe(EXIT.usage);
    expect(h.err.text).toContain(CONTROL_USAGE);
  });
});

describe('start — dimension: the spawn itself', () => {
  it('detaches, unrefs, and runs from the primary root so the runner can read tickets/', async () => {
    claim(PID);
    const h = harness({ script: { 1: () => emit(h.log, OK_LINE) } });
    await main(['start', A, B], h.deps);
    const [s] = h.spawned;
    expect(s.opts.detached).toBe(true);
    // `readStatus` reads <cwd>/tickets/<id>.md, and tickets/ is gitignored — a worktree cwd would
    // make every ticket read as unreadable.
    expect(s.opts.cwd).toBe(root);
    expect(s.args.slice(-2)).toEqual([A, B]);
    expect(h.child.unrefs).toBe(1);
  });

  it('reports a root it could not resolve rather than launching blind', async () => {
    const h = harness();
    h.deps.resolveRoot = () => null;
    expect(await main(['start', A], h.deps)).not.toBe(EXIT.ok);
    expect(h.spawned).toEqual([]);
  });

  // A spawn that fails emits 'error' and never 'exit'; without the listener this would sit out the
  // whole deadline before reporting a child that never existed.
  it('reports a spawn that failed outright', async () => {
    const h = harness({ script: { 1: () => h.child.fire('error', new Error('spawn ENOENT')) } });
    expect(await main(['start', A], h.deps)).toBe(EXIT.stopped);
    expect(h.err.text).toMatch(/could not be started.*ENOENT/s);
  });
});

describe('start — dimension: the claim, answered in five seconds', () => {
  it('surfaces a lost claim inside the claim window rather than waiting out the pre-flight deadline', async () => {
    claim(999999); // another run already holds it
    const h = harness();
    expect(await main(['start', A], h.deps)).toBe(EXIT.stopped);
    expect(h.err.text).toMatch(/did not claim the sentinel within 5s/);
    expect(h.err.text).toMatch(/pid 999999 already holds it/);
    // The whole point of the split wait: it gave up after the claim window, not the 420s one.
    expect(h.ticks() * 250).toBeLessThanOrEqual(CLAIM_WAIT_MS + 250);
  });

  it('reports a runner that died before claiming', async () => {
    const h = harness({ script: { 1: () => h.child.fire('exit', 64, null) } });
    expect(await main(['start', A], h.deps)).toBe(EXIT.stopped);
    expect(h.err.text).toMatch(/exited immediately \(code 64/);
  });

  it('--no-wait returns once the claim lands, and does not claim a pre-flight it never saw', async () => {
    claim(PID);
    const h = harness();
    expect(await main(['start', A, '--no-wait'], h.deps)).toBe(EXIT.ok);
    expect(h.out.text).toMatch(/pre-flight NOT waited for/);
    expect(h.out.text).not.toMatch(/pre-flight confirmed/);
  });
});

describe('start — dimension: the pre-flight verdict', () => {
  it('reports a started night only on the runner’s own success line', async () => {
    claim(PID);
    const h = harness({ script: { 3: () => emit(h.log, OK_LINE) } });
    expect(await main(['start', A], h.deps)).toBe(EXIT.ok);
    expect(h.out.text).toMatch(/pre-flight confirmed/);
    expect(h.out.text).toMatch(new RegExp(`night run started: pid ${PID}`));
    expect(h.out.text).toMatch(/queue: tkt-00000000000a/);
    expect(h.out.text).toMatch(/`gh pr merge` is now BLOCKED/);
  });

  it('exits non-zero on a FAILED verdict and prints the runner’s evidence verbatim', async () => {
    claim(PID);
    const h = harness({
      script: {
        2: () => emit(h.log, 'pre-flight FAILED: the merge guard did not block while a run was marked active\n=== armed probe — expected: refused ===\nRAN\n'),
      },
    });
    expect(await main(['start', A], h.deps)).toBe(EXIT.preflight);
    expect(h.err.text).toMatch(/pre-flight FAILED/);
    expect(h.err.text).toMatch(/=== armed probe — expected: refused ===/);
    expect(h.err.text).toMatch(/^RAN$/m);
    expect(h.out.text).not.toMatch(/night run started/);
  });

  // Exit 0 is the dangerous one: a runner that quit cleanly without ever reaching its pre-flight
  // must not read as a night that started.
  it('exits non-zero when the runner exits 0 before any verdict', async () => {
    claim(PID);
    const h = harness({ script: { 2: () => h.child.fire('exit', 0, null) } });
    expect(await main(['start', A], h.deps)).toBe(EXIT.preflight);
    expect(h.err.text).toMatch(/exited before reporting a pre-flight verdict \(code 0/);
    expect(h.out.text).not.toMatch(/night run started/);
  });

  it('exits non-zero when the runner exits non-zero before any verdict', async () => {
    claim(PID);
    const h = harness({ script: { 2: () => h.child.fire('exit', 1, null) } });
    expect(await main(['start', A], h.deps)).toBe(EXIT.preflight);
    expect(h.err.text).toMatch(/code 1/);
  });

  // THE DANGEROUS ONE. A leftover STOP file makes the runner pass pre-flight, break out of its
  // queue and disarm inside a single poll interval. Reading the verdict without checking liveness
  // announced that as a started night, with merges reported as gated and the sentinel already gone.
  it('refuses to call it a started night when the runner passed pre-flight and then exited', async () => {
    claim(PID);
    const h = harness({
      script: {
        2: () => {
          emit(h.log, OK_LINE);
          rmSync(sentinelPaths(root).active, { force: true }); // the runner disarms on its way out
          h.child.fire('exit', 0, null);
        },
      },
    });
    expect(await main(['start', A], h.deps)).toBe(EXIT.preflight);
    expect(h.out.text).not.toMatch(/night run started/);
    expect(h.out.text).not.toMatch(/is now BLOCKED/);
    expect(h.err.text).toMatch(/exited just after passing its pre-flight/);
    expect(h.err.text).toMatch(/no night was started/);
  });

  // The same shape with the sentinel taken over by somebody else rather than released.
  it('refuses when the sentinel is no longer held by the child it launched', async () => {
    claim(PID);
    const h = harness({
      script: { 2: () => { emit(h.log, OK_LINE); claim(777); } },
    });
    expect(await main(['start', A], h.deps)).toBe(EXIT.preflight);
    expect(h.err.text).toMatch(/now held by pid 777/);
  });

  // The control for both: still running, still holding ⇒ a real start.
  it('claims late and still reports a started night once the marker lands', async () => {
    const h = harness({ script: { 2: () => claim(PID), 4: () => emit(h.log, OK_LINE) } });
    expect(await main(['start', A], h.deps)).toBe(EXIT.ok);
    expect(h.out.text).toMatch(/night run started/);
  });

  // "Can't check" returns the failing answer — and slow is not broken, so the child is left alone.
  it('exits non-zero on silence to the deadline, without killing the runner', async () => {
    claim(PID);
    const h = harness();
    expect(await main(['start', A, '--wait-seconds', '10'], h.deps)).toBe(EXIT.preflight);
    expect(h.err.text).toMatch(/pre-flight NOT confirmed after 10s/);
    expect(h.err.text).toMatch(/has NOT been killed/);
    expect(h.killed).toEqual([]);
    expect(h.out.text).not.toMatch(/night run started/);
  });
});

describe('ownerState — dimension: who holds the sentinel', () => {
  const state = (over = {}) => ownerState(root, { alive: () => true, commandOf: () => 'node scripts/night-run.mjs tkt-00000000000a', ...over });

  it('absent when no sentinel is armed', () => {
    expect(state().kind).toBe('absent');
  });

  it('live when the owner is alive AND is a night run, and reads its queue off the command line', () => {
    claim(PID);
    const s = state();
    expect(s.kind).toBe('live');
    expect(s.pid).toBe(PID);
    expect(s.queue).toEqual([A]);
  });

  // A checkout under `.claude/worktrees/tkt-<id>-slug` carries a ticket id in the RUNNER PATH. A
  // scrape of the whole command string reports it as queued work nobody queued.
  it('does not read a ticket id out of the runner’s own path', () => {
    claim(PID);
    const s = state({ commandOf: () => `node /w/.claude/worktrees/tkt-999d1adc3aa4-x/scripts/night-run.mjs ${A}` });
    expect(s.queue).toEqual([A]);
  });

  // The case above is carried entirely by the whole-token regex — the path segment never matches it
  // either way, so it passed with the `slice(at + 1)` anchor DELETED (measured). This one is the
  // real control for the anchor: a bare id token sitting BEFORE the runner path.
  it('reads no id from a bare token appearing before the runner path', () => {
    claim(PID);
    const s = state({ commandOf: () => `node --title tkt-999d1adc3aa4 /w/scripts/night-run.mjs ${A}` });
    expect(s.queue).toEqual([A]);
  });

  // pidAlive alone answers the wrong question: pids get reused.
  it('foreign when the owner pid is alive but is not a night run', () => {
    claim(PID);
    expect(state({ commandOf: () => '/Applications/SomeEditor -w' }).kind).toBe('foreign');
  });

  it('dead when the owner is gone', () => {
    claim(PID);
    expect(state({ alive: () => false }).kind).toBe('dead');
  });

  it('unreadable when the sentinel holds no parseable pid', () => {
    writeFileSync(sentinelPaths(root).active, 'not-a-pid\n');
    expect(state().kind).toBe('unreadable');
  });

  // `ps` failing is "cannot confirm", which must not collapse into `live`.
  it('unknown-command when ps cannot answer', () => {
    claim(PID);
    expect(state({ commandOf: () => null }).kind).toBe('unknown-command');
  });
});

describe('status — dimension: what an operator is told', () => {
  const run = (over = {}) => {
    const h = harness();
    Object.assign(h.deps, over);
    return main(['status'], h.deps).then((code) => ({ code, ...h }));
  };

  it('says plainly that nothing is running rather than printing a hopeful blank', async () => {
    const r = await run();
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.text).toMatch(/sentinel: NOT armed/);
    expect(r.out.text).toMatch(/is not gated here/);
  });

  it('names the pid, the queue and the armed gate for a live run', async () => {
    claim(PID);
    const r = await run();
    expect(r.out.text).toMatch(/sentinel: ARMED/);
    expect(r.out.text).toMatch(new RegExp(`owner: pid ${PID}, alive, running night-run.mjs`));
    expect(r.out.text).toMatch(/queue: tkt-00000000000a/);
    expect(r.out.text).toMatch(/is BLOCKED in this checkout/);
  });

  it('calls a reused pid stale rather than reporting a healthy night', async () => {
    claim(PID);
    const r = await run({ commandOf: () => '/Applications/SomeEditor -w' });
    expect(r.out.text).toMatch(/is NOT a night run — stale, reused pid/);
    expect(r.out.text).not.toMatch(/alive, running night-run\.mjs/);
  });

  it('reports a crashed run that left the gate armed', async () => {
    claim(PID);
    const r = await run({ alive: () => false });
    expect(r.out.text).toMatch(/is GONE — a crashed run left the gate armed/);
  });

  it('reports an unparseable pid rather than guessing', async () => {
    writeFileSync(sentinelPaths(root).active, 'garbage\n');
    const r = await run();
    expect(r.out.text).toMatch(/pid could not be parsed/);
  });

  // The newest runner log outlives the run that wrote it, so the in-flight block must be gated on a
  // live owner rather than on the log existing.
  it('does not report a ticket in flight once the run has finished', async () => {
    writeFileSync(join(root, '.night-run', 'runner-2026-01-01.log'), `${OK_LINE}\n--- ${A}  (was todo)\n`);
    const r = await run();
    expect(r.out.text).toMatch(/sentinel: NOT armed/);
    expect(r.out.text).not.toMatch(/in flight:/);
  });

  it('exits non-zero when the root cannot be resolved', async () => {
    const r = await run({ resolveRoot: () => null });
    expect(r.code).not.toBe(EXIT.ok);
  });

  it('shows STOP, the newest runner log, the ticket in flight and its live tail', async () => {
    claim(PID);
    writeFileSync(sentinelPaths(root).stop, '');
    writeFileSync(join(root, '.night-run', 'runner-2026-01-01.log'), `${OK_LINE}\n--- ${A}  (was todo)\n`);
    const dir = join(root, '.night-run', '2026-01-01T00-00-00-000Z');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${A}.live.log`), 'assistant: reading the ticket\n');
    const r = await run();
    expect(r.out.text).toMatch(/STOP: present/);
    expect(r.out.text).toMatch(/runner log: runner-2026-01-01\.log/);
    expect(r.out.text).toMatch(new RegExp(`in flight: ${A}`));
    expect(r.out.text).toMatch(/assistant: reading the ticket/);
  });
});

describe('stop — dimension: one actor, and the wrong actor', () => {
  it('writes the STOP file so the queue ends after the ticket in flight', async () => {
    claim(PID);
    const h = harness();
    expect(await main(['stop'], h.deps)).toBe(EXIT.ok);
    expect(existsSync(sentinelPaths(root).stop)).toBe(true);
    expect(h.out.text).toMatch(/ends cleanly after the ticket in flight/);
  });

  // The landmine: a STOP written with nothing armed is never consumed by the run it was meant for,
  // and silently no-ops the NEXT night into reporting a clean run of zero tickets.
  it('writes NO STOP file when nothing is running', async () => {
    const h = harness();
    expect(await main(['stop'], h.deps)).toBe(EXIT.ok);
    expect(existsSync(sentinelPaths(root).stop)).toBe(false);
    expect(h.out.text).toMatch(/no STOP file was written/);
  });

  // The GROUP, not the pid: the runner's handler disarms the sentinel but never kills the `claude`
  // session it spawned, so signalling the pid alone removes the merge gate and leaves a live
  // auto-pr session free to merge.
  it('--now signals the whole process group of a confirmed night run', async () => {
    claim(PID);
    const h = harness();
    expect(await main(['stop', '--now'], h.deps)).toBe(EXIT.ok);
    expect(h.killed).toEqual([[-PID, 'SIGTERM']]);
    expect(h.out.text).toMatch(/process group/);
  });

  // The control for the case above, and the honest half: a runner that does not lead its own group
  // cannot have its child reached, and the operator is told so rather than reassured.
  it('--now falls back to the pid alone when the owner leads no group, and says the child may survive', async () => {
    claim(PID);
    const h = harness();
    h.deps.pgidOf = () => 999;
    expect(await main(['stop', '--now'], h.deps)).toBe(EXIT.ok);
    expect(h.killed).toEqual([[PID, 'SIGTERM']]);
    expect(h.out.text).toMatch(/may SURVIVE this signal/);
  });

  // The safety property: a reused pid belongs to a stranger, and tidying our own file must never
  // kill their process.
  it('--now refuses to signal a pid it could not confirm', async () => {
    claim(PID);
    const h = harness();
    h.deps.commandOf = () => '/Applications/SomeEditor -w';
    expect(await main(['stop', '--now'], h.deps)).toBe(EXIT.stopped);
    expect(h.killed).toEqual([]);
    expect(h.err.text).toMatch(/refusing to signal pid/);
  });

  it('--now signals nothing when ps cannot confirm the owner either', async () => {
    claim(PID);
    const h = harness();
    h.deps.commandOf = () => null;
    expect(await main(['stop', '--now'], h.deps)).toBe(EXIT.stopped);
    expect(h.killed).toEqual([]);
  });

  it('--now says there is nothing to signal when the owner is already gone', async () => {
    claim(PID);
    const h = harness();
    h.deps.alive = () => false;
    expect(await main(['stop', '--now'], h.deps)).toBe(EXIT.ok);
    expect(h.killed).toEqual([]);
  });
});

// The seam: `night:stop` writes the file, `night-run` reads it, acts on it and CONSUMES it. Before
// this ticket nothing removed it, so one stop silenced every later night — each printing "STOP file
// present" and returning EXIT.ok, a run that did nothing and reported a clean night.
describe('the STOP round trip — night:stop writes it, the runner consumes it', () => {
  const seed = (id, status) =>
    writeFileSync(join(root, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: ${status}\n---\nbody\n`);
  const passingProbe = () => {
    let call = 0;
    return () => Promise.resolve(call++ === 0
      ? { code: 0, out: 'BLOCKED', capped: false }
      : { code: 0, out: '', capped: false });
  };
  const sessionStub = () => {
    const fn = (id) => { fn.calls.push(id); seed(id, 'qa'); return Promise.resolve({ code: 0, out: '', capped: false }); };
    fn.calls = [];
    return fn;
  };
  const nightOpts = (extra) => ({ resolveSentinelRoot: () => root, env: {}, spawnProbe: passingProbe(), ...extra });

  // The control: with no STOP file the queue runs. Without it, "the queue stopped" proves nothing.
  it('absent — the queue runs', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    expect(await nightMain([A], root, nightOpts({ runSession }))).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([A]);
  });

  it('present — the queue stops AND the file is gone, so the next night is not silenced', async () => {
    seed(A, 'todo');
    // The real round trip: `stop` refuses to write a STOP file unless something is armed, so the
    // sentinel is claimed first and then released the way a dying runner would leave it.
    claim(PID);
    const h = harness();
    h.deps.alive = () => true;
    await main(['stop'], h.deps);
    expect(existsSync(sentinelPaths(root).stop)).toBe(true);
    rmSync(sentinelPaths(root).active, { force: true });
    const runSession = sessionStub();
    await nightMain([A], root, nightOpts({ runSession }));
    expect(runSession.calls).toEqual([]);
    expect(existsSync(sentinelPaths(root).stop)).toBe(false);

    // The point of consuming it: a second run is free again.
    const second = sessionStub();
    expect(await nightMain([A], root, nightOpts({ runSession: second }))).toBe(EXIT.ok);
    expect(second.calls).toEqual([A]);
  });

  // The loop only checks STOP between tickets, so one written during the LAST ticket is never seen
  // there and used to survive the run — silencing the NEXT night instead of this one.
  it('a STOP written during the final ticket does not outlive the run', async () => {
    seed(A, 'todo');
    const runSession = (id) => {
      seed(id, 'qa');
      writeFileSync(sentinelPaths(root).stop, ''); // arrives while the last ticket is in flight
      return Promise.resolve({ code: 0, out: '', capped: false });
    };
    expect(await nightMain([A], root, nightOpts({ runSession }))).toBe(EXIT.ok);
    expect(existsSync(sentinelPaths(root).stop)).toBe(false);
  });

  // Removal is best-effort; failing it must still stop (the safe direction) and must be LOUD, since
  // a silent failure is the original defect wearing a fix. A directory is the portable way to make
  // a non-recursive rmSync fail.
  it('present and unremovable — still stops, and says so loudly', async () => {
    seed(A, 'todo');
    mkdirSync(sentinelPaths(root).stop, { recursive: true });
    const runSession = sessionStub();
    const written = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (t) => { written.push(String(t)); return true; };
    try {
      await nightMain([A], root, nightOpts({ runSession }));
    } finally {
      process.stdout.write = realWrite;
    }
    expect(runSession.calls).toEqual([]);
    expect(written.join('')).toMatch(/could NOT be removed/);
    expect(existsSync(sentinelPaths(root).stop)).toBe(true);
  });
});

// Confinement: the launcher may only ever act inside the workspace it was told about.
describe('withinBoundary — dimension: where the runner is allowed to live', () => {
  it('allows a root inside the boundary, and the boundary itself', () => {
    expect(withinBoundary('/w/projects/repo', '/w').ok).toBe(true);
    expect(withinBoundary('/w', '/w').ok).toBe(true);
  });

  it('refuses a root outside the boundary', () => {
    expect(withinBoundary('/elsewhere/repo', '/w').ok).toBe(false);
  });

  // The prefix trap: a bare startsWith accepts a SIBLING whose name merely begins with the
  // boundary's. Without the separator this passes and the confinement is decorative.
  it('refuses a sibling whose path merely begins with the boundary', () => {
    const r = withinBoundary('/w-other/repo', '/w');
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/outside NIGHT_RUN_BOUNDARY/);
  });

  // "Cannot check" returns the failing answer; an unset boundary is a refusal, never a default.
  it('refuses when no boundary is configured at all', () => {
    expect(withinBoundary('/w/repo', undefined).ok).toBe(false);
    expect(withinBoundary('/w/repo', '').ok).toBe(false);
  });

  // A relative boundary means a different directory depending on where it was invoked from.
  it('refuses a relative boundary rather than binding it to the cwd', () => {
    const r = withinBoundary('/w/repo', '../w');
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/must be an absolute path/);
  });

  // `b + sep` is `//` at the filesystem root, which nothing starts with — that spelling refused
  // every path but `/` itself.
  it('handles a boundary that is the filesystem root, and a trailing separator', () => {
    expect(withinBoundary('/w/repo', '/').ok).toBe(true);
    expect(withinBoundary('/w/repo', '/w/').ok).toBe(true);
  });
});

describe('confinement — start is bounded; status and stop must stay reachable', () => {
  const outside = (verb, extra = []) => {
    const h = harness();
    h.deps.boundary = join(FIXTURES, 'somewhere-else');
    return main([verb, ...extra], h.deps).then((code) => ({ code, ...h }));
  };

  it('start refuses to spawn anything outside the boundary', async () => {
    const r = await outside('start', [A]);
    expect(r.code).not.toBe(EXIT.ok);
    expect(r.spawned).toEqual([]);
    expect(r.err.text).toMatch(/outside NIGHT_RUN_BOUNDARY/);
  });

  it('start refuses outright when no boundary is configured', async () => {
    const h = harness();
    h.deps.boundary = undefined;
    expect(await main(['start', A], h.deps)).not.toBe(EXIT.ok);
    expect(h.spawned).toEqual([]);
    expect(h.err.text).toMatch(/NIGHT_RUN_BOUNDARY is not set/);
  });

  // Narrowing the check to cover these too was a denial of service on the RECOVERY path: inside a
  // worktree the variable is unset, and an operator whose merges are gated could no longer look at
  // the run or end it. Both act only on this repo's own resolved root, so neither can wander.
  it('status still answers with no boundary configured at all', async () => {
    const h = harness();
    h.deps.boundary = undefined;
    expect(await main(['status'], h.deps)).toBe(EXIT.ok);
    expect(h.out.text).toMatch(/sentinel: NOT armed/);
  });

  it('stop can still end a live run with no boundary configured', async () => {
    claim(PID);
    const h = harness();
    h.deps.boundary = undefined;
    expect(await main(['stop'], h.deps)).toBe(EXIT.ok);
    expect(existsSync(sentinelPaths(root).stop)).toBe(true);
  });
});

// Edit (c). The tee is what `night:status` tails to show a run is still moving, and it was reachable
// by no test at all — every case injects its own runSession, so the production wiring was dead code
// in the suite (review, LOW).
describe('the live tee — both halves of the seam', () => {
  const seed = (id, status) =>
    writeFileSync(join(root, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: ${status}\n---\nbody\n`);
  const passingProbe = () => {
    let call = 0;
    return () => Promise.resolve(call++ === 0
      ? { code: 0, out: 'BLOCKED', capped: false }
      : { code: 0, out: '', capped: false });
  };

  it('main hands the session a logDir to tee into', async () => {
    seed(A, 'todo');
    const seen = [];
    const runSession = (id, opts) => { seen.push(opts); seed(id, 'qa'); return Promise.resolve({ code: 0, out: '', capped: false }); };
    await nightMain([A], root, { resolveSentinelRoot: () => root, env: {}, spawnProbe: passingProbe(), runSession });
    expect(seen).toHaveLength(1);
    expect(typeof seen[0].logDir).toBe('string');
    expect(existsSync(seen[0].logDir)).toBe(true);
  });

  // The other half: `run`'s onOutput actually streams, so appending it to a file produces the tail.
  it('run streams output to onOutput as it arrives', async () => {
    const live = join(root, 'streamed.log');
    const res = await nightRun(process.execPath, ['-e', 'process.stdout.write("chunk-one\\n")'], {
      onOutput: (chunk) => appendFileSync(live, chunk),
    });
    expect(res.code).toBe(0);
    expect(readFileSync(live, 'utf8')).toMatch(/chunk-one/);
  });
});

describe('summary.json — the machine-readable record tkt-4ea4e17f1419 reads', () => {
  const seed = (id, status) =>
    writeFileSync(join(root, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: ${status}\n---\nbody\n`);
  const probe = (armed) => () => {
    let call = 0;
    return () => Promise.resolve(call++ === 0
      ? { code: 0, out: armed, capped: false }
      : { code: 0, out: '', capped: false });
  };
  const latestSummary = () => {
    const dir = join(root, '.night-run');
    const stampDir = readdirSync(dir).filter((n) => /^\d{4}-/.test(n)).sort().at(-1);
    return JSON.parse(readFileSync(join(dir, stampDir, 'summary.json'), 'utf8'));
  };

  it('records every ticket’s transition straight from classify, with the run’s exit', async () => {
    seed(A, 'todo');
    const runSession = (id) => { seed(id, 'qa'); return Promise.resolve({ code: 0, out: '', capped: false }); };
    await nightMain([A], root, { resolveSentinelRoot: () => root, env: {}, spawnProbe: probe('BLOCKED')(), runSession });
    const s = latestSummary();
    expect(s.queue).toEqual([A]);
    expect(s.exit).toBe(EXIT.ok);
    expect(s.results).toHaveLength(1);
    expect(s.results[0]).toMatchObject({ id: A, before: 'todo', after: 'qa', level: 'ok' });
  });

  // The night worth reading is the one that aborted, so the record must exist on that path too.
  it('is written even when the pre-flight aborts before any ticket runs', async () => {
    seed(A, 'todo');
    await nightMain([A], root, { resolveSentinelRoot: () => root, env: {}, spawnProbe: probe('RAN')(), runSession: () => Promise.resolve({ code: 0, out: '' }) });
    const s = latestSummary();
    expect(s.exit).toBe(EXIT.preflight);
    expect(s.results).toEqual([]);
  });
});

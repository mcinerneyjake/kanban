// tkt-4f8d07e0810d — one case per dimension of the adversary list on the ticket, plus one per
// finding from the high-effort review that swept the dimensions the first draft missed.
//
// The guarantee under test: an unattended queue never continues past a state that needs a human, and
// never leaves the sentinel behind. Every stopping case is paired with a continuing control, because
// a runner that stops on everything is as useless as one that stops on nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, gateFailed, describe as describeResult, readStatus, guardBlocked,
  arm, disarm, claimSentinel, ownerOf, pidAlive, fileHere, sentinelPaths,
  preflightGuard, main, run, sessionArgs, capMsFrom, USAGE, EXIT, MERGE_PROBE_PAYLOAD,
} from './night-run.mjs';

let board;
beforeEach(() => {
  board = mkdtempSync(join(tmpdir(), 'night-run-'));
  mkdirSync(join(board, 'tickets'), { recursive: true });
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

const seed = (id, status) =>
  writeFileSync(join(board, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: ${status}\n---\nbody\n`);

const A = 'tkt-00000000000a';
const B = 'tkt-00000000000b';
const C = 'tkt-00000000000c';

// A pre-flight that passes: BLOCKED while armed, then exit 0 while disarmed.
const passingProbe = () => {
  let call = 0;
  return () => Promise.resolve(call++ === 0
    ? { code: 0, out: 'BLOCKED', capped: false }
    : { code: 0, out: '', capped: false });
};

// Records which tickets were actually driven, and applies each one's outcome to the board so the
// classifier reads a real transition rather than a stubbed verdict.
const sessionStub = (outcomes = {}) => {
  const fn = (id) => {
    fn.calls.push(id);
    const o = outcomes[id] ?? { status: 'qa' };
    if (o.status) seed(id, o.status);
    if (o.thenStop) writeFileSync(sentinelPaths(board).stop, '');
    return Promise.resolve({ code: o.code ?? 0, out: o.log ?? '', capped: o.capped ?? false });
  };
  fn.calls = [];
  return fn;
};

// main() resolves the sentinel root through the guard; tests point it at the temp board.
const opts = (extra = {}) => ({ resolveSentinelRoot: () => board, env: {}, ...extra });

// Polls rather than sleeping a fixed interval: the child has to spawn, import and clear its
// pre-flight before it arms, and a fixed wait would be either flaky or slow.
const waitFor = async (pred, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

describe('classify — dimension 1: the status transition', () => {
  it('todo → qa is the intended outcome and continues', () => {
    const r = classify({ before: 'todo', after: 'qa' });
    expect(r.level).toBe('ok');
    expect(r.stop).toBe(false);
  });

  // The row missing from the first draft of the design, and the one that matters most: under this
  // design a done ticket means the merge gate was crossed unattended.
  it('→ done is an ALARM and stops the night', () => {
    const r = classify({ before: 'todo', after: 'done' });
    expect(r.level).toBe('alarm');
    expect(r.stop).toBe(true);
    expect(r.text).toMatch(/merge gate was crossed/i);
  });

  it('→ in-progress stops the queue', () => {
    expect(classify({ before: 'todo', after: 'in-progress' }).stop).toBe(true);
  });

  // The control for "stops the queue": a failed premise is a normal outcome and must NOT stop it.
  it('→ backlog continues, because a failed premise is routine', () => {
    const r = classify({ before: 'todo', after: 'backlog' });
    expect(r.level).toBe('skip');
    expect(r.stop).toBe(false);
  });

  it('an unchanged status reads as never started, not as success', () => {
    const r = classify({ before: 'todo', after: 'todo' });
    expect(r.level).not.toBe('ok');
    expect(r.stop).toBe(false);
  });

  it('an unreadable status stops rather than assuming success', () => {
    const r = classify({ before: 'todo', after: null });
    expect(r.level).toBe('note');
    expect(r.stop).toBe(true);
  });

  // A ticket already in qa would score as success on an absolute reading, without the run having
  // done anything — which is why the classifier takes a transition.
  it('qa → qa is NOT reported as a fresh success', () => {
    expect(classify({ before: 'qa', after: 'qa' }).level).not.toBe('ok');
  });

  // With before=null the equality test above is false, so the transition check collapsed back into
  // the absolute reading and a ticket already in qa scored a fresh success (review, MEDIUM).
  it('an unreadable BEFORE cannot prove a transition, so qa is not a success', () => {
    const r = classify({ before: null, after: 'qa' });
    expect(r.level).not.toBe('ok');
    expect(r.stop).toBe(true);
  });
});

describe('classify — dimension 2: how the run exited', () => {
  it('a capped run is never success, even if the status looks right', () => {
    const r = classify({ before: 'todo', after: 'qa', capped: true });
    expect(r.level).toBe('capped');
    expect(r.stop).toBe(true);
  });
});

describe('describe — dimension 7: gate-failure evidence changes the wording', () => {
  it('a halt with a failing gate is reported as UNDIAGNOSED, not a broken branch', () => {
    const r = classify({ before: 'todo', after: 'in-progress' });
    const text = describeResult(r, 'Tests  3 failed | 40 passed');
    expect(text).toMatch(/undiagnosed/i);
  });

  // The control. Without it the wording would be unconditional and carry no information.
  it('a halt with no gate failure is not called undiagnosed', () => {
    const r = classify({ before: 'todo', after: 'in-progress' });
    expect(describeResult(r, 'all good, stopped at a hard stop')).not.toMatch(/undiagnosed/i);
  });

  it.each([
    ['Tests  2 failed | 10 passed', true],
    ['typecheck failed', true],
    ['Tests  1772 passed (1772)', false],
    ['', false],
    // Both measured against the first draft, which scanned the whole transcript for /\d+ failed/:
    // a green run and a sentence the model wrote both read as a gate failure, so nearly every halt
    // was labelled UNDIAGNOSED (review, MEDIUM).
    ['Tests  0 failed | 12 passed', false],
    ['earlier that run 3 failed, but I fixed them', false],
  ])('gateFailed(%s) === %s', (log, want) => {
    expect(gateFailed(log)).toBe(want);
  });
});

describe('guardBlocked — the armed half of the control', () => {
  it('accepts the reply we asked for', () => {
    expect(guardBlocked('BLOCKED')).toBe(true);
  });

  it('accepts the hook own marker, which the model cannot author', () => {
    expect(guardBlocked('[guard-unattended-merge] Blocked: tried to merge a pull request')).toBe(true);
  });

  // The fail-open that sat in the single check the whole design rests on: a bare /BLOCKED/ substring
  // test passes on its own negation (review, HIGH — measured).
  it('REJECTS a sentence that merely contains the word, including its own negation', () => {
    expect(guardBlocked('The command was not BLOCKED — it RAN.')).toBe(false);
  });

  it('rejects a plain RAN', () => {
    expect(guardBlocked('RAN')).toBe(false);
  });

  it('rejects silence', () => {
    expect(guardBlocked('')).toBe(false);
  });
});

describe('capMsFrom — dimension 2, and the cap that removed itself', () => {
  it('defaults when unset', () => {
    expect(capMsFrom(undefined)).toEqual({ ok: true, capMs: 2700 * 1000 });
  });

  it('accepts a positive number of seconds', () => {
    expect(capMsFrom('60')).toEqual({ ok: true, capMs: 60_000 });
  });

  // `Number('abc') * 1000` is NaN, which is falsy, so the first draft silently ran with no cap at
  // all (review, MEDIUM).
  it.each(['abc', '0', '-5', ''])('rejects %s rather than silently disabling the cap', (raw) => {
    expect(capMsFrom(raw).ok).toBe(false);
  });
});

describe('readStatus — dimension 1, reading the board', () => {
  it('reads a real status', () => {
    seed('tkt-000000000001', 'qa');
    expect(readStatus(board, 'tkt-000000000001')).toBe('qa');
  });

  it('returns null for a missing ticket rather than throwing', () => {
    expect(readStatus(board, 'tkt-00000000dead')).toBeNull();
  });
});

describe('fileHere — the STOP check that must not fail open', () => {
  it('reports a present file', () => {
    const p = join(board, 'here');
    writeFileSync(p, '');
    expect(fileHere(p)).toBe(true);
  });

  it('reports a genuinely absent file', () => {
    expect(fileHere(join(board, 'nope'))).toBe(false);
  });

  // guard-unattended-merge.mjs documents rejecting existsSync for exactly this: only ENOENT may
  // permit, so anything else — an unreadable parent, EACCES — must read as present.
  it('treats a non-ENOENT error as present rather than absent', () => {
    const file = join(board, 'a-file');
    writeFileSync(file, '');
    // Descending THROUGH a regular file yields ENOTDIR, not ENOENT — the shape existsSync would
    // swallow into a false "absent".
    expect(fileHere(join(file, 'through'))).toBe(true);
  });
});

describe('sentinel lifecycle and ownership — dimension 3, and two actors', () => {
  it('arm creates it and disarm removes it', () => {
    const { active } = sentinelPaths(board);
    arm(board);
    expect(existsSync(active)).toBe(true);
    disarm(board);
    expect(existsSync(active)).toBe(false);
  });

  it('disarm on an already-absent sentinel does not throw', () => {
    expect(() => disarm(board)).not.toThrow();
  });

  it('a fresh claim writes this process as the owner', () => {
    expect(claimSentinel(board)).toEqual({ ok: true });
    expect(ownerOf(board)).toBe(process.pid);
  });

  // The first draft disarmed and re-armed unconditionally, so a second runner deleted the first
  // one's gate mid-queue and its live sessions could merge (review, HIGH).
  it('refuses to claim a sentinel a LIVE owner already holds', () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    const res = claimSentinel(board, { pid: 99, alive: () => true });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/already holds/i);
    expect(ownerOf(board)).toBe(4242); // the incumbent keeps it
  });

  // The control for the case above, and the only thing that stops one crash wedging every later
  // merge: an owner that is gone left a leak, not a run.
  it('takes over a sentinel whose owner is gone', () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    const res = claimSentinel(board, { pid: 99, alive: () => false });
    expect(res.ok).toBe(true);
    expect(res.tookOver).toBe(4242);
    expect(ownerOf(board)).toBe(99);
  });

  it('refuses when a sentinel exists but its owner cannot be read', () => {
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(sentinelPaths(board).active, 'not-a-pid\n');
    const res = claimSentinel(board, { pid: 99, alive: () => false });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/could not be read/i);
  });

  it('disarm refuses to remove a sentinel this process does not own', () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    expect(disarm(board, { pid: 99 })).toBe(false);
    expect(existsSync(sentinelPaths(board).active)).toBe(true);
  });

  it('pidAlive says yes for this process and no for a pid that cannot exist', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30, () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; })).toBe(false);
  });

  // The third case of this dimension, and the only one that cannot be driven in-process: the handler
  // ends with process.exit. A run killed mid-ticket must still clear the sentinel, because a leaked
  // one silently blocks every later merge. SIGHUP is here because an ssh session dropping is the
  // likeliest overnight death of the three (review, MEDIUM/HIGH), and each signal is its own
  // registration — one missing cleanup() is invisible to a test that sends only the others.
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('clears the sentinel when the run is killed with %s mid-ticket', async (signal) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const driver = join(board, 'driver.mjs');
    writeFileSync(driver, `
      import { main } from ${JSON.stringify(join(here, 'night-run.mjs'))};
      let c = 0;
      const spawnProbe = () => Promise.resolve(c++ === 0 ? { code: 0, out: 'BLOCKED' } : { code: 0, out: '' });
      // Parked mid-ticket when the signal arrives. The timer is load-bearing: a bare never-resolving
      // promise holds nothing on the event loop, so the child drains and exits before the signal —
      // which is what this stub did first, and it looked exactly like a leaked sentinel.
      const runSession = () => new Promise(() => { setTimeout(() => {}, 60000); });
      main([${JSON.stringify(A)}], ${JSON.stringify(board)}, {
        spawnProbe, runSession, env: {}, resolveSentinelRoot: () => ${JSON.stringify(board)},
      });
    `);
    seed(A, 'todo');

    const child = spawn(process.execPath, [driver], { stdio: 'ignore' });
    const { active } = sentinelPaths(board);
    try {
      const armedByChild = await waitFor(() => existsSync(active));
      expect(armedByChild).toBe(true); // control: it really was armed before the signal

      const exited = new Promise((resolve) => child.on('close', resolve));
      child.kill(signal);
      await exited;
      expect(existsSync(active)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('a crash mid-run — the other half of dimension 3', () => {
  // The signals above cover a killed run; an uncaught throw in a stream handler is the other way an
  // overnight run dies without reaching the finally, and it leaks the same sentinel (review,
  // MEDIUM/HIGH). Asserts the exit code too, so a crash cannot report the night as clean.
  it('clears the sentinel and exits non-zero when something throws uncaught', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const driver = join(board, 'crash.mjs');
    writeFileSync(driver, `
      import { main } from ${JSON.stringify(join(here, 'night-run.mjs'))};
      let c = 0;
      const spawnProbe = () => Promise.resolve(c++ === 0 ? { code: 0, out: 'BLOCKED' } : { code: 0, out: '' });
      const runSession = () => new Promise(() => { setTimeout(() => { throw new Error('boom'); }, 150); });
      main([${JSON.stringify(A)}], ${JSON.stringify(board)}, {
        spawnProbe, runSession, env: {}, resolveSentinelRoot: () => ${JSON.stringify(board)},
      });
    `);
    seed(A, 'todo');

    const child = spawn(process.execPath, [driver], { stdio: 'ignore' });
    const { active } = sentinelPaths(board);
    try {
      expect(await waitFor(() => existsSync(active))).toBe(true); // control: armed before the crash
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(existsSync(active)).toBe(false);
      expect(code).not.toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('run — dimension 2, exercised directly rather than stubbed', () => {
  it('resolves with code -1 when the binary does not exist, instead of hanging', async () => {
    const res = await run('definitely-not-a-real-binary-xyz', []);
    expect(res.code).toBe(-1);
  });

  // The cap is a request until it escalates: a child that ignores SIGTERM would otherwise keep the
  // night parked until morning with the sentinel armed (review, MEDIUM).
  it('caps a child that ignores SIGTERM, by escalating to SIGKILL', async () => {
    const res = await run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      capMs: 150,
      graceMs: 150,
    });
    expect(res.capped).toBe(true);
  });

  it('does not mark a fast, clean child as capped', async () => {
    const res = await run(process.execPath, ['-e', 'process.exit(0)'], { capMs: 5000 });
    expect(res.capped).toBe(false);
    expect(res.code).toBe(0);
  });
});

describe('preflightGuard — dimension 4', () => {
  const armedProbe = () => Promise.resolve({ code: 0, out: 'BLOCKED', capped: false });
  const hookOk = () => Promise.resolve({ code: 0, out: '', capped: false });

  it('passes when the guard blocks while armed and permits while disarmed', async () => {
    arm(board);
    let call = 0;
    const spawnProbe = () => (call++ === 0 ? armedProbe() : hookOk());
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(true);
    expect(existsSync(sentinelPaths(board).active)).toBe(true); // re-armed for the night
  });

  it('aborts when the guard does NOT block while armed', async () => {
    arm(board);
    const spawnProbe = () => Promise.resolve({ code: 0, out: 'RAN', capped: false });
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/did not block/i);
  });

  // Without this half, a guard that blocks unconditionally would pass the pre-flight and prove
  // nothing about whether it discriminates.
  it('aborts when the guard is stuck on — blocking with no run active', async () => {
    arm(board);
    let call = 0;
    const spawnProbe = () => (call++ === 0 ? armedProbe() : Promise.resolve({ code: 2, out: '', capped: false }));
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/stuck on, or the launcher itself failed to load/i);
  });

  // The sentinel is claimed before the probes run, so a hung probe parks the night with every merge
  // blocked and no ticket run (review, MEDIUM).
  it.each([0, 1])('aborts when probe %i times out rather than hanging the night', async (which) => {
    arm(board);
    let call = 0;
    const spawnProbe = () => {
      const capped = call++ === which;
      return Promise.resolve({ code: 0, out: capped ? '' : 'BLOCKED', capped });
    };
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/timed out/i);
  });

  it('passes a timeout to both probes, so neither can hang unbounded', async () => {
    arm(board);
    const seen = [];
    let call = 0;
    const spawnProbe = (cmd, args, o) => { seen.push(o); return call++ === 0 ? armedProbe() : hookOk(); };
    await preflightGuard(board, { spawnProbe });
    expect(seen.every((o) => typeof o?.capMs === 'number' && o.capMs > 0)).toBe(true);
  });

  // The disarmed half must drive the SAME command shape the armed half is refused. With no stdin the
  // launcher never reaches its merge branch, so it exits 0 whatever the gate would do to a merge —
  // measured 2026-09-03, and the reason the payload is passed explicitly rather than left empty.
  it('drives the disarmed probe with a merge-shaped payload on stdin', async () => {
    arm(board);
    const seen = [];
    let call = 0;
    const spawnProbe = (cmd, args, o) => {
      seen.push({ cmd, args, opts: o });
      return call++ === 0 ? armedProbe() : hookOk();
    };
    await preflightGuard(board, { spawnProbe });
    expect(seen[1].opts?.input).toBe(MERGE_PROBE_PAYLOAD);
    expect(JSON.parse(seen[1].opts.input).tool_input.command).toMatch(/^gh pr merge /);
  });
});

describe('sessionArgs — what each ticket is actually driven with', () => {
  // The literal spellings CLAUDE.md pins: auto-pr is the level the queue is authorized for, and
  // anything looser would cross the merge gate the whole design rests on.
  it('runs the skill at --gates auto-pr for the named ticket', () => {
    expect(sessionArgs(A).at(-1)).toBe(`/kanban-workflow --gates auto-pr ${A}`);
  });
});

describe('main — dimensions 5 and 6: the queue and the STOP file', () => {
  it('an empty queue is a usage error, never a silent success', async () => {
    expect(await main([], board, opts())).toBe(EXIT.usage);
  });

  it('a malformed ticket id is a usage error rather than being skipped in silence', async () => {
    expect(await main(['tkt-nope'], board, opts())).toBe(EXIT.usage);
  });

  it('an unreadable CAP_SECONDS is a usage error, not a run with no cap', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const code = await main([A], board, opts({ env: { CAP_SECONDS: 'abc' }, runSession }));
    expect(code).toBe(EXIT.usage);
    expect(runSession.calls).toEqual([]);
  });

  // The runner must write the sentinel where the GUARD reads it; if that root cannot be resolved it
  // must not fall back to somewhere the guard never looks (review, MEDIUM).
  it('aborts when the primary checkout cannot be located', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const code = await main([A], board, opts({ resolveSentinelRoot: () => null, runSession }));
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
  });

  it('a failing pre-flight aborts before any ticket runs, and clears the sentinel', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const spawnProbe = () => Promise.resolve({ code: 0, out: 'RAN', capped: false });
    const code = await main([A], board, opts({ spawnProbe, runSession }));
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
    expect(existsSync(sentinelPaths(board).active)).toBe(false);
    expect(readStatus(board, A)).toBe('todo'); // untouched
  });

  // Dimension 6, "many": the control for every stopping case below.
  it('runs every ticket in the queue when each one opens a PR, and exits 0', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub();
    expect(await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([A, B]);
  });

  // The verdict was honest on stdout while the EXIT STATUS said success, so `npm run night ||
  // notify-me` never fired on the one outcome it exists for (review, HIGH).
  it('exits with the ALARM code when a ticket reaches done', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: 'done' } });
    const code = await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.alarm);
    expect(runSession.calls).toEqual([A]);
  });

  it('exits with the stopped code when a ticket halts mid-ticket', async () => {
    seed(A, 'todo');
    const runSession = sessionStub({ [A]: { status: 'in-progress' } });
    expect(await main([A], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.stopped);
  });

  it('exits with the stopped code when the run is capped', async () => {
    seed(A, 'todo');
    const runSession = sessionStub({ [A]: { status: 'qa', capped: true } });
    expect(await main([A], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.stopped);
  });

  // `claude` off PATH resolves {code:-1} per ticket, which read as "never started" and marched
  // through the whole queue in silence, then exited 0 (review, MEDIUM).
  it('stops the queue when a session cannot be started at all', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: null, code: -1, log: 'ENOENT claude' } });
    const code = await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.stopped);
    expect(runSession.calls).toEqual([A]);
  });

  it('stops after two tickets in a row never start, rather than burning the queue', async () => {
    for (const id of [A, B, C]) seed(id, 'todo');
    const runSession = sessionStub({ [A]: { status: null }, [B]: { status: null }, [C]: { status: null } });
    const code = await main([A, B, C], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.stopped);
    expect(runSession.calls).toEqual([A, B]);
  });

  it('a STOP file present up front ends the queue without running anything', async () => {
    seed(A, 'todo');
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(sentinelPaths(board).stop, '');
    const runSession = sessionStub();
    expect(await main([A], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([]);
  });

  // Dimension 5's third case: the STOP file appears while a ticket is running. It must not kill the
  // ticket in flight — A completes — and must stop the queue before B.
  it('a STOP file appearing mid-queue lets the running ticket finish and stops before the next', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: 'qa', thenStop: true } });
    await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(runSession.calls).toEqual([A]);
    expect(readStatus(board, A)).toBe('qa'); // finished, not killed
  });

  it('clears the sentinel on a normal exit', async () => {
    seed(A, 'todo');
    await main([A], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub() }));
    expect(existsSync(sentinelPaths(board).active)).toBe(false);
  });

  it('refuses to start while another live runner holds the sentinel', async () => {
    seed(A, 'todo');
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(sentinelPaths(board).active, `${process.pid}\n`); // a live pid: this one
    const runSession = sessionStub();
    const code = await main([A], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
    expect(readFileSync(sentinelPaths(board).active, 'utf8').trim()).toBe(String(process.pid));
  });

  it('exports a usage string that names the npm entrypoint', () => {
    expect(USAGE).toContain('npm run night');
  });
});

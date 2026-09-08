import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnDockerCli, parsePsLines, redactUserinfo } from './terminalDocker.js';

// A stand-in for a spawned child: .on('error'|'exit', …) is all the seam uses.
function fakeChild() {
  return new EventEmitter();
}

// A child that also exposes a piped stderr stream, matching the shape `run` gets when a caller
// passes a `context` (tkt-c19be6016578).
function fakeChildWithStderr() {
  const child: EventEmitter & { stderr: EventEmitter } = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  return child;
}

describe('spawnDockerCli', () => {
  it('remove force-removes the container, name as a discrete argv entry (no shell)', () => {
    const spawn = vi.fn(() => fakeChild());
    spawnDockerCli(spawn).remove('kanban-term-abc');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('docker', ['rm', '-f', 'kanban-term-abc'], { stdio: 'ignore' });
  });

  it('a hostile container name stays ONE literal arg — never interpolated into a shell', () => {
    const spawn = vi.fn(() => fakeChild());
    const hostile = 'x; rm -rf ~ #';
    spawnDockerCli(spawn).remove(hostile);
    // The whole string is ONE argv entry, never parsed by a shell.
    expect(spawn).toHaveBeenCalledWith('docker', ['rm', '-f', hostile], { stdio: 'ignore' });
  });

  it('remove swallows a spawn error (a missing container is not fatal)', () => {
    const child = fakeChild();
    spawnDockerCli(() => child).remove('gone');
    expect(() => child.emit('error', new Error('no such container'))).not.toThrow();
  });

  it('run spawns docker with the given args + env and resolves the exit code', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const p = spawnDockerCli(spawn).run(['run', '--rm', 'img', 'true'], { env: { X: '1' } });
    expect(spawn).toHaveBeenCalledWith('docker', ['run', '--rm', 'img', 'true'], { stdio: 'ignore', env: { X: '1' } });
    child.emit('exit', 0);
    expect(await p).toEqual({ code: 0, stderr: '' });
  });

  it('run resolves null when docker cannot spawn', async () => {
    const child = fakeChild();
    const p = spawnDockerCli(() => child).run(['run', 'img']);
    child.emit('error', new Error('ENOENT'));
    expect(await p).toEqual({ code: null, stderr: '' });
  });

  // tkt-c19be6016578 — a non-zero `docker run` used to discard stderr, so every container-start
  // failure surfaced as the same generic message.
  describe('run stderr capture', () => {
    it('with a context: pipes stderr and logs docker\'s own diagnosis on a non-zero exit', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const spawn = vi.fn(() => child);
      const p = spawnDockerCli(spawn).run(['run', 'img'], { context: 'run (session container)' });
      expect(spawn).toHaveBeenCalledWith('docker', ['run', 'img'], { stdio: ['ignore', 'ignore', 'pipe'], env: undefined });
      // Verbatim docker 29.6.2 output, not a paraphrase — see the note in terminalAuth.test.ts.
      const real = 'invalid argument "host.docker.internal:host-gateway" for "--add-host" flag: invalid IP address in add-host: "host-gateway"';
      child.stderr.emit('data', `${real}\n`);
      child.emit('exit', 125);
      expect(await p).toEqual({ code: 125, stderr: real });
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0]?.[0]).toBe(`[terminal] docker run (session container) exited 125: ${real}`);
      err.mockRestore();
    });

    // The guarantee that keeps waitForDtachSocket usable: it polls `run` twice a second for up to two
    // minutes and a non-zero exit is its EXPECTED "not ready yet" signal. If capture were unconditional
    // this would log hundreds of non-failures per session start and bury the real one.
    it('without a context: does not pipe, and stays silent on a non-zero exit', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const spawn = vi.fn(() => child);
      const p = spawnDockerCli(spawn).run(['exec', 'kanban-term-abc', 'true']);
      expect(spawn).toHaveBeenCalledWith('docker', ['exec', 'kanban-term-abc', 'true'], { stdio: 'ignore', env: undefined });
      // Even if the child writes, nothing is subscribed — so it can neither be logged nor returned.
      child.stderr.emit('data', 'container is not running');
      child.emit('exit', 1);
      expect(await p).toEqual({ code: 1, stderr: '' });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('stays silent on a ZERO exit even with a context (success is not a diagnostic)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const p = spawnDockerCli(() => child).run(['run', 'img'], { context: 'run (deps install)' });
      child.stderr.emit('data', 'some progress chatter\n'); // docker writes non-error output to stderr too
      child.emit('exit', 0);
      // Full-result assertion, matching its siblings: the success path must still RETURN the captured
      // stderr (trimmed + capped), since a caller may branch on a successful run's message. Asserting
      // only `.code` here left that half of the contract unpinned.
      expect(await p).toEqual({ code: 0, stderr: 'some progress chatter' });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('says so explicitly when a failure produced no stderr (never a bare exit code)', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const p = spawnDockerCli(() => child).run(['run', 'img'], { context: 'run (deps install)' });
      child.emit('exit', 1);
      expect(await p).toEqual({ code: 1, stderr: '' });
      expect(err.mock.calls[0]?.[0]).toBe('[terminal] docker run (deps install) exited 1 (no stderr)');
      err.mockRestore();
    });

    it('logs the spawn failure when docker cannot start at all', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const p = spawnDockerCli(() => child).run(['run', 'img'], { context: 'run (session container)' });
      child.emit('error', new Error('ENOENT'));
      expect(await p).toEqual({ code: null, stderr: '' });
      expect(err).toHaveBeenCalledWith('[terminal] docker run (session container) failed to spawn:', 'ENOENT');
      err.mockRestore();
    });

    // The argv carries `-e LLM_BASE_URL=…`, which can hold userinfo credentials until
    // tkt-281272b5ef77 lands — so the diagnostic must quote stderr and nothing else.
    it('never logs the argv, so a credential-bearing URL cannot leak into the log', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const secret = 'http://user:sekret@host.docker.internal:1234/v1';
      const p = spawnDockerCli(() => child).run(['run', '-e', `LLM_BASE_URL=${secret}`, 'img'], { context: 'run (session container)' });
      child.stderr.emit('data', 'docker: Error response from daemon: no such image\n');
      child.emit('exit', 125);
      await p;
      const logged = err.mock.calls.flat().join(' ');
      expect(logged).not.toContain('sekret');
      expect(logged).toContain('no such image'); // positive control: the diagnostic IS there
      err.mockRestore();
    });

    it('redacts userinfo that docker itself echoed into stderr, in the log AND the result', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const p = spawnDockerCli(() => child).run(['run', 'img'], { context: 'run (session container)' });
      child.stderr.emit('data', 'invalid argument "=http://user:sekret@localhost:1234/v1" for "-e, --env" flag\n');
      child.emit('exit', 125);
      const { stderr } = await p;
      expect(stderr).not.toContain('sekret');
      expect(stderr).toContain('http://***@localhost:1234/v1');
      expect(stderr).toContain('for "-e, --env" flag'); // the diagnosis survives redaction
      expect(err.mock.calls.flat().join(' ')).not.toContain('sekret');
      err.mockRestore();
    });

    it('caps a runaway stderr stream instead of buffering it without bound', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const p = spawnDockerCli(() => child).run(['run', 'img'], { context: 'run (deps install)' });
      for (let i = 0; i < 100; i++) child.stderr.emit('data', 'x'.repeat(1000));
      child.emit('exit', 1);
      await p;
      expect(err).toHaveBeenCalledTimes(1); // without this the assertions below pass vacuously
      const logged = String(err.mock.calls[0]?.[0]);
      expect(logged).toContain('xxx');       // it really did capture the stream…
      expect(logged.length).toBeLessThan(5_000); // …and kept ~4 KB of the 100 KB emitted
      err.mockRestore();
    });

    // Head-first capping would drop the error: docker writes image-pull progress to stderr BEFORE
    // the failure, and this string is now load-bearing for the host-gateway retry decision.
    it('keeps the TAIL, so a late error survives earlier progress chatter', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const child = fakeChildWithStderr();
      const p = spawnDockerCli(() => child).run(['run', 'img'], { context: 'run (session container)' });
      for (let i = 0; i < 100; i++) child.stderr.emit('data', `pulling layer ${i}: ${'.'.repeat(500)}\n`);
      child.stderr.emit('data', 'invalid IP address in add-host: "host-gateway"\n');
      child.emit('exit', 125);
      const { stderr } = await p;
      expect(stderr).toContain('invalid IP address in add-host'); // the message that matters survived
      expect(stderr.length).toBeLessThanOrEqual(4_000);
      err.mockRestore();
    });
  });

  // Docker echoes a REJECTED argument verbatim into its own stderr, so "we never log the argv" does
  // not keep a credential out of the log (tkt-1cb370e16c55 review; tkt-281272b5ef77).
});

describe('parsePsLines', () => {
  it('parses name<TAB>session rows for boot-time adoption', () => {
    const out = 'kanban-term-aaa\t11111111-2222-4333-8444-555566667777\nkanban-term-bbb\t99999999-8888-4777-a666-555544443333\n';
    expect(parsePsLines(out)).toEqual([
      { name: 'kanban-term-aaa', session: '11111111-2222-4333-8444-555566667777' },
      { name: 'kanban-term-bbb', session: '99999999-8888-4777-a666-555544443333' },
    ]);
  });
  it('drops rows missing a name or session, and tolerates blanks / trailing newline / nullish', () => {
    expect(parsePsLines('kanban-term-x\t\n\t abc \nonlyname\n')).toEqual([]);
    expect(parsePsLines('')).toEqual([]);
    expect(parsePsLines(null)).toEqual([]);
    expect(parsePsLines(undefined)).toEqual([]);
  });
  it('parses the optional created-epoch third field for the reaper', () => {
    const out = 'kanban-term-aaa\t11111111-2222-4333-8444-555566667777\t1700000000000\n';
    expect(parsePsLines(out)).toEqual([
      { name: 'kanban-term-aaa', session: '11111111-2222-4333-8444-555566667777', createdAtMs: 1700000000000 },
    ]);
  });
  it('omits createdAtMs when the created field is absent, blank, non-numeric, or non-positive', () => {
    // No third column (a container predating S3b) → session still adopts, age unknown.
    expect(parsePsLines('n\t11111111-2222-4333-8444-555566667777\n')).toEqual([
      { name: 'n', session: '11111111-2222-4333-8444-555566667777' },
    ]);
    for (const bad of ['', 'notanumber', '0', '-5']) {
      expect(parsePsLines(`n\t11111111-2222-4333-8444-555566667777\t${bad}\n`)).toEqual([
        { name: 'n', session: '11111111-2222-4333-8444-555566667777' },
      ]);
    }
  });
});

describe('redactUserinfo', () => {
  // Verbatim from `docker run --rm -e "=http://user:sekret@localhost:1234/v1" alpine true` (29.6.2).
  const REAL_ECHO = 'invalid argument "=http://user:sekret@localhost:1234/v1" for "-e, --env" flag: invalid environment variable: =http://user:sekret@localhost:1234/v1';

  it('strips userinfo from docker\'s echo of a rejected credential-bearing argument', () => {
    const out = redactUserinfo(REAL_ECHO);
    expect(out).not.toContain('sekret');
    expect(out).toContain('http://***@localhost:1234/v1');
    expect(out).toContain('invalid environment variable');
  });

  it('redacts EVERY occurrence, not just the first', () => {
    expect(redactUserinfo(REAL_ECHO).match(/\*\*\*@/g)).toHaveLength(2);
  });

  it('leaves ordinary text and non-URL @ alone', () => {
    expect(redactUserinfo('no such image kanban-terminal:latest')).toBe('no such image kanban-terminal:latest');
    expect(redactUserinfo('git@github.com:me/repo.git')).toBe('git@github.com:me/repo.git');
    expect(redactUserinfo('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
    expect(redactUserinfo('')).toBe('');
  });
});

// tkt-6233ae50f62a: every `ps` failure used to resolve `[]`, indistinguishable from "no containers" —
// so a daemon hiccup at boot un-adopted live survivors and let a reopen clobber their HOME. The answer
// on failure is now null ("unknown"), and `ps` runs through the INJECTED spawn so each kind is
// drivable here with no docker.
describe('spawnDockerCli.ps', () => {
  afterEach(() => vi.useRealTimers()); // the timeout case installs fake timers; never leak them past a failed assertion
  const FORMAT = '{{.Names}}\t{{.Label "kanban.session"}}\t{{.Label "kanban.created"}}';
  const ARGS = ['ps', '--filter', 'label=kanban.session', '--filter', 'label=kanban.root=/r', '--format', FORMAT];

  function fakeChildWithStdout() {
    return Object.assign(fakeChild(), { stdout: new EventEmitter(), kill: vi.fn() });
  }
  function ps(spawn: Parameters<typeof spawnDockerCli>[0]) {
    return spawnDockerCli(spawn).ps('kanban.session', 'kanban.created', ['kanban.session', 'kanban.root=/r'], 'adoption');
  }

  it('spawns through the injected seam with stdout piped, and parses the rows on a zero exit', async () => {
    const child = fakeChildWithStdout();
    const spawn = vi.fn(() => child);
    const p = ps(spawn);
    expect(spawn).toHaveBeenCalledWith('docker', ARGS, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.emit('data', 'kanban-term-aaa\t11111111-2222-4333-8444-555566667777\t1700000000000\n');
    child.emit('close', 0);
    expect(await p).toEqual([{ name: 'kanban-term-aaa', session: '11111111-2222-4333-8444-555566667777', createdAtMs: 1_700_000_000_000 }]);
  });

  // Positive control for the null cases below: a clean run that lists nothing IS "no containers".
  it('a zero exit with no output is a known empty answer — [] not null', async () => {
    const child = fakeChildWithStdout();
    const p = ps(() => child);
    child.emit('close', 0);
    expect(await p).toEqual([]);
  });

  it('resolves null (unknown), never [], on a non-zero exit — and says so in the log', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = fakeChildWithStdout();
    const p = ps(() => child);
    child.stdout.emit('data', 'partial\tgarbage\n'); // whatever arrived before the failure is discarded
    child.emit('close', 1);
    expect(await p).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/docker ps \(adoption\) exited 1 .*unknown/i);
    err.mockRestore();
  });

  it('resolves null (unknown) when docker cannot spawn at all', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = fakeChildWithStdout();
    const p = ps(() => child);
    child.emit('error', new Error('ENOENT'));
    expect(await p).toBeNull();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/docker ps \(adoption\) failed.*unknown/i);
    err.mockRestore();
  });

  it('resolves null (unknown) on the 5s timeout, kills the child, and ignores a late exit', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = fakeChildWithStdout();
    const p = ps(() => child);
    vi.advanceTimersByTime(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await p).toBeNull();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/docker ps \(adoption\) timed out.*unknown/i);
    // The kill makes the child close AFTER the answer was given; that must not re-settle, throw, or
    // log a second, contradictory cause for the same query.
    child.stdout.emit('data', 'kanban-term-late\t11111111-2222-4333-8444-555566667777\n');
    expect(() => child.emit('close', null)).not.toThrow();
    expect(await p).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  // Node's contract: stdio may still be draining at 'exit'; only 'close' guarantees the listing is
  // complete. Answering on 'exit' could drop a live survivor on the SUCCESS path.
  it('does not answer on exit — only on close, once stdout is fully drained', async () => {
    const child = fakeChildWithStdout();
    let answered = false;
    const p = ps(() => child).then((rows) => { answered = true; return rows; });
    child.stdout.emit('data', 'kanban-term-aaa\t11111111-2222-4333-8444-555566667777\n');
    child.emit('exit', 0);
    await Promise.resolve();
    expect(answered).toBe(false);
    child.stdout.emit('data', 'kanban-term-bbb\t99999999-8888-4777-a666-555544443333\n'); // the late chunk
    child.emit('close', 0);
    expect((await p)?.map((r) => r.name)).toEqual(['kanban-term-aaa', 'kanban-term-bbb']);
  });
});

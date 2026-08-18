import { describe, it, expect, vi } from 'vitest';
import { startContainer } from './terminal.js';
import { buildDetachedRunArgs } from './terminalAuth.js';
import type { RunResult } from './terminalDocker.js';

// Round-trip cover for the host-gateway fallback (tkt-1cb370e16c55). The chain crosses three modules
// — terminalDocker returns RunResult.stderr → terminal decides → terminalAuth strips the argv →
// terminalDocker runs again — and NOTHING drove it end to end. That gap is why the first version of
// the matcher, written against a hand-guessed docker message, shipped with a green suite and nine
// passing unit tests while never being able to fire. These tests drive the real chain with a fake
// docker and REAL docker output.

// Verbatim from `docker run --rm --add-host … alpine true` on docker 29.6.2. Docker renders the
// offending value with %q, so it is DOUBLE-QUOTED. Never paraphrase these.
const REAL_REJECTION = 'invalid argument "host.docker.internal:host-gateway" for "--add-host" flag: invalid IP address in add-host: "host-gateway"';
const REAL_OTHER_FAILURE = 'Unable to find image \'kanban-terminal:latest\' locally\ndocker: Error response from daemon: pull access denied';

const SID = '11111111-2222-4333-8444-555566667777';
const KANBAN = '/Users/someuser/kanban';

function realRunArgs(): string[] {
  return buildDetachedRunArgs({
    roots: [KANBAN], sessionId: SID, rootLabel: KANBAN, createdAt: 1_700_000_000_000,
    credMount: { hostHome: '/host/home', containerHome: '/kanban-home' },
    image: 'kanban-terminal', containerName: 'kanban-term-1',
  });
}

// A fake docker whose `run` replays a scripted sequence of results and records every argv it saw.
function fakeDocker(results: RunResult[]) {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  let i = 0;
  return {
    calls,
    envs,
    // Every `docker` invocation — including the pre-retry `rm -f` — goes through run(), so `calls`
    // records the true ORDER. That ordering is the point: an unsequenced remove could land after the
    // retry's create.
    docker: {
      run: (args: string[], opts?: { env?: Record<string, string> }): Promise<RunResult> => {
        calls.push(args);
        envs.push(opts?.env);
        return Promise.resolve(results[i++] ?? { code: 0, stderr: '' });
      },
    },
  };
}

function start(
  docker: ReturnType<typeof fakeDocker>['docker'],
  stripAlias = false,
  disposed = false,
  env: Record<string, string> = {},
) {
  const notices: string[] = [];
  const promise = startContainer({
    docker, command: { runArgs: realRunArgs(), env }, containerName: 'kanban-term-1',
    stripAlias, notify: (m) => notices.push(m), isDisposed: () => disposed,
  });
  return { promise, notices };
}

describe('startContainer — host-gateway fallback round trip', () => {
  it('retries WITHOUT the alias when docker rejects host-gateway, and reports success', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeDocker([{ code: 125, stderr: REAL_REJECTION }, { code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    const { promise, notices } = start(f.docker);
    const result = await promise;

    // run → rm -f → run. The middle call is the awaited cleanup.
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]).toContain('--add-host');
    expect(f.calls[1]).toEqual(['rm', '-f', 'kanban-term-1']);
    expect(f.calls[2]).not.toContain('--add-host');
    expect(f.calls[2]?.some((a) => a.includes('host-gateway'))).toBe(false);
    expect(f.calls[2]).toHaveLength((f.calls[0]?.length ?? 0) - 2);
    // The retry is still a usable session, not a stripped-down one.
    expect(f.calls[2]?.slice(-4)).toEqual(['dtach', '-N', `/tmp/kanban-term-${SID}.dtach`, 'claude']);

    expect(result).toEqual({ code: 0, aliasDropped: true });
    expect(notices).toEqual([expect.stringContaining('cannot reach a host LLM endpoint')]);
    err.mockRestore();
  });

  // The removal must be SEQUENCED before the retry's create, not fire-and-forget: an `rm -f` landing
  // after the create would delete the container out from under the caller, and the session would
  // then fail its liveness probe with an empty `docker logs`.
  it('completes the force-remove BEFORE issuing the retry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    const pendingRm: Array<() => void> = []; // an array, so the rm stays un-resolved until we say so
    const docker = {
      run: (args: string[]): Promise<RunResult> => {
        if (args[0] === 'rm') {
          order.push('rm:start');
          return new Promise((res) => {
            pendingRm.push(() => { order.push('rm:done'); res({ code: 0, stderr: '' }); });
          });
        }
        const isRetry = order.includes('rm:done');
        order.push(isRetry ? 'retry' : 'first');
        return Promise.resolve(isRetry ? { code: 0, stderr: '' } : { code: 125, stderr: REAL_REJECTION });
      },
    };
    const promise = startContainer({
      docker, command: { runArgs: realRunArgs(), env: {} }, containerName: 'kanban-term-1',
      stripAlias: false, notify: () => {}, isDisposed: () => false,
    });
    await vi.waitFor(() => expect(pendingRm).toHaveLength(1));
    expect(order).toEqual(['first', 'rm:start']); // the retry has NOT been issued yet
    pendingRm[0]?.();
    await promise;
    expect(order).toEqual(['first', 'rm:start', 'rm:done', 'retry']);
    err.mockRestore();
  });

  // Dispose deletes the session HOME; a retry after that makes docker recreate it as an unowned
  // empty dir that neither the registry nor the reaper reclaims.
  it('does not retry if the session was disposed during the failed first run', async () => {
    const f = fakeDocker([{ code: 125, stderr: REAL_REJECTION }]);
    const { promise, notices } = start(f.docker, false, true);

    expect(await promise).toEqual({ code: 125, aliasDropped: true }); // still latches the rejection
    expect(f.calls).toHaveLength(1); // no rm, no retry
    expect(notices).toEqual([]);
  });

  // The regression that the missing round-trip test allowed: a matcher that cannot match real docker
  // output. This fails if anyone reintroduces an unquoted-only pattern.
  it('fires against docker\'s REAL quoted message, not a paraphrase of it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeDocker([{ code: 125, stderr: REAL_REJECTION }, { code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    await start(f.docker).promise;
    expect(f.calls).toHaveLength(3); // rm + retry happened at all == the matcher fired
    err.mockRestore();
  });

  it('does NOT retry on an unrelated failure — it fails loudly with the original code', async () => {
    const f = fakeDocker([{ code: 125, stderr: REAL_OTHER_FAILURE }]);
    const { promise, notices } = start(f.docker);

    expect(await promise).toEqual({ code: 125, aliasDropped: false });
    expect(f.calls).toHaveLength(1); // no rm, no retry
    expect(notices).toEqual([]);
  });

  // tkt-281272b5ef77: endpoint URLs are now `-e NAME` in the argv with the VALUE riding the docker
  // CLI's own env, so the two are only equivalent if this env reaches every run — including the
  // alias-stripped retry, which is the path a Linux daemon always takes.
  it('hands the caller\'s env to docker on the first run AND on the retry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { LLM_BASE_URL: 'http://host.docker.internal:9999/v1', LLM_API_KEY: 'sk-secret' };
    const f = fakeDocker([{ code: 125, stderr: REAL_REJECTION }, { code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    await start(f.docker, false, false, env).promise;

    expect(f.calls).toHaveLength(3);
    // Indices 0 and 2 are the runs; 1 is the `rm -f`. A retry spawned with a bare/default env would
    // start a container whose `-e LLM_BASE_URL` inherits nothing — the silent drop this pins.
    for (const i of [0, 2]) expect(f.envs[i], `run ${i} lost the env`).toEqual(env);
    err.mockRestore();
  });

  it('does not retry or notify on a clean first start', async () => {
    const f = fakeDocker([{ code: 0, stderr: '' }]);
    const { promise, notices } = start(f.docker);

    expect(await promise).toEqual({ code: 0, aliasDropped: false });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('--add-host'); // the alias is still sent by default
    expect(notices).toEqual([]);
  });

  it('reports the RETRY\'s failure, not a false success, when the retry also fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeDocker([{ code: 125, stderr: REAL_REJECTION }, { code: 0, stderr: '' }, { code: 1, stderr: 'no such image' }]);
    const { promise, notices } = start(f.docker);

    expect(await promise).toEqual({ code: 1, aliasDropped: true });
    expect(notices).toEqual([]); // never tell the user it degraded gracefully when it didn't start
    err.mockRestore();
  });

  it('force-removes the container name before retrying, so the retry cannot hit a name clash', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeDocker([{ code: 125, stderr: REAL_REJECTION }, { code: 0, stderr: '' }, { code: 0, stderr: '' }]);
    await start(f.docker).promise;
    expect(f.calls[1]).toEqual(['rm', '-f', 'kanban-term-1']);
    err.mockRestore();
  });

  describe('once the daemon has been latched as rejecting (stripAlias)', () => {
    it('skips the alias on the FIRST try — no wasted failing run', async () => {
      const f = fakeDocker([{ code: 0, stderr: '' }]);
      const { promise, notices } = start(f.docker, true);

      expect(await promise).toEqual({ code: 0, aliasDropped: true });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).not.toContain('--add-host');
      // Still told, every session — the degradation is permanent, not a one-time event.
      expect(notices).toEqual([expect.stringContaining('cannot reach a host LLM endpoint')]);
    });

    it('does not claim degraded-success when the pre-stripped run fails outright', async () => {
      const f = fakeDocker([{ code: 1, stderr: 'no such image' }]);
      const { promise, notices } = start(f.docker, true);

      expect(await promise).toEqual({ code: 1, aliasDropped: true });
      expect(notices).toEqual([]);
    });
  });
});

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

// The embedded terminal's Docker CLI seam (tkt-e1144d4ef7f5, epic tkt-d7e129290ff7). Every `docker`
// invocation goes through here so that (1) container names — built from a client-derived session id
// — are always passed as DISCRETE argv entries, never interpolated into a shell string (no
// `execSync(\`docker kill ${name}\`)` footgun), and (2) consumers can inject a fake docker in tests.
// The interactive session stream stays on node-pty (a pty, not a plain CLI call) and is intentionally
// not routed here. Verbs beyond these (exec/ps/inspect/rm) arrive with their consumers in the later
// detached-container slices.

// Minimal structural signatures for the spawners, so both the real child_process functions and a
// test fake satisfy them (the full `typeof spawn` overload set is awkward to fake).
interface Spawned {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
}
type SpawnFn = (command: string, args: readonly string[], options: { stdio: 'ignore'; env?: NodeJS.ProcessEnv }) => Spawned;
type SpawnSyncFn = (command: string, args: readonly string[], options: { stdio: 'ignore' }) => unknown;

export interface DockerCli {
  // Best-effort async kill (fire-and-forget); a missing container is not an error.
  kill(name: string): void;
  // Synchronous kill for the process-'exit' hook, which cannot await.
  killSync(name: string): void;
  // Run a container to completion; resolves its exit code, or null if `docker` couldn't spawn.
  run(args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<number | null>;
}

export function spawnDockerCli(spawn: SpawnFn = nodeSpawn, spawnSync: SpawnSyncFn = nodeSpawnSync): DockerCli {
  return {
    kill(name) {
      spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => { /* already gone */ });
    },
    killSync(name) {
      spawnSync('docker', ['kill', name], { stdio: 'ignore' });
    },
    run(args, opts = {}) {
      return new Promise((resolve) => {
        const proc = spawn('docker', args, { stdio: 'ignore', env: opts.env });
        proc.on('exit', (code) => resolve(code));
        proc.on('error', () => resolve(null));
      });
    },
  };
}

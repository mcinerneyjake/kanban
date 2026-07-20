import { spawn as nodeSpawn, execFileSync } from 'node:child_process';

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

export interface DockerCli {
  // Best-effort async force-remove (kill + rm); a missing container is not an error. Detached
  // session containers run without `--rm`, so dispose must remove them explicitly.
  remove(name: string): void;
  // Run a container (or any `docker` subcommand) to completion; resolves its exit code, or null if
  // `docker` couldn't spawn.
  run(args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<number | null>;
  // Running containers matching ALL `filterLabels` (each a `key` or `key=value`) → [{name, session}]
  // where session is the `sessionLabelKey` value. Used once at boot to re-adopt containers that
  // outlived a restart (S3a). Bounded + empty on any failure so a hung daemon can't stall boot.
  ps(sessionLabelKey: string, filterLabels: string[]): Array<{ name: string; session: string }>;
}

// Parse `docker ps --format '{{.Names}}\t{{.Label "…"}}'` output → rows. Pure + tested; a row needs
// both a name and a non-empty session value (the label). Tolerant of blank lines / trailing newline.
export function parsePsLines(stdout: string | null | undefined): Array<{ name: string; session: string }> {
  const rows: Array<{ name: string; session: string }> = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const [name, session] = line.split('\t');
    if (name && session && session.trim()) rows.push({ name: name.trim(), session: session.trim() });
  }
  return rows;
}

export function spawnDockerCli(spawn: SpawnFn = nodeSpawn): DockerCli {
  return {
    remove(name) {
      spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).on('error', () => { /* already gone */ });
    },
    run(args, opts = {}) {
      return new Promise((resolve) => {
        const proc = spawn('docker', args, { stdio: 'ignore', env: opts.env });
        proc.on('exit', (code) => resolve(code));
        proc.on('error', () => resolve(null));
      });
    },
    ps(sessionLabelKey, filterLabels) {
      try {
        const filters = filterLabels.flatMap((l) => ['--filter', `label=${l}`]);
        const out = execFileSync(
          'docker',
          ['ps', ...filters, '--format', `{{.Names}}\t{{.Label "${sessionLabelKey}"}}`],
          { encoding: 'utf8', timeout: 5_000 }, // bounded: a hung daemon must not stall boot (review F7)
        );
        return parsePsLines(out);
      } catch {
        return []; // docker down / no such filter → adopt nothing (fresh start)
      }
    },
  };
}

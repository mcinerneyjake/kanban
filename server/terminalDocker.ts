import { spawn as nodeSpawn } from 'node:child_process';

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
  // outlived a restart (S3a). ASYNC + bounded so a hung daemon can't block the event loop; resolves
  // empty (and logs loudly) on any failure so a transient error can't silently look like "no survivors".
  ps(sessionLabelKey: string, filterLabels: string[]): Promise<Array<{ name: string; session: string }>>;
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
      // Real async spawn (not the injected one, which pipes nothing) so we can capture stdout without
      // a synchronous stall (review G6). Its logic is parsePsLines, tested separately.
      return new Promise((resolve) => {
        const filters = filterLabels.flatMap((l) => ['--filter', `label=${l}`]);
        const proc = nodeSpawn(
          'docker',
          ['ps', ...filters, '--format', `{{.Names}}\t{{.Label "${sessionLabelKey}"}}`],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let out = '';
        let settled = false;
        const finish = (rows: Array<{ name: string; session: string }>) => {
          if (!settled) { settled = true; clearTimeout(timer); resolve(rows); }
        };
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* already gone */ }
          console.error('[terminal] docker ps for session adoption timed out (5s) — no containers adopted');
          finish([]);
        }, 5_000);
        proc.stdout?.on('data', (d) => { out += String(d); });
        proc.on('exit', (code) => {
          if (code === 0) finish(parsePsLines(out));
          else { console.error(`[terminal] docker ps for session adoption exited ${code ?? 'null'} — no containers adopted`); finish([]); }
        });
        proc.on('error', (err) => {
          console.error('[terminal] docker ps for session adoption failed:', err instanceof Error ? err.message : err);
          finish([]);
        });
      });
    },
  };
}

import { spawn as nodeSpawn } from 'node:child_process';

// The embedded terminal's Docker CLI seam (tkt-e1144d4ef7f5, epic tkt-d7e129290ff7). Every `docker`
// invocation goes through here so that (1) container names — built from a client-derived session id
// — are always passed as DISCRETE argv entries, never interpolated into a shell string (no
// `execSync(\`docker kill ${name}\`)` footgun), and (2) consumers can inject a fake docker in tests.
// The interactive session stream stays on node-pty (a pty, not a plain CLI call) and is intentionally
// not routed here. Verbs beyond these (exec/ps/inspect/rm) arrive with their consumers in the later
// detached-container slices.

// Minimal structural signatures for the spawners, so both the real child_process functions and a
// test fake satisfy them (the full `typeof spawn` overload set is awkward to fake). `stderr` is
// present only on the piped shape; optional so a fake that ignores it still satisfies the type.
interface Spawned {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
}
type SpawnStdio = 'ignore' | ['ignore', 'ignore', 'pipe'];
type SpawnFn = (command: string, args: readonly string[], options: { stdio: SpawnStdio; env?: NodeJS.ProcessEnv }) => Spawned;

// Cap on the diagnostic we buffer from a failing docker command. We keep the TAIL, not the head:
// docker writes pull progress to stderr before the error, so a head-first cap can truncate away the
// very message a caller branches on (tkt-1cb370e16c55 review).
const MAX_STDERR_CHARS = 4_000;

// Docker echoes a rejected argument into its own stderr (verified, 29.6.2), so "we never log the
// argv" doesn't keep a credential-bearing LLM_BASE_URL out of the log (tkt-281272b5ef77).
export function redactUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s"'/@]+@/gi, '$1***@');
}

// Outcome of a `docker` invocation. `stderr` is '' unless the caller passed a `context` (only then is
// it piped) — so a caller that wants to branch on the message must ask for capture.
export interface RunResult {
  code: number | null;
  stderr: string;
}

// A running session container discovered via `docker ps`, with its creation time (from the
// kanban.created label). createdAtMs is undefined when the label is absent or unparseable —
// the reaper treats that as "unknown age" and protects it rather than guessing (tkt-b4412f11b790).
export interface PsRow {
  name: string;
  session: string;
  createdAtMs?: number;
}

export interface DockerCli {
  // Best-effort async force-remove (kill + rm); a missing container is not an error. Detached
  // session containers run without `--rm`, so dispose must remove them explicitly.
  remove(name: string): void;
  // Run a container (or any `docker` subcommand) to completion; resolves its exit code (null if
  // `docker` couldn't spawn) plus whatever it wrote to stderr. Pass `context` when a non-zero exit is
  // a real failure: it pipes docker's stderr, logs it (tkt-c19be6016578), and returns it so a caller
  // can BRANCH on the message — which is how the host-gateway retry works (tkt-1cb370e16c55). OMIT it
  // for probes that expect non-zero; `stderr` is then always '' because nothing is piped.
  run(args: string[], opts?: { env?: NodeJS.ProcessEnv; context?: string }): Promise<RunResult>;
  // Running containers matching ALL `filterLabels` (each a `key` or `key=value`) → [{name, session}]
  // where session is the `sessionLabelKey` value. Used at boot to re-adopt containers that outlived a
  // restart (S3a) and periodically by the reaper (S3b). Each row also carries createdAtMs from the
  // `createdLabelKey` label so the reaper can compute age. ASYNC + bounded so a hung daemon can't
  // block the event loop; resolves empty (and logs loudly, tagged with `context`) on any failure so
  // a transient error can't silently look like "no survivors".
  ps(sessionLabelKey: string, createdLabelKey: string, filterLabels: string[], context: string): Promise<PsRow[]>;
}

// Parse `docker ps --format '{{.Names}}\t{{.Label "sess"}}\t{{.Label "created"}}'` output → rows.
// Pure + tested; a row needs both a name and a non-empty session value (the label). The third field
// (created epoch ms) is optional — a non-numeric/blank value yields createdAtMs undefined. Tolerant
// of blank lines / trailing newline. Back-compat: rows produced without the created field still parse.
export function parsePsLines(stdout: string | null | undefined): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const [name, session, created] = line.split('\t');
    if (name && session && session.trim()) {
      const createdAtMs = Number(String(created ?? '').trim());
      rows.push({
        name: name.trim(),
        session: session.trim(),
        ...(Number.isFinite(createdAtMs) && createdAtMs > 0 ? { createdAtMs } : {}),
      });
    }
  }
  return rows;
}

export function spawnDockerCli(spawn: SpawnFn = nodeSpawn): DockerCli {
  return {
    remove(name) {
      spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).on('error', () => { /* already gone */ });
    },
    // stderr is piped ONLY when the caller names a context. waitForDtachSocket polls `run` twice a
    // second for up to two minutes and a non-zero exit there is the EXPECTED "not ready yet" signal —
    // piping it would buffer and log hundreds of non-failures, burying the one that matters.
    run(args, opts = {}) {
      const { context } = opts;
      return new Promise((resolve) => {
        const proc = context
          ? spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'], env: opts.env })
          : spawn('docker', args, { stdio: 'ignore', env: opts.env });
        let stderr = '';
        // Keep the last MAX_STDERR_CHARS, so a late error survives earlier pull progress.
        if (context) proc.stderr?.on('data', (d) => {
          stderr += String(d);
          if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(-MAX_STDERR_CHARS);
        });
        const detail = (): string => redactUserinfo(stderr.trim());
        proc.on('exit', (code) => {
          const message = detail();
          if (context && code !== 0) {
            console.error(`[terminal] docker ${context} exited ${code ?? 'null'}${message ? `: ${message}` : ' (no stderr)'}`);
          }
          resolve({ code, stderr: message });
        });
        proc.on('error', (err) => {
          if (context) console.error(`[terminal] docker ${context} failed to spawn:`, err instanceof Error ? err.message : err);
          resolve({ code: null, stderr: detail() });
        });
      });
    },
    ps(sessionLabelKey, createdLabelKey, filterLabels, context) {
      // Real async spawn (not the injected one, which pipes nothing) so we can capture stdout without
      // a synchronous stall (review G6). Its logic is parsePsLines, tested separately.
      return new Promise((resolve) => {
        const filters = filterLabels.flatMap((l) => ['--filter', `label=${l}`]);
        const format = `{{.Names}}\t{{.Label "${sessionLabelKey}"}}\t{{.Label "${createdLabelKey}"}}`;
        const proc = nodeSpawn('docker', ['ps', ...filters, '--format', format], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        let settled = false;
        const finish = (rows: PsRow[]) => {
          if (!settled) { settled = true; clearTimeout(timer); resolve(rows); }
        };
        const timer = setTimeout(() => {
          try { proc.kill(); } catch { /* already gone */ }
          console.error(`[terminal] docker ps (${context}) timed out (5s) — resolving empty`);
          finish([]);
        }, 5_000);
        proc.stdout?.on('data', (d) => { out += String(d); });
        proc.on('exit', (code) => {
          if (code === 0) finish(parsePsLines(out));
          else { console.error(`[terminal] docker ps (${context}) exited ${code ?? 'null'} — resolving empty`); finish([]); }
        });
        proc.on('error', (err) => {
          console.error(`[terminal] docker ps (${context}) failed:`, err instanceof Error ? err.message : err);
          finish([]);
        });
      });
    },
  };
}

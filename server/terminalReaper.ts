import type { DockerCli, PsRow } from './terminalDocker.js';
import { SESSION_LABEL_KEY, SESSION_CREATED_LABEL_KEY, ROOT_LABEL_KEY } from './terminalAuth.js';

// Authoritative container reaper for the detachable embedded terminal (S3b, tkt-b4412f11b790).
//
// The in-memory TerminalRegistry disposes sessions it knows about (grace timer → docker rm), but two
// gaps leak containers: (1) a `docker rm` that FAILED during dispose leaves an orphan the registry no
// longer tracks; (2) a container from a PRIOR process that a boot-time adoption didn't claim (adoption
// caps at MAX_SESSIONS). This reaper reconciles docker state against the registry on an interval and
// removes genuinely-stale orphans, bounded by an absolute max-age and a total cap.
//
// Design (mirrors terminalAuth vs terminal.ts): `planReap` is a pure, exhaustively-tested decision
// over docker rows + a registry predicate; `startReaper` is the thin I/O scheduler around it.
//
// SAFETY INVARIANT: never reap a container whose session id the registry currently tracks. Those —
// live-attached, still-booting, adopted-awaiting-reattach, or grace-window — are owned by the
// registry's own lifecycle; the reaper only ever touches containers the registry does NOT know
// (true orphans). This makes the reaper race-free against the registry: it cannot kill a container a
// reattach is about to grab, because a reattach-able session is, by definition, still tracked.

export interface ReaperConfig {
  graceMs: number;   // an orphan younger than this is spared (a just-created container mid-registration)
  maxAgeMs: number;  // an orphan older than this is removed unconditionally (runaway protection)
  cap: number;       // at most this many orphans may linger; the oldest beyond it are removed
}

export interface ReapDecision {
  name: string;
  session: string;
  reason: 'max-age' | 'cap';
  ageMs: number;
}

// Decide which orphan containers to reap. `isTracked(session)` is the registry's live view — a true
// return protects the container absolutely. Pure: `now` and all thresholds are injected.
//
// A row with no createdAtMs (missing/unparseable label — e.g. a container predating S3b) has unknown
// age; it is treated as age 0 so it can never be reaped by age or cap. Such a container is only
// reclaimable via `terminal:clean`, which is deliberate: we never guess an age and risk killing a
// live session.
export function planReap(opts: {
  rows: PsRow[];
  isTracked: (session: string) => boolean;
  now: number;
  config: ReaperConfig;
}): ReapDecision[] {
  const { rows, isTracked, now, config } = opts;
  const orphans = rows
    .filter((r) => !isTracked(r.session))
    .map((r) => ({ ...r, ageMs: r.createdAtMs === undefined ? 0 : Math.max(0, now - r.createdAtMs) }))
    .sort((a, b) => b.ageMs - a.ageMs); // oldest first

  const reap: ReapDecision[] = [];
  const kept: typeof orphans = [];
  for (const o of orphans) {
    // maxAge implies past-grace (maxAgeMs > graceMs by construction), but assert both so a
    // misconfigured maxAgeMs < graceMs can never reap a within-grace container.
    if (o.ageMs >= config.maxAgeMs && o.ageMs >= config.graceMs) {
      reap.push({ name: o.name, session: o.session, reason: 'max-age', ageMs: o.ageMs });
    } else {
      kept.push(o);
    }
  }

  // Cap: keep the youngest `cap` survivors (most likely to be reattached to); remove the oldest
  // beyond it — but only ones past the grace window, so a burst of fresh orphans isn't culled early.
  let overflow = kept.length - config.cap;
  for (const o of kept) { // still oldest-first
    if (overflow <= 0) break;
    if (o.ageMs >= config.graceMs) {
      reap.push({ name: o.name, session: o.session, reason: 'cap', ageMs: o.ageMs });
      overflow -= 1;
    }
  }
  return reap;
}

// Minimal timer seam so startReaper is drivable in tests without real intervals. `every` returns a
// stop function that cancels the schedule. The node default unref's the handle so the reaper never
// keeps the dev process alive on its own.
export interface Scheduler {
  every(intervalMs: number, cb: () => void): () => void;
}

const nodeScheduler: Scheduler = {
  every(intervalMs, cb) {
    const handle = setInterval(cb, intervalMs);
    handle.unref();
    return () => clearInterval(handle);
  },
};

export interface ReaperDeps {
  docker: Pick<DockerCli, 'ps' | 'remove'>;
  isTracked: (session: string) => boolean;
  rootLabel: string;         // kanban.root value — scopes the sweep to THIS checkout's containers
  config: ReaperConfig;
  intervalMs: number;
  now?: () => number;        // injectable clock for tests
  scheduler?: Scheduler;     // injectable timer seam for tests (defaults to unref'd setInterval)
}

// Run one reconciliation pass. Exported so tests can drive a single sweep without arming an interval
// (the `terminal:clean` CLI deliberately does NOT use this — it sweeps unconditionally, server-down,
// with no registry to consult). Returns the decisions acted on (for logging/assertions).
export async function reapOnce(deps: Pick<ReaperDeps, 'docker' | 'isTracked' | 'rootLabel' | 'config' | 'now'>): Promise<ReapDecision[]> {
  const now = (deps.now ?? Date.now)();
  const rows = await deps.docker.ps(
    SESSION_LABEL_KEY,
    SESSION_CREATED_LABEL_KEY,
    [SESSION_LABEL_KEY, `${ROOT_LABEL_KEY}=${deps.rootLabel}`],
    'reaper',
  );
  const decisions = planReap({ rows, isTracked: deps.isTracked, now, config: deps.config });
  for (const d of decisions) {
    console.error(`[terminal] reaping orphan container ${d.name} (session ${d.session}, ${d.reason}, age ${Math.round(d.ageMs / 1000)}s)`);
    deps.docker.remove(d.name);
  }
  return decisions;
}

// Arm the periodic reaper. Returns a stop() that cancels the schedule. Each tick is fully awaited
// internally and its rejection is swallowed (ps already resolves-empty + logs on failure) so one bad
// sweep can't crash the loop or leave an unhandled rejection.
export function startReaper(deps: ReaperDeps): () => void {
  const scheduler = deps.scheduler ?? nodeScheduler;
  return scheduler.every(deps.intervalMs, () => {
    void reapOnce(deps).catch((err) => {
      console.error('[terminal] reaper sweep failed:', err instanceof Error ? err.message : err);
    });
  });
}

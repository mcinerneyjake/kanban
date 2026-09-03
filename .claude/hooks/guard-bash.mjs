// Launcher, not a copy (tkt-6e4c55c81208). The guard itself lives in ticket-workflow and is
// versioned by the pin in package.json, so a fix in the package reaches kanban through `npm ci`
// instead of a hand-port. The vendored copy this replaces went stale for ~24h in 2026-07 and left
// every repo outside kanban with a guard failing OPEN on an unresolvable branch.
//
// A real file has to stay at this path: .claude/settings.json wires it, and a hook whose file cannot
// be resolved does not run at all — a silent no-guard on any fresh clone. That is why the earlier
// plan to point settings.json straight at node_modules/ was rejected. Resolution failure is handled
// HERE instead, and fails CLOSED: a guard that cannot load must block, never wave work through.
//
// Import resolves upward from this directory, so a worktree under .claude/worktrees/ finds the main
// checkout's node_modules — which a $CLAUDE_PROJECT_DIR path-join into node_modules would not.
// Only exit 2 blocks; exit 1 is a non-blocking hook ERROR. So every failure path has to reach the
// exit(2) below — an uncaught throw here would let the command through while looking like a crash.
// That covers version skew as well as a missing package: a pin whose hook exports no callable `main`
// resolves fine and then throws, which is the same fail-open in a costume.
//
// SECOND JOB (tkt-1e6a129c8d7f): the unattended merge gate, sequenced here rather than wired as a
// second PreToolUse(Bash) entry — whether two hooks on one matcher both run is unverified, and one
// entry has no ordering semantics to get wrong. Rationale lives in guard-unattended-merge.mjs.
//
// STDIN IS READ-ONCE, WHICH DRIVES THE CONTROL FLOW: whichever guard reads fd 0 first leaves the
// other with nothing, silently disabling the git rules. So the cheap sentinel check runs FIRST with
// no read — with no night run active this file behaves exactly as before — and only on the active
// path do we consume stdin and re-supply the same bytes to the package guard as a child.
//
// argv[2] overrides the sentinel, for TESTS only; settings.json passes no arguments.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const blockAndExit = (text) => {
  process.stderr.write(text);
  process.exit(2);
};

try {
  const { nightRunActive, decide, message, SENTINEL } = await import('./guard-unattended-merge.mjs');
  const sentinel = process.argv[2] ?? SENTINEL;

  if (!nightRunActive(sentinel)) {
    // Untouched legacy path: the package guard reads fd 0 itself, exactly as before.
    const { main } = await import('ticket-workflow/hooks/guard-bash.mjs');
    if (typeof main !== 'function') {
      throw new TypeError('the installed ticket-workflow exports no callable main — pin too old?');
    }
    await main();
  } else {
    const raw = readFileSync(0, 'utf8');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null; // decide() treats an unreadable command as blocked while a run is active
    }
    const { blocked, reason } = decide(payload, sentinel);
    if (blocked) blockAndExit(message(reason, sentinel));

    // Re-supply the same bytes so the package guard's git rules still apply during a night run.
    // A child process is the only way to give it fd 0 again; the cost is irrelevant on this path.
    const pkg = fileURLToPath(import.meta.resolve('ticket-workflow/hooks/guard-bash.mjs'));
    const res = spawnSync(process.execPath, [pkg], { input: raw, encoding: 'utf8' });
    if (res.error) throw res.error;
    if (res.stderr) process.stderr.write(res.stderr);
    if (res.stdout) process.stdout.write(res.stdout);
    // ONLY a clean 0 is an allow. Forwarding the child's status verbatim made exit 1 — a crash, a
    // renamed `main`, a pin that no longer self-executes — an ALLOW, so a skewed pin would block all
    // Bash on the legacy path while silently dropping the never-commit-to-main rule during a night
    // run, with no signal at all (review, MEDIUM). Signals (status null) land here too.
    process.exit(res.status === 0 ? 0 : 2);
  }
} catch (err) {
  blockAndExit(
    `[guard-bash] BLOCKED: could not run the guard from ticket-workflow (${err?.code ?? err?.message ?? 'import failed'}).\n` +
      'Bash stays blocked until this resolves — run `npm ci` from a plain terminal, outside this session.\n',
  );
}

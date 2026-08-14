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
try {
  const { main } = await import('ticket-workflow/hooks/guard-bash.mjs');
  if (typeof main !== 'function') {
    throw new TypeError('the installed ticket-workflow exports no callable main — pin too old?');
  }
  await main();
} catch (err) {
  process.stderr.write(
    `[guard-bash] BLOCKED: could not run the guard from ticket-workflow (${err?.code ?? err?.message ?? 'import failed'}).\n` +
      'Bash stays blocked until this resolves — run `npm ci` from a plain terminal, outside this session.\n',
  );
  process.exit(2);
}

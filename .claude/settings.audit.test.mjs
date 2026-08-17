import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Git exports an ABSOLUTE GIT_DIR in a worktree and it is inherited by `npm test`, so a temp-repo
// command would silently drive the REAL repository and grade the wrong branch (tkt-cf1e0c0b3dda).
const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];
function hermeticEnv() {
  const env = { ...process.env };
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  return env;
}

/**
 * Every wired PreToolUse hook file that lives in this repo, resolved to a real path.
 * A wired-but-ABSENT file is asserted, never filtered out: the hook then does not run at all, which
 * is the silent no-guard this whole design exists to prevent — quietly dropping it from the list
 * would let every assertion below pass while the guard is missing.
 */
function wiredLocalHooks() {
  const matchers = settings.hooks?.PreToolUse ?? [];
  const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
  const rels = commands
    .map((c) => /\$CLAUDE_PROJECT_DIR\/(\.claude\/hooks\/[\w.-]+\.mjs)/.exec(c)?.[1])
    .filter(Boolean);
  for (const rel of rels) {
    expect(existsSync(join(REPO_ROOT, rel)), `${rel} is wired in settings.json but missing on disk`).toBe(true);
  }
  return rels.map((rel) => join(REPO_ROOT, rel));
}

// Audits the checked-in permission allowlist (.claude/settings.json). This reads rule
// STRINGS, so safety is layered: git rules are broad but guard-bash-backed (asserted below);
// non-git rules are pinned to a reviewed set; delete_ticket + dangerous tokens are rejected.

const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));
const allow = settings.permissions?.allow ?? [];

// MCP tools safe to auto-approve: reads + non-destructive writes. create_ticket stays here but is
// blocked at runtime by guard-ticket (authoring is delegated to the local agent, tkt-2492e26a277a) —
// parallel to the broad git rules being guard-bash-backed. The allowlist entry avoids a re-prompt if
// that policy is ever relaxed; the hook (asserted below) is the real gate.
const REQUIRED_MCP = [
  'mcp__kanban__list_tickets',
  'mcp__kanban__get_ticket',
  'mcp__kanban__start_ticket',
  'mcp__kanban__create_ticket',
  'mcp__kanban__update_ticket',
  'mcp__kanban__record_review',
];

// The complete reviewed set of non-git Bash rules (git rules are exempt, hook-backed).
const EXPECTED_NONGIT_BASH = new Set([
  'Bash(gh pr create *)',
  'Bash(gh pr view *)',
  'Bash(gh pr checks *)',
  'Bash(gh pr merge *)',
  'Bash(npm run typecheck)',
  'Bash(npm run lint)',
  'Bash(npm test)',
  'Bash(npm run test:coverage)',
  'Bash(npm run build)',
  'Bash(npm run agent -- --yes *)', // the delegated create path (tkt-2492e26a277a) — --yes = metered, non-interactive
  'Bash(npx vitest run *)',
]);

// Explicit dangerous tokens that must never appear verbatim in any rule.
const FORBIDDEN = ['rm -r', 'sudo', '--force', '-f ', 'git reset --hard', 'chmod', 'mkfs', 'dd if=', 'curl', 'wget', ':(){', '> /dev/'];

describe('.claude/settings.json permission allowlist', () => {
  it('is a well-formed list of non-empty string rules', () => {
    expect(Array.isArray(allow)).toBe(true);
    expect(allow.length).toBeGreaterThan(0);
    for (const rule of allow) {
      expect(typeof rule).toBe('string');
      expect(rule.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers the expected non-destructive MCP tools', () => {
    for (const tool of REQUIRED_MCP) expect(allow).toContain(tool);
  });

  it('keeps the destructive delete_ticket tool gated (absent from the allowlist)', () => {
    expect(allow.some((rule) => rule.includes('delete_ticket'))).toBe(false);
  });

  it('pins every non-git Bash rule to the reviewed specific set (no wildcarded subcommands)', () => {
    for (const rule of allow) {
      if (!rule.startsWith('Bash(')) continue; // MCP tool rules
      if (rule.startsWith('Bash(git ')) continue; // git breadth is guard-bash-backed
      expect(
        EXPECTED_NONGIT_BASH.has(rule),
        `unexpected non-git Bash rule "${rule}" — if intended, add it to EXPECTED_NONGIT_BASH (a deliberate re-review)`,
      ).toBe(true);
    }
  });

  it('contains no explicit dangerous token in any rule', () => {
    for (const rule of allow) {
      for (const bad of FORBIDDEN) {
        expect(
          rule.toLowerCase().includes(bad.toLowerCase()),
          `allow rule "${rule}" contains forbidden token "${bad}"`,
        ).toBe(false);
      }
    }
  });

  // The broad git rules are only safe because guard-bash blocks the dangerous shapes at runtime — a hard invariant.
  it('keeps the guard-bash PreToolUse hook wired (backstop for the git allowlist)', () => {
    const matchers = settings.hooks?.PreToolUse ?? [];
    const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.some((c) => c.includes('guard-bash'))).toBe(true);
  });

  // create_ticket is allowlisted but must be blocked at runtime by guard-ticket (authoring is
  // delegated to the local agent) — the allow entry is only safe because this hook is wired.
  it('keeps the guard-ticket PreToolUse hook wired (backstop for the create_ticket allow entry)', () => {
    const matchers = settings.hooks?.PreToolUse ?? [];
    const createGuards = matchers.filter((m) => (m.matcher ?? '').includes('create_ticket'));
    const commands = createGuards.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.some((c) => c.includes('guard-ticket'))).toBe(true);
  });

  // Wiring says a guard-shaped path is configured; it cannot say the file behind it still guards. A
  // vendored copy truncated to a no-op keeps the substring and passes the two assertions above — the
  // same fail-open shape one level up. These two close it (tkt-6e4c55c81208).

  // The local hooks must stay LAUNCHERS delegating to the pinned package, never re-vendored copies:
  // the copy this replaced drifted and left every repo outside kanban failing OPEN for ~24h in
  // 2026-07.
  //
  // The check is on SUBSTANCE, not length. Length alone was the original proxy (a re-vendored
  // guard-bash is 333 lines), but a launcher legitimately carries consumer POLICY — guard-ticket's now
  // sets TICKET_WORKFLOW_CREATE_REASON, which is deliberately verbose because it is the text a blocked
  // session reads (tkt-0361525dbf9f). That pushed it to 37 of a 40-line cap, i.e. one paragraph from a
  // false failure. Raising a threshold to fit your own change is exactly how a guard gets hollowed out,
  // so the cap is raised AND paired with what actually distinguishes the two: a launcher delegates and
  // decides nothing, while a vendored guard carries its own rule table.
  const VENDORED_LOGIC = [
    [/^\s*const\s+RULES\b/m, 'defines a RULES table'],
    [/^\s*(export\s+)?function\s+decide\b/m, 'defines its own decide()'],
    [/\bnew RegExp\(|=\s*\/[^/\n]+\/[gimsuy]*\s*[;,)]/m, 'defines a matcher regex'],
  ];

  it('wires only launchers that delegate to the pinned package, not vendored copies', () => {
    const local = wiredLocalHooks();
    expect(local.length).toBeGreaterThan(0); // else every assertion below is vacuous
    for (const file of local) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} does not import the package hook`).toContain('ticket-workflow/hooks/');
      // Generous, because policy text is legitimate here; the substance checks below are the real gate.
      expect(src.split('\n').length, `${file} is too long to be a launcher`).toBeLessThan(80);
      for (const [pattern, what] of VENDORED_LOGIC) {
        expect(pattern.test(src), `${file} ${what} — that is a vendored guard, not a launcher`).toBe(false);
      }
    }
  });

  // The control for the assertion above: the patterns must actually FIRE on a real vendored guard. Three
  // regexes that match nothing would pass every launcher forever — a guard that cannot fail.
  it('those vendored-logic patterns detect the real guard they exist to reject', () => {
    const packaged = join(dirname(createRequire(import.meta.url).resolve('ticket-workflow')), '..', 'hooks', 'guard-bash.mjs');
    const src = readFileSync(packaged, 'utf8');
    const fired = VENDORED_LOGIC.filter(([pattern]) => pattern.test(src)).map(([, what]) => what);
    expect(fired, 'no pattern matched the packaged guard-bash — the checks above are vacuous').not.toEqual([]);
  });

  // Verify the EFFECT, not the wiring: drive the actually-wired file and watch it block. The package
  // ships no tests, so with the duplicated local suites gone this is kanban's only executable proof
  // that the PINNED hook build still guards — the hook analogue of server/packageContract.test.ts.
  it('blocks a commit on main through the wired launcher, and allows one on a branch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, env: hermeticEnv(), encoding: 'utf8' });
      git('init', '-q', '-b', 'main', '.');
      // The remote is load-bearing: as of ticket-workflow v0.12.0 the protected-branch rules only
      // apply to repos that have one, because "land it on a branch and open a PR" is meaningless
      // with nowhere to push (tkt-f32915b3e858). Without this the fixture is exempt and this test
      // passes while asserting nothing.
      git('remote', 'add', 'origin', 'https://example.invalid/r.git');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.txt'), 'x');
      git('add', 'a.txt');
      git('commit', '-qm', 'init');

      const hook = wiredLocalHooks().find((f) => f.includes('guard-bash'));
      expect(hook, 'no guard-bash launcher is wired').toBeTruthy();
      const fire = (env = {}) =>
        spawnSync('node', [hook], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }),
          cwd: repo,
          env: { ...hermeticEnv(), ...env },
          encoding: 'utf8',
        });

      const onMain = fire();
      expect(onMain.status, `expected a block on main, got ${onMain.status}: ${onMain.stderr}`).toBe(2);

      // The on-branch half removes the alternative explanation — a guard that blocks everything would
      // pass the assertion above while guarding nothing in particular.
      git('switch', '-qc', 'feat/tkt-abcdef123456-x');
      expect(fire().status, 'the same command must be allowed on a feature branch').toBe(0);

      // The highest-consequence rule in the guard: an unresolvable branch must BLOCK, because every
      // way of breaking `git rev-parse` would otherwise be a commit-to-main bypass (tkt-fbc74a3252fe).
      // Run on the feature branch, where the case above proves the command is otherwise allowed.
      const blinded = fire({ GIT_CEILING_DIRECTORIES: repo, GIT_CONFIG_PARAMETERS: "'garbage'" });
      expect(blinded.status, `an unresolvable branch must fail CLOSED, got ${blinded.status}`).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // guard-ticket needs its own behavioural case: the shape test above is satisfied by a path in a
  // COMMENT, so a launcher hollowed out to `process.exit(0)` would leave create_ticket unguarded —
  // defeating the metered-intake gate — with every other assertion here still green.
  it('blocks create_ticket through the wired launcher, and allows an unrelated tool', () => {
    const hook = wiredLocalHooks().find((f) => f.includes('guard-ticket'));
    expect(hook, 'no guard-ticket launcher is wired').toBeTruthy();
    const fire = (tool_name) =>
      spawnSync('node', [hook], {
        input: JSON.stringify({ tool_name, tool_input: { title: 'x' } }),
        env: hermeticEnv(),
        encoding: 'utf8',
      });

    const blockedCall = fire('mcp__kanban__create_ticket');
    expect(blockedCall.status, `expected a block, got ${blockedCall.status}: ${blockedCall.stderr}`).toBe(2);
    // Removes the "blocks everything, including on a failed import" explanation.
    expect(fire('mcp__kanban__get_ticket').status, 'an unrelated tool must be allowed').toBe(0);
  });

  // `gh pr merge` lands a commit on main SERVER-SIDE with no `git push`, so guard-bash's pushesMain
  // rule is never consulted and the merge sails past it — watched on the previously pinned build:
  // exit 0 (tkt-e508ad42a68a). v0.16.0's guard-subagent-gates closes the half that has no human at the
  // keyboard. Asserted here because it is the pin that decides whether the file exists at all.
  //
  // Scope, stated so this is not read as more than it is: this drives the hook out of the PINNED
  // PACKAGE, not out of `.claude/settings.json`. guard-subagent-gates is wired at USER scope
  // (machine-local, unversioned), so nothing in this repo can assert it is armed — only that the build
  // kanban pins still refuses. Hence no wiredLocalHooks() lookup.
  it('refuses a subagent `gh pr merge` through the pinned build, and allows the main thread', () => {
    const hook = join(dirname(createRequire(import.meta.url).resolve('ticket-workflow')), '..', 'hooks', 'guard-subagent-gates.mjs');
    expect(existsSync(hook), `the pinned build ships no guard-subagent-gates (${hook})`).toBe(true);
    const fire = (command, extra) =>
      spawnSync('node', [hook], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...extra }),
        env: hermeticEnv(),
        encoding: 'utf8',
      });

    const sub = { agent_id: 'agent_audit', agent_type: 'code-reviewer' };
    const merge = fire('gh pr merge 40 --squash --delete-branch', sub);
    expect(merge.status, `expected a block, got ${merge.status}: ${merge.stderr}`).toBe(2);

    // Two controls, because there are two ways this could block for the wrong reason. Without the
    // first it could be a block-all-`gh` guard; without the second, a guard that blocks the command
    // rather than the CALLER — which would wedge this repo's own merge gate.
    expect(fire('gh pr view 40 --json state', sub).status, 'a gh READ must stay allowed').toBe(0);
    expect(fire('gh pr merge 40 --squash', {}).status, 'the main thread must stay allowed').toBe(0);
  });

  // Guards are per-repo (duplicates decide identically); WRITERS are per-machine — a second track-steps
  // double-writes every milestone (1,889 rows, 2026-07-17..08-13; tkt-af4669ce9a0d).
  // Detects OVER-wiring only: the surviving writer is machine-local, so its removal is silent here.
  it('wires NO PostToolUse track-steps hook (the writer belongs at user scope, exactly once)', () => {
    const matchers = settings.hooks?.PostToolUse ?? [];
    const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.filter((c) => c.includes('track-steps'))).toEqual([]);
  });
});

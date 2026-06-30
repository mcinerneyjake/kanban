import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Automated audit of the checked-in permission allowlist (.claude/settings.json).
//
// HONEST SCOPE — what this can and cannot guarantee:
// A permission rule is a glob, so it admits a *space* of commands, not one
// command; this audit reads rule STRINGS, so it cannot by itself prove that a
// broad glob admits nothing dangerous at runtime. Safety is therefore layered:
//
//   • git rules are intentionally broad (`Bash(git add *)`, `git push *`, …)
//     because the guard-bash PreToolUse hook inspects the ACTUAL command and
//     blocks the dangerous shapes (force-push, add -f, branch -D, reset --hard,
//     …). That behaviour is proven by guard-bash.test.mjs; here we only assert
//     the hook is still wired.
//   • non-git rules (npm / npx / gh) have NO such runtime backstop, so they are
//     PINNED to a reviewed, specific set — a wildcarded subcommand (e.g.
//     `Bash(npm run *)`) is rejected. Adding a new non-git capability requires
//     editing EXPECTED_NONGIT_BASH, i.e. a deliberate re-review.
//   • delete_ticket and explicit dangerous tokens are rejected outright.

const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));
const allow = settings.permissions?.allow ?? [];

// MCP tools safe to auto-approve: reads + non-destructive writes.
const REQUIRED_MCP = [
  'mcp__kanban__list_tickets',
  'mcp__kanban__get_ticket',
  'mcp__kanban__start_ticket',
  'mcp__kanban__create_ticket',
  'mcp__kanban__update_ticket',
];

// The complete reviewed set of non-git Bash rules. git rules are exempt (hook-
// backed); every other Bash rule must be exactly one of these.
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

  // The broad git rules are only safe because guard-bash blocks the dangerous
  // git shapes at runtime. If that hook is ever unwired, the git allowlist must
  // be reconsidered — so this is a hard invariant.
  it('keeps the guard-bash PreToolUse hook wired (backstop for the git allowlist)', () => {
    const matchers = settings.hooks?.PreToolUse ?? [];
    const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.some((c) => c.includes('guard-bash'))).toBe(true);
  });
});

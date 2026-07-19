import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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
});

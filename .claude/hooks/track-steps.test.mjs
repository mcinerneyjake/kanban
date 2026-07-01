import { describe, it, expect } from 'vitest';
import { commandToMilestones, extractTicketId, stateFromExit, HOOK_STEPS } from './track-steps.mjs';
import { STEP_IDS } from '../../shared/constants.js';

describe('commandToMilestones', () => {
  it('maps each recognized single command to its milestone', () => {
    expect(commandToMilestones('git switch -c feat/tkt-abc-x')).toEqual(['branch']);
    expect(commandToMilestones('git checkout -b feat/x')).toEqual(['branch']);
    expect(commandToMilestones('npm run typecheck')).toEqual(['typecheck']);
    expect(commandToMilestones('npm run lint')).toEqual(['lint']);
    expect(commandToMilestones('npm test')).toEqual(['test']);
    expect(commandToMilestones('npm run test:coverage')).toEqual(['test']);
    expect(commandToMilestones('npx vitest run server')).toEqual(['test']);
    expect(commandToMilestones('git commit -m "x"')).toEqual(['commit']);
    expect(commandToMilestones('gh pr create --base main')).toEqual(['pr_opened']);
  });

  it('collects every milestone in a compound command, in order', () => {
    expect(commandToMilestones('npm run typecheck && npm run lint && npm test'))
      .toEqual(['typecheck', 'lint', 'test']);
  });

  it('dedupes a repeated milestone', () => {
    expect(commandToMilestones('npm test && npm test')).toEqual(['test']);
  });

  it('sees through a simple VAR=val env prefix', () => {
    expect(commandToMilestones('FOO=bar npm run lint')).toEqual(['lint']);
  });

  it('returns [] for non-milestone commands', () => {
    expect(commandToMilestones('ls -la')).toEqual([]);
    expect(commandToMilestones('git status')).toEqual([]);
    expect(commandToMilestones('')).toEqual([]);
  });

  it('does not treat a plain branch switch (no -c) as a branch cut', () => {
    expect(commandToMilestones('git switch main')).toEqual([]);
  });

  it('requires the real command word (not a mention inside echo)', () => {
    expect(commandToMilestones('echo "npm run lint"')).toEqual([]);
  });
});

describe('extractTicketId', () => {
  it('pulls the ticket id out of a <type>/<id>-<slug> branch', () => {
    expect(extractTicketId('feat/tkt-512f9b15ddb8-add-telemetry')).toBe('tkt-512f9b15ddb8');
  });

  it('returns null when the branch carries no ticket id', () => {
    expect(extractTicketId('main')).toBeNull();
    expect(extractTicketId('feat/no-ticket-here')).toBeNull();
    expect(extractTicketId(null)).toBeNull();
  });
});

describe('stateFromExit', () => {
  it('maps exit 0 to passed and any non-zero to failed', () => {
    expect(stateFromExit(0)).toBe('passed');
    expect(stateFromExit(1)).toBe('failed');
    expect(stateFromExit(2)).toBe('failed');
  });
});

describe('catalog parity with shared/constants.ts', () => {
  it('every hook step is a valid shared StepId (no drift)', () => {
    for (const step of HOOK_STEPS) expect(STEP_IDS).toContain(step);
  });

  it('hook steps + status steps exactly cover the shared catalog', () => {
    const statusSteps = ['started', 'qa', 'done'];
    expect(new Set([...HOOK_STEPS, ...statusSteps])).toEqual(new Set(STEP_IDS));
  });
});

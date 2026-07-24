import { describe, it, expect, expectTypeOf } from 'vitest';
import { isStatusId, isTicketType, isPriority } from './constants.js';
import * as local from './constants.js';
import * as pkg from 'ticket-workflow';

describe('isStatusId', () => {
  it('returns true for every valid status id', () => {
    expect(isStatusId('backlog')).toBe(true);
    expect(isStatusId('todo')).toBe(true);
    expect(isStatusId('in-progress')).toBe(true);
    expect(isStatusId('qa')).toBe(true);
    expect(isStatusId('done')).toBe(true);
    expect(isStatusId('archived')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isStatusId('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isStatusId('')).toBe(false);
  });
});

describe('isTicketType', () => {
  it('returns true for every valid ticket type', () => {
    expect(isTicketType('bug')).toBe(true);
    expect(isTicketType('feature')).toBe(true);
    expect(isTicketType('task')).toBe(true);
    expect(isTicketType('chore')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isTicketType('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isTicketType('')).toBe(false);
  });
});

describe('isPriority', () => {
  it('returns true for every valid priority', () => {
    expect(isPriority('low')).toBe(true);
    expect(isPriority('medium')).toBe(true);
    expect(isPriority('high')).toBe(true);
    expect(isPriority('urgent')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isPriority('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isPriority('')).toBe(false);
  });
});

// Parity with the ticket-workflow package (tkt-36390042a0bf, tkt-66f0e22efd5e). kanban keeps a local
// shared/constants.ts for its own imports (frontend, agent), while the service consumes the package;
// the two copies of the domain enums can silently DRIFT, and the board would then disagree with the
// package-backed service on what a valid status/type/step is. This asserts the shared subset is
// identical. Out of scope (correctly): kanban-only constants (terminal WS codes, economics) and the
// package-only BRANCH_TICKET_ID_RE — parity covers only what BOTH declare.
describe('shared-constant parity with the ticket-workflow package', () => {
  // Each pair references a NAMED export on both sides, so a rename on EITHER side is a COMPILE error
  // (caught by `npm run typecheck`), not merely a runtime miss; the deep-equal then catches a value drift.
  const VALUE_PAIRS: readonly [name: string, localValue: unknown, pkgValue: unknown][] = [
    ['BOARD_STATUSES', local.BOARD_STATUSES, pkg.BOARD_STATUSES],
    ['STATUSES', local.STATUSES, pkg.STATUSES],
    ['STATUS_IDS', local.STATUS_IDS, pkg.STATUS_IDS],
    ['CREATE_STATUS_IDS', local.CREATE_STATUS_IDS, pkg.CREATE_STATUS_IDS],
    ['TYPES', local.TYPES, pkg.TYPES],
    ['PRIORITIES', local.PRIORITIES, pkg.PRIORITIES],
    ['SOURCES', local.SOURCES, pkg.SOURCES],
    ['STEPS', local.STEPS, pkg.STEPS],
    ['STEP_IDS', local.STEP_IDS, pkg.STEP_IDS],
    ['STEP_STATES', local.STEP_STATES, pkg.STEP_STATES],
    ['STATUS_STEP', local.STATUS_STEP, pkg.STATUS_STEP],
  ];

  // Probe discipline: a parametrized loop over an empty table passes vacuously — a green check that
  // checked nothing. Guard the table is populated before trusting the per-constant assertions.
  it('has a non-empty parity table', () => {
    expect(VALUE_PAIRS.length).toBeGreaterThan(0);
  });

  it.each(VALUE_PAIRS)('%s is identical between the local copy and the package', (_name, localValue, pkgValue) => {
    expect(localValue).toBeDefined();
    expect(pkgValue).toBeDefined();
    expect(localValue).toEqual(pkgValue);
  });

  // Type parity — a structural drift (a field renamed/added/removed on one side, or an enum member
  // changed) is a COMPILE error under `tsc --noEmit`, before the runtime suite even runs. `npm test`
  // alone won't catch it (vitest runs without --typecheck), but the gate runs typecheck too.
  it('domain types are structurally identical', () => {
    expectTypeOf<local.StatusId>().toEqualTypeOf<pkg.StatusId>();
    expectTypeOf<local.TicketType>().toEqualTypeOf<pkg.TicketType>();
    expectTypeOf<local.Priority>().toEqualTypeOf<pkg.Priority>();
    expectTypeOf<local.TicketSource>().toEqualTypeOf<pkg.TicketSource>();
    expectTypeOf<local.StepId>().toEqualTypeOf<pkg.StepId>();
    expectTypeOf<local.StepState>().toEqualTypeOf<pkg.StepState>();
    expectTypeOf<local.Ticket>().toEqualTypeOf<pkg.Ticket>();
    expectTypeOf<local.Provenance>().toEqualTypeOf<pkg.Provenance>();
  });
});

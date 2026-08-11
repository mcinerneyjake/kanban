import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToBaseline, loadBaseline, checkRepo } from './vacuous-ratchet.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('compareToBaseline', () => {
  it('passes when the count equals the ceiling', () => {
    expect(compareToBaseline('r', 4, { max: 4 }).ok).toBe(true);
  });

  it('fails when the count rises above the ceiling', () => {
    const r = compareToBaseline('r', 5, { max: 4 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ceiling is 4');
  });

  // The fail-open case. "No ceiling recorded" must never read as "clean".
  it('FAILS on a missing baseline row rather than passing', () => {
    for (const row of [undefined, {}, { max: 'zero' }]) {
      const r = compareToBaseline('unknown-repo', 3, row);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('could not be judged');
    }
  });

  it('fails a missing row even when the probe found nothing', () => {
    // 0 found is exactly when a missing row is most tempting to wave through.
    expect(compareToBaseline('unknown-repo', 0, undefined).ok).toBe(false);
  });

  it('passes but asks for a tighter ceiling when the count falls', () => {
    const r = compareToBaseline('r', 2, { max: 4 });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('lower "max" to 2');
  });
});

describe('vacuous-baseline.json', () => {
  const baseline = loadBaseline();

  it('records every repo that was swept, so a real 0 is distinguishable from an unrun probe', () => {
    const repos = Object.keys(baseline.repos);
    // Length is pinned so a silently-emptied baseline cannot pass this file.
    expect(repos).toHaveLength(6);
    expect(repos).toContain('kanban');
    expect(repos).toContain('equipment-schedule');
  });

  it('carries an asOf date and a numeric ceiling per repo', () => {
    expect(baseline.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [repo, row] of Object.entries(baseline.repos)) {
      expect(typeof row.max, repo).toBe('number');
      expect(row.max, repo).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('this repo against its own ceiling', () => {
  // The enforcement point: kanban's gate fails if a vacuous test lands here.
  it('has no more vacuous-test candidates than its baseline allows', () => {
    const result = checkRepo('kanban', REPO_ROOT);
    expect(result.ok, result.message).toBe(true);
  });
});

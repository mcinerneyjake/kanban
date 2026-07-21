import { describe, it, expect } from 'vitest';
import { isDaemonUp, serverStatusFromJson, modelsLoaded, resolveProbeBase, parseYesNo, describeCheckoutFreshness } from './preflight-lib.mjs';

describe('isDaemonUp', () => {
  it('is up only on a clean exit (0)', () => {
    expect(isDaemonUp(0)).toBe(true);
    expect(isDaemonUp(1)).toBe(false);
    expect(isDaemonUp(null)).toBe(false); // spawnSync sets status null when it can't run docker
  });
});

describe('serverStatusFromJson', () => {
  it('reads running + port from clean JSON', () => {
    expect(serverStatusFromJson('{"running":true,"port":1234}')).toEqual({ running: true, port: 1234 });
  });
  it('reports not-running', () => {
    expect(serverStatusFromJson('{"running":false}')).toEqual({ running: false, port: null });
  });
  it('tolerates a preamble before the JSON (first brace-group wins)', () => {
    expect(serverStatusFromJson('Checking…\n{"running":true,"port":1234}\n')).toEqual({ running: true, port: 1234 });
  });
  it('reads as down on garbage / empty / nullish', () => {
    expect(serverStatusFromJson('not json')).toEqual({ running: false, port: null });
    expect(serverStatusFromJson('')).toEqual({ running: false, port: null });
    expect(serverStatusFromJson(undefined)).toEqual({ running: false, port: null });
  });
});

describe('modelsLoaded', () => {
  it('true only when /v1/models has a non-empty data array', () => {
    expect(modelsLoaded({ data: [{ id: 'm' }] })).toBe(true);
  });
  it('false when the server is up but no model is loaded', () => {
    expect(modelsLoaded({ data: [] })).toBe(false);
    expect(modelsLoaded({})).toBe(false);
    expect(modelsLoaded(null)).toBe(false);
    expect(modelsLoaded(undefined)).toBe(false);
  });
});

describe('resolveProbeBase', () => {
  it('defaults to the LM Studio endpoint', () => {
    expect(resolveProbeBase({})).toBe('http://localhost:1234/v1');
    expect(resolveProbeBase({ LLM_BASE_URL: '   ' })).toBe('http://localhost:1234/v1');
  });
  it('honors LLM_BASE_URL and strips trailing slashes', () => {
    expect(resolveProbeBase({ LLM_BASE_URL: 'http://host:8080/v1/' })).toBe('http://host:8080/v1');
    expect(resolveProbeBase({ LLM_BASE_URL: 'http://host:8080/v1' })).toBe('http://host:8080/v1');
  });
});

describe('parseYesNo', () => {
  it('bare Enter takes the default', () => {
    expect(parseYesNo('', true)).toBe(true);
    expect(parseYesNo('  ', false)).toBe(false);
  });
  it('accepts y/yes and n/no case-insensitively', () => {
    expect(parseYesNo('y')).toBe(true);
    expect(parseYesNo('YES')).toBe(true);
    expect(parseYesNo('n')).toBe(false);
    expect(parseYesNo('No')).toBe(false);
  });
  it('unrecognized input falls back to the default', () => {
    expect(parseYesNo('maybe', true)).toBe(true);
    expect(parseYesNo('maybe', false)).toBe(false);
  });
});

describe('describeCheckoutFreshness', () => {
  it('is OK and quiet when up to date with origin/main', () => {
    const r = describeCheckoutFreshness({ branch: 'main', behind: 0 });
    expect(r.level).toBe('ok');
    expect(r.message).toContain('up to date with origin/main');
  });

  it('warns loudly when behind by the threshold or more (the stale-checkout trap)', () => {
    const r = describeCheckoutFreshness({ branch: 'task/tkt-abc-old', behind: 8, threshold: 3 });
    expect(r.level).toBe('warn');
    expect(r.message).toContain('8 commits behind origin/main');
    expect(r.message).toContain('task/tkt-abc-old');
    expect(r.message).toContain('git switch main && git pull'); // tells you how to recover
  });

  it('stays OK (informational) for small feature-branch drift below the threshold', () => {
    const r = describeCheckoutFreshness({ branch: 'feat/tkt-x', behind: 2, threshold: 3 });
    expect(r.level).toBe('ok');
    expect(r.message).toContain('feat/tkt-x');
    expect(r.message).toContain('2 commits behind');
  });

  it('warns on a detached HEAD (not on any branch)', () => {
    for (const branch of ['HEAD', '', null, undefined]) {
      const r = describeCheckoutFreshness({ branch, behind: 0 });
      expect(r.level).toBe('warn');
      expect(r.message).toContain('detached HEAD');
    }
  });

  it('uses singular "commit" for exactly one behind', () => {
    const r = describeCheckoutFreshness({ branch: 'feat/x', behind: 1, threshold: 3 });
    expect(r.message).toContain('1 commit behind');
    expect(r.message).not.toContain('1 commits');
  });

  it('honors a custom threshold, including 0 (warn on any drift)', () => {
    expect(describeCheckoutFreshness({ branch: 'b', behind: 1, threshold: 1 }).level).toBe('warn');
    expect(describeCheckoutFreshness({ branch: 'b', behind: 1, threshold: 0 }).level).toBe('warn');
    // threshold 0 with behind 0 is still up-to-date, not a warning.
    expect(describeCheckoutFreshness({ branch: 'b', behind: 0, threshold: 0 }).level).toBe('ok');
  });

  it('treats a non-numeric/negative behind as up to date (defensive — never invents staleness)', () => {
    expect(describeCheckoutFreshness({ branch: 'main', behind: NaN }).level).toBe('ok');
    expect(describeCheckoutFreshness({ branch: 'main', behind: -3 }).level).toBe('ok');
    expect(describeCheckoutFreshness({ branch: 'main', behind: 'oops' }).level).toBe('ok');
  });
});

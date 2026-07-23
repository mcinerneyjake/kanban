import { describe, it, expect } from 'vitest';
import { isDaemonUp, serverStatusFromJson, modelsLoaded, resolveProbeBase, parseYesNo, describeCheckoutFreshness, describeSeedCredential } from './preflight-lib.mjs';

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

describe('describeSeedCredential', () => {
  const NOW = Date.UTC(2026, 6, 22); // 2026-07-22
  // A realistically-shaped setup token: the seeder now refuses to WRITE anything else, so a fixture
  // using a 3-char placeholder would assert a state that can no longer exist (tkt-bfb3bc9f98d4).
  const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(97);
  const day = 86_400_000;
  // What terminal-setup-cred.mjs writes: non-refreshing, far-future local stamp.
  const setupToken = (over = {}) => ({
    claudeAiOauth: { accessToken: TOKEN, refreshToken: '', expiresAt: NOW + 3650 * day, scopes: ['user:inference'], ...over },
  });

  it('passes a setup-token seed', () => {
    const r = describeSeedCredential({ credential: setupToken(), now: NOW });
    expect(r.level).toBe('ok');
  });

  // The shape that actually broke: a /login credential whose access token expired 2026-07-21 while
  // its refresh token stayed live — refreshed only inside session copies that are then deleted.
  it('warns on the real 2026-07-21 seed: expired, with a live refresh token (tkt-da1caf5316f7)', () => {
    const r = describeSeedCredential({
      credential: {
        claudeAiOauth: {
          accessToken: 'x'.repeat(108), refreshToken: 'y'.repeat(108),
          expiresAt: Date.UTC(2026, 6, 21, 5, 47, 28, 552),
          refreshTokenExpiresAt: Date.UTC(2026, 7, 19), subscriptionType: 'max',
          scopes: ['user:file_upload', 'user:inference', 'user:mcp_servers', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      now: NOW,
    });
    expect(r.level).toBe('warn');
    expect(r.message).toContain('EXPIRED on 2026-07-21');
    expect(r.message).toContain('refresh token'); // names the root cause, not just the symptom
  });

  it('warns on a refreshable seed even when its expiry looks far off', () => {
    // A /login credential really lasts ~24h whatever the file claims, so expiry alone would miss it.
    const r = describeSeedCredential({ credential: setupToken({ refreshToken: 'live' }), now: NOW });
    expect(r.level).toBe('warn');
    expect(r.message).toContain('refresh token');
  });

  it('warns inside the expiry window and passes outside it', () => {
    expect(describeSeedCredential({ credential: setupToken({ expiresAt: NOW + 3 * day }), now: NOW }).level).toBe('warn');
    expect(describeSeedCredential({ credential: setupToken({ expiresAt: NOW + 30 * day }), now: NOW }).level).toBe('ok');
    const custom = describeSeedCredential({ credential: setupToken({ expiresAt: NOW + 30 * day }), now: NOW, warnWithinDays: 60 });
    expect(custom.level).toBe('warn');
  });

  it('uses singular "day" at exactly one day left', () => {
    const r = describeSeedCredential({ credential: setupToken({ expiresAt: NOW + day }), now: NOW });
    expect(r.message).toContain('expires in 1 day ');
    expect(r.message).not.toContain('1 days');
  });

  // Fail-loud: a seed we can't read must never be reported as fine.
  it('warns when the seed is absent, empty, or unreadable', () => {
    expect(describeSeedCredential({ credential: null, now: NOW }).level).toBe('warn');
    expect(describeSeedCredential({ credential: {}, now: NOW }).level).toBe('warn');
    expect(describeSeedCredential({ credential: { claudeAiOauth: { accessToken: '' } }, now: NOW }).level).toBe('warn');
    const bad = describeSeedCredential({ credential: null, error: 'Unexpected token }', now: NOW });
    expect(bad.level).toBe('warn');
    expect(bad.message).toContain('unreadable');
  });

  it('accepts a bare credential object (no claudeAiOauth wrapper)', () => {
    const r = describeSeedCredential({ credential: { accessToken: TOKEN, refreshToken: '', expiresAt: NOW + 3650 * day }, now: NOW });
    expect(r.level).toBe('ok');
  });

  it('does not invent an expiry when the field is missing or junk', () => {
    for (const expiresAt of [undefined, null, 'soon', NaN, 0]) {
      expect(describeSeedCredential({ credential: setupToken({ expiresAt }), now: NOW }).level).toBe('ok');
    }
  });

  it('always names the re-seed command, so the warning is actionable', () => {
    const r = describeSeedCredential({ credential: null, now: NOW });
    expect(r.message).toContain('claude setup-token');
    expect(r.message).toContain('terminal-setup-cred.mjs');
  });
});

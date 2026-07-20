import { describe, it, expect } from 'vitest';
import { isDaemonUp, serverStatusFromJson, modelsLoaded, resolveProbeBase, parseYesNo } from './preflight-lib.mjs';

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

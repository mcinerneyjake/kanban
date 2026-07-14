import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { meterRun, type MeterRunInput } from './meterRun.js';
// Namespace imports so appendRun / buildSummary can be stubbed to throw (live ESM binding
// — meterRun reads the same module objects vitest spies on), exercising the best-effort
// swallow on both the persist and the cost-assembly paths.
import * as runLog from './runLog.js';
import * as summary from './summary.js';
import { emptyUsage } from './usage.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-run-test-'));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
});
afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  vi.restoreAllMocks();
  await fs.rm(runsDir, { recursive: true, force: true });
});

function input(over: Partial<MeterRunInput> = {}): MeterRunInput {
  return {
    runId: 'run-meter',
    model: 'test-model',
    usage: { ...emptyUsage(), promptTokens: 10, completionTokens: 5, totalTokens: 15, activeMs: 100 },
    outcome: { created: 1, updated: 0, declined: 0, noProposal: false, errored: false },
    reviewMs: 250,
    ticketIds: { created: ['tkt-1'], updated: [] },
    prefixText: 'system prompt + tools',
    dynamicText: 'the run input',
    ...over,
  };
}

describe('meterRun', () => {
  it('builds the cost summary, persists the run, and returns the summary', async () => {
    const summary = await meterRun(input());
    // Returned summary is the four cost-line groups.
    expect(summary).toMatchObject({ measured: expect.any(Array), assumed: expect.any(Array), externalities: expect.any(Array), headline: expect.any(Array) });

    const run = await runLog.readRun('run-meter');
    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      runId: 'run-meter',
      model: 'test-model',
      outcome: { created: 1, noProposal: false },
      ticketIds: { created: ['tkt-1'], updated: [] },
    });
    expect(run?.usage.totalTokens).toBe(15);
    expect(run?.reviewMs).toBe(250);
    // The persisted cost equals the returned summary (one build, no drift).
    expect(run?.cost).toEqual(summary);
  });

  it('swallows an appendRun failure (best-effort) and still returns the REAL summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(runLog, 'appendRun').mockRejectedValueOnce(new Error('disk full'));

    // Must not throw despite the persist failure, and the built cost is still returned
    // (so the CLI renders the real summary even when the write drops).
    const result = await meterRun(input({ runId: 'run-fail' }));
    expect(result.assumed.length).toBeGreaterThan(0); // the real, non-empty summary
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-fail'));
    expect(await runLog.readRun('run-fail')).toBeNull(); // nothing persisted
  });

  // A cost-build throw must NOT escape either (a controller apply() already wrote the
  // ticket; metering must never 500 the request). Returns an empty summary instead.
  it('swallows a buildSummary failure and returns an empty summary without persisting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(summary, 'buildSummary').mockImplementationOnce(() => { throw new Error('bad cost config'); });
    const append = vi.spyOn(runLog, 'appendRun');

    const result = await meterRun(input({ runId: 'run-nocost' }));
    expect(result).toEqual({ measured: [], assumed: [], externalities: [], headline: [] });
    expect(append).not.toHaveBeenCalled(); // no record when the cost couldn't be built
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-nocost'));
  });
});

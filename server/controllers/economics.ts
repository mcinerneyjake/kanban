import type { Request, Response } from 'express';
import { readRun } from '../../agent/cost/runLog.js';
import { summarizeRun, summarizeEconomicsFromLog } from '../../agent/cost/economicsSummary.js';
import { parseRunId, parseDateBound } from '../schemas/query.js';
import { HttpError } from '../tickets.js';

// Read-side economics aggregation over the agent run log (run-scoped, never the
// board). `?runId=` returns a single run's breakdown (404 if unknown — it's the
// provenance-badge deep-link target); otherwise a rollup over `?from=`/`?to=`.
export async function economics(req: Request, res: Response): Promise<void> {
  const runId = parseRunId(req.query.runId);
  if (runId) {
    const run = await readRun(runId);
    if (!run) throw new HttpError(404, `Run not found: ${runId}`);
    res.json(summarizeRun(run));
    return;
  }
  res.json(await summarizeEconomicsFromLog({
    from: parseDateBound(req.query.from, 'from'),
    to: parseDateBound(req.query.to, 'to'),
  }));
}

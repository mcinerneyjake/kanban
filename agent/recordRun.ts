import fs from 'node:fs/promises';
import path from 'node:path';
import { RuntimeEmbedder } from './retrieval/retrieval.js';
import { buildBoardIndex } from './retrieval/indexCache.js';
import { RuntimeChatClient, resolveLlmConfig } from './runtime/llm.js';
import { runIntake, SYSTEM_PROMPT } from './runtime/loop.js';
import { AGENT_TOOLS } from './runtime/tools.js';
import { mergeUsage, subtractUsage } from './cost/usage.js';
import { resolveCostConfig } from './cost/costConfig.js';
import { buildSummary } from './cost/summary.js';
import { appendRun } from './cost/runLog.js';
import { ReplayRecorder } from './replayRecorder.js';
import { isTrace } from '../shared/replayTrace.js';

// Records ONE real agent run into a replay-viewer trace JSON (shared/replayTrace).
// Mirrors agent/index.ts's deps-building, but wraps chat/index/approve with the
// ReplayRecorder so the full step trace is captured — no changes to the loop.
//   npm run agent:record -- --out traces/create.json "the export button 500s"
//   npm run agent:record -- --decline --out traces/decline.json "<vague note>"
// --decline declines at the gate (records a declined approval, writes nothing);
// otherwise every mutating tool is auto-approved so writes execute in-run.
// Requires running embedding + chat models (e.g. LM Studio).

const USAGE = 'Usage: npm run agent:record -- --out <path> [--decline] "<report>"';

try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let decline = false;
  let out = '';
  // Leading flags only, so a `--`-lookalike inside the report isn't consumed.
  while (argv.length > 0) {
    const first = argv[0];
    if (first === '--decline') { decline = true; argv.shift(); }
    else if (first === '--out') {
      argv.shift();
      const value = argv.shift();
      // A missing value (or the next flag) must error, not silently swallow the
      // following flag and write to a file literally named e.g. "--decline".
      if (value === undefined || value.startsWith('--')) { console.error(USAGE); process.exit(1); }
      out = value;
    } else break;
  }
  const input = argv.join(' ').trim();
  if (!input || !out) { console.error(USAGE); process.exit(1); }

  const recorder = new ReplayRecorder();
  const embedder = RuntimeEmbedder.fromEnv();
  const chat = RuntimeChatClient.fromEnv();
  const model = resolveLlmConfig().model;

  console.log('Building the board index…');
  const index = await buildBoardIndex(embedder);
  // Snapshot the embedder AFTER the index build so the one-time full-board
  // embedding pass is not charged to this run — the trace totals then reflect the
  // run's marginal cost (chat + per-query embeds), which is what the viewer shows.
  const embedBaseline = embedder.getUsage();
  recorder.instrument(index);
  console.log(`Indexed ${index.size} tickets. Recording intake (${decline ? 'decline' : 'auto-approve'})…`);

  const result = await runIntake(input, {
    chat: recorder.chat(chat),
    index,
    approve: recorder.approve(() => !decline),
  });

  const usage = mergeUsage(chat.getUsage(), subtractUsage(embedder.getUsage(), embedBaseline));
  const at = new Date().toISOString();

  // A real create/update stamps this runId onto the ticket frontmatter. Persist
  // the run log (as agent/index.ts does) so the ticket's provenance badge resolves
  // to a real run rather than a dead "?runId=" link. Best-effort — the writes
  // already landed, so a log failure must not fail the recording.
  const summary = buildSummary({
    usage,
    outcome: result.outcome,
    reviewMs: 0, // non-interactive gate — no human review pause to meter
    cfg: resolveCostConfig(),
    model,
    prefixText: SYSTEM_PROMPT + JSON.stringify(AGENT_TOOLS),
    dynamicText: input,
  });
  try {
    await appendRun({
      runId: result.runId, at, model, usage,
      outcome: result.outcome, reviewMs: 0, cost: summary,
      ticketIds: { created: result.createdIds, updated: result.updatedIds },
    });
  } catch (err) {
    console.warn(`[runlog] failed to persist run ${result.runId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const trace = recorder.build({
    input, runId: result.runId, model, at,
    final: result.final, createdIds: result.createdIds, updatedIds: result.updatedIds,
    outcome: result.outcome, usage,
  });

  // Fail loudly if what we recorded doesn't satisfy the schema the viewer reads.
  if (!isTrace(trace)) {
    console.error('Recorded trace failed isTrace() validation — not written.');
    process.exit(1);
  }

  const outPath = path.resolve(out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`\n--- Result (${result.steps} steps) ---\n${result.final}`);
  console.log(`\nWrote ${trace.steps.length} trace steps → ${out}`);
  console.log(`runId ${result.runId} · outcome ${JSON.stringify(trace.meta.outcome)} · created ${JSON.stringify(result.createdIds)} · updated ${JSON.stringify(result.updatedIds)}`);
}

main().catch((err: unknown) => {
  console.error(`\nRecord failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

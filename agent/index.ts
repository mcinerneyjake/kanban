import * as readline from 'node:readline/promises';
import { RuntimeEmbedder, TicketIndex } from './retrieval.js';
import { RuntimeChatClient, resolveLlmConfig } from './llm.js';
import { AGENT_TOOLS } from './tools.js';
import { runIntake, SYSTEM_PROMPT } from './loop.js';
import { getTicket } from '../server/tickets.js';
import { askApproval } from './approval.js';
import { mergeUsage } from './usage.js';
import { resolveCostConfig } from './costConfig.js';
import { buildSummary, renderSummary } from './summary.js';

// CLI entry for the local agentic-intake agent. Reads a report from argv,
// builds the live index + chat client from env, and runs the intake loop with
// a stdin approval gate on every mutating action.
//   npm run agent -- "the dashboard crashes when I export to CSV"
// Requires running embedding + chat models (e.g. LM Studio).

// Load local config if a .env is present; tolerate its absence (config then
// falls back to process env + the localhost defaults in models.ts/llm.ts).
try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }

async function main(): Promise<void> {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('Usage: npm run agent -- "<report>"');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let reviewMs = 0; // measured HITL gate-open time, fed to the run summary
  const approve = async (name: string, args: Record<string, unknown> | undefined): Promise<boolean> => {
    console.log(`\n⚠  The agent wants to ${name}:`);
    console.log(JSON.stringify(args ?? {}, null, 2));
    // For an update, show the ticket's CURRENT state so the reviewer isn't blind.
    if (name === 'update_ticket' && args && typeof args.id === 'string') {
      try {
        const current = await getTicket(args.id);
        console.log(`Current: "${current.title}" — ${current.status}/${current.priority}`);
        // A body replacement is destructive and unrecoverable (tickets/ is
        // gitignored — no undo). Show the current body so the reviewer isn't
        // approving a blind full-body overwrite; the proposed body is in the
        // args JSON printed above.
        if (typeof args.body === 'string' && args.body !== current.body) {
          console.log('Current body (will be REPLACED by the proposed `body` above):');
          console.log(current.body || '(empty)');
        }
      } catch {
        console.log('(could not load the current ticket state)');
      }
    }
    // Fail-safe: a closed stdin (EOF / non-interactive) declines rather than crashing.
    const start = Date.now();
    const ok = await askApproval(() => rl.question('Approve? [y/N] '));
    reviewMs += Date.now() - start;
    return ok;
  };

  const embedder = RuntimeEmbedder.fromEnv();
  const chat = RuntimeChatClient.fromEnv();
  try {
    console.log('Building the board index…');
    const index = await TicketIndex.build(embedder);
    console.log(`Indexed ${index.size} tickets. Running intake…`);
    const result = await runIntake(input, { chat, index, approve });
    console.log(`\n--- Result (${result.steps} steps) ---\n${result.final}`);

    // Per-run cost & economics summary (assembled from the run's measured usage
    // + the configured assumptions). Reads usage from both runtime clients.
    const usage = mergeUsage(chat.getUsage(), embedder.getUsage());
    const summary = buildSummary({
      usage,
      outcome: result.outcome,
      reviewMs,
      cfg: resolveCostConfig(),
      model: resolveLlmConfig().model,
      prefixText: SYSTEM_PROMPT + JSON.stringify(AGENT_TOOLS),
      dynamicText: input,
    });
    console.log(`\n${renderSummary(summary)}`);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nAgent failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

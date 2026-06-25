import * as readline from 'node:readline/promises';
import { RuntimeEmbedder, TicketIndex } from './retrieval.js';
import { RuntimeChatClient } from './llm.js';
import { runIntake } from './loop.js';
import { getTicket } from '../server/tickets.js';
import { askApproval } from './approval.js';

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
  const approve = async (name: string, args: Record<string, unknown> | undefined): Promise<boolean> => {
    console.log(`\n⚠  The agent wants to ${name}:`);
    console.log(JSON.stringify(args ?? {}, null, 2));
    // For an update, show the ticket's CURRENT state so the reviewer isn't blind.
    if (name === 'update_ticket' && args && typeof args.id === 'string') {
      try {
        const current = await getTicket(args.id);
        console.log(`Current: "${current.title}" — ${current.status}/${current.priority}`);
      } catch {
        console.log('(could not load the current ticket state)');
      }
    }
    // Fail-safe: a closed stdin (EOF / non-interactive) declines rather than crashing.
    return askApproval(() => rl.question('Approve? [y/N] '));
  };

  try {
    console.log('Building the board index…');
    const index = await TicketIndex.build(RuntimeEmbedder.fromEnv());
    console.log(`Indexed ${index.size} tickets. Running intake…`);
    const result = await runIntake(input, { chat: RuntimeChatClient.fromEnv(), index, approve });
    console.log(`\n--- Result (${result.steps} steps) ---\n${result.final}`);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nAgent failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

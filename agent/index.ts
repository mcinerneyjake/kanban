import * as readline from 'node:readline/promises';
import { RuntimeEmbedder, TicketIndex } from './retrieval.js';
import { RuntimeChatClient } from './llm.js';
import { runIntake } from './loop.js';

// CLI entry for the local agentic-intake agent. Reads a report from argv,
// builds the live index + chat client from env, and runs the intake loop with
// a stdin approval gate on every mutating action.
//   npm run agent -- "the dashboard crashes when I export to CSV"
// Requires running embedding + chat models (e.g. LM Studio) and ids in .env.

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
    const answer = (await rl.question('Approve? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
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

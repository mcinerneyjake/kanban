import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Populate the board with demo tickets. `tickets/` is gitignored, so a fresh
// clone boots empty; this copies the tracked `seed/*.md` fixtures into it — but
// ONLY when the board is empty, so it never clobbers a real board.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

export function seedBoard({ seedDir, ticketsDir } = {}) {
  seedDir = seedDir ?? path.join(ROOT, 'seed');
  ticketsDir = ticketsDir ?? process.env.TICKETS_DIR_OVERRIDE ?? path.join(ROOT, 'tickets');

  const existing = fs.existsSync(ticketsDir)
    ? fs.readdirSync(ticketsDir).filter((f) => f.endsWith('.md'))
    : [];
  if (existing.length > 0) {
    return { copied: 0, skipped: true, reason: `tickets/ already has ${existing.length} ticket(s)` };
  }

  fs.mkdirSync(ticketsDir, { recursive: true });
  const seeds = fs.readdirSync(seedDir).filter((f) => f.endsWith('.md'));
  for (const file of seeds) {
    fs.copyFileSync(path.join(seedDir, file), path.join(ticketsDir, file));
  }
  return { copied: seeds.length, skipped: false };
}

// CLI runner — only when invoked directly (`node scripts/seed.mjs`).
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = seedBoard();
  if (result.skipped) {
    console.log(`[seed] Skipped — ${result.reason}. Delete tickets/*.md first to reseed.`);
  } else {
    console.log(`[seed] Seeded ${result.copied} demo ticket(s) into tickets/. Now run \`npm run dev\`.`);
  }
}

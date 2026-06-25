import { RuntimeEmbedder, TicketIndex } from './retrieval.js';
import { resolveEmbedConfig } from './models.js';

// Standalone "semantic board search" demo — the Phase 1 deliverable made
// runnable. Builds the in-memory index from the live board via the configured
// embedder and prints the top matches for a query.
//   npm run agent:search -- "compressor overheating"
// Requires a running embeddings runtime (e.g. LM Studio) and real ids in .env.

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npm run agent:search -- "<query>"');
    process.exit(1);
  }

  const cfg = resolveEmbedConfig();
  console.log(`Embedder: ${cfg.model} @ ${cfg.baseUrl}`);
  console.log('Building index from the board…');

  const index = await TicketIndex.build(RuntimeEmbedder.fromEnv());
  console.log(`Indexed ${index.size} tickets.\n`);

  const results = await index.search(query, 8);
  console.log(`Top matches for "${query}":\n`);
  for (const r of results) {
    console.log(`  ${r.score.toFixed(3)}  [${r.id}] ${r.title}`);
  }
}

main().catch((err: unknown) => {
  const base = process.env.EMBED_BASE_URL ?? 'http://localhost:1234/v1';
  console.error(`\nSearch failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Is the embeddings runtime up? Check:  curl ${base}/models`);
  process.exit(1);
});

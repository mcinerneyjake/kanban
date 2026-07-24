import { RuntimeEmbedder } from './retrieval/retrieval.js';
import { buildCliIndex } from './retrieval/indexCache.js';
import { resolveEmbedConfig } from './retrieval/models.js';

// Load local config if a .env is present; tolerate its absence.
try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }

// Standalone semantic board-search demo: builds the index from the live board and prints the top matches for a query. Requires a running embeddings runtime (e.g. LM Studio).
//   npm run agent:search -- "compressor overheating"

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npm run agent:search -- "<query>"');
    process.exit(1);
  }

  const cfg = resolveEmbedConfig();
  console.log(`Embedder: ${cfg.model} @ ${cfg.baseUrl}`);
  console.log('Building index from the board…');

  const index = await buildCliIndex(RuntimeEmbedder.fromEnv());
  console.log(`Indexed ${index.size} tickets.\n`);

  const results = await index.search(query, 8);
  console.log(`Top matches for "${query}":\n`);
  for (const r of results) {
    console.log(`  ${r.score.toFixed(3)}  [${r.id}] (${r.meta?.status ?? '—'}) ${r.title}`);
  }
}

main().catch((err: unknown) => {
  const base = process.env.EMBED_BASE_URL ?? 'http://localhost:1234/v1';
  console.error(`\nSearch failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`Is the embeddings runtime up? Check:  curl ${base}/models`);
  process.exit(1);
});

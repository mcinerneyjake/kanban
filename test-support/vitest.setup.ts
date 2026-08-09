import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pins the persistent embedding cache to a throwaway dir for the whole suite.
// tkt-9f09b3a1e95c made that cache default-ON (it was opt-in via EMBED_CACHE_PATH),
// so any suite building an index would otherwise resolve defaultCachePath() to the
// REAL board cache and prune() it down to its own stub corpus — silently destroying
// a developer's warm cache and forcing a ~13-batch cold re-embed. mkdtemp per worker
// so parallel suites can't collide on one file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-embed-cache-'));
process.env.EMBED_CACHE_PATH = path.join(dir, 'embeddings.json');

// Runtime config for the agent's models, resolved from env. See
// kanban-planning-docs/AGENT-FLOW.md. Phase 1 (retrieval) needs only the
// embedding config; the LLM chat config + RAM-tier ladder land with the
// tool-use loop in Phase 3.

export interface EmbedConfig {
  /** OpenAI-compatible base URL, e.g. http://localhost:1234/v1 */
  baseUrl: string;
  /** Model id as the runtime advertises it. */
  model: string;
  /** Prefix applied to a query before embedding (may be empty). */
  queryInstruction: string;
  /** Prefix applied to each document before embedding (may be empty). */
  docInstruction: string;
}

// Some embedding models require task-instruction prefixes — omitting them costs
// 5–10 MTEB points. Qwen3-Embedding prefixes the QUERY only; nomic prefixes
// BOTH sides. Matched on a substring so it's robust to runtime-specific ids
// (LM Studio vs Ollama advertise different strings).
function instructionsFor(model: string): { query: string; doc: string } {
  const m = model.toLowerCase();
  if (m.includes('nomic')) {
    return { query: 'search_query: ', doc: 'search_document: ' };
  }
  if (m.includes('qwen3-embedding') || m.includes('qwen3embedding')) {
    return { query: 'Instruct: Retrieve kanban tickets relevant to the query.\nQuery: ', doc: '' };
  }
  return { query: '', doc: '' };
}

export function resolveEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  const baseUrl = (env.EMBED_BASE_URL ?? 'http://localhost:1234/v1').replace(/\/+$/, '');
  const model = env.EMBED_MODEL ?? 'qwen3-embedding:0.6b';
  const { query, doc } = instructionsFor(model);
  return { baseUrl, model, queryInstruction: query, docInstruction: doc };
}

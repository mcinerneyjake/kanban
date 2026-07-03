import { resolvePrefixes } from './embedPrefixes.js';

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

export function resolveEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  const baseUrl = (env.EMBED_BASE_URL ?? 'http://localhost:1234/v1').replace(/\/+$/, '');
  const model = env.EMBED_MODEL ?? 'qwen3-embedding:0.6b';
  // Prefix policy lives in embedPrefixes.ts: env override -> supported set -> none.
  const { query, doc } = resolvePrefixes(model, env);
  return { baseUrl, model, queryInstruction: query, docInstruction: doc };
}

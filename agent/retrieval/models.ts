import { resolvePrefixes } from './embedPrefixes.js';

// Embedding config for the agent's models, resolved from env.

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
  // Ollama-style `qwen3-embedding:0.6b` is NOT served by the LM Studio runtime this targets, and an
  // unserved id is answered 200 with a silently substituted model (tkt-01b784eb0030) — so the old
  // default produced 768-d nomic vectors while every caller believed it had 1024-d qwen3. This
  // default is only safe because RuntimeEmbedder verifies it against the runtime's served list
  // before embedding; it is a convenience, never the thing keeping a run honest.
  const model = env.EMBED_MODEL ?? 'text-embedding-qwen3-embedding-0.6b';
  // Prefix policy lives in embedPrefixes.ts: env override -> supported set -> none.
  const { query, doc } = resolvePrefixes(model, env);
  return { baseUrl, model, queryInstruction: query, docInstruction: doc };
}

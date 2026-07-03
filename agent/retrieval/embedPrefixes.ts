// Task-instruction prefixes for embedding models. There is NO universal
// standard — most models need nothing, some prefix the query (Qwen3-Embedding)
// or both sides (nomic, E5), and appending an unexpected prefix can HURT
// retrieval. So resolution is: explicit env override → our small supported set
// → no prefix.

export interface PrefixProfile {
  query: string;
  doc: string;
}

const NONE: PrefixProfile = { query: '', doc: '' };

// Embedders WE ship + test that need prefixes. Keep this SMALL — it's our
// supported set, not a catalog of every model in existence. Any other model is
// handled by the EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX override, so this list
// only grows when we adopt a new default embedder. Matched by substring because
// runtimes advertise model ids differently (e.g. `qwen3-embedding:0.6b` vs
// `text-embedding-qwen3-embedding-0.6b`).
const PREFIXED_EMBEDDERS: readonly { idIncludes: string; query: string; doc: string }[] = [
  {
    idIncludes: 'qwen3-embedding',
    query: 'Instruct: Retrieve kanban tickets relevant to the query.\nQuery: ',
    doc: '',
  },
  { idIncludes: 'nomic', query: 'search_query: ', doc: 'search_document: ' },
];

// Resolve the prefix profile for a model: override → supported set → none.
export function resolvePrefixes(model: string, env: NodeJS.ProcessEnv = process.env): PrefixProfile {
  if (env.EMBED_QUERY_PREFIX !== undefined || env.EMBED_DOC_PREFIX !== undefined) {
    return { query: env.EMBED_QUERY_PREFIX ?? '', doc: env.EMBED_DOC_PREFIX ?? '' };
  }
  const m = model.toLowerCase();
  const hit = PREFIXED_EMBEDDERS.find((e) => m.includes(e.idIncludes));
  return hit ? { query: hit.query, doc: hit.doc } : NONE;
}

// Task-instruction prefixes for embedding models. No universal standard — some models want none, some prefix the query or both sides, and an UNEXPECTED prefix can HURT retrieval. Resolution: env override → supported set → none.

export interface PrefixProfile {
  query: string;
  doc: string;
}

const NONE: PrefixProfile = { query: '', doc: '' };

// Our supported set — keep SMALL; any other model uses the EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX override. Matched by SUBSTRING because runtimes advertise ids differently (`qwen3-embedding:0.6b` vs `text-embedding-qwen3-embedding-0.6b`).
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

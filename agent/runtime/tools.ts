import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleToolCall, type ToolResult } from '../../mcp/handlers.js';
import { type DocumentIndex } from '../retrieval/retrieval.js';
import { type Provenance } from '../../shared/constants.js';

// Tool layer: a safe whitelist of MCP tools (reused verbatim via handleToolCall) + search_board over the retrieval index, adapted to the OpenAI function-tool shape.

// Read + non-destructive writes only. Deliberately EXCLUDES delete_ticket (destructive, reachable from untrusted intake) and start_ticket (dev-workflow). search_board is agent-only — it needs the embedding index.
const AGENT_TOOL_NAMES = new Set<string>([
  'list_tickets', 'get_ticket', 'search_board', 'create_ticket', 'update_ticket',
]);

// The one tool not in mcp/handlers — semantic search over the board.
const SEARCH_BOARD_TOOL: Tool = {
  name: 'search_board',
  description:
    'Semantic search over existing tickets. ALWAYS call this before proposing a new ticket, to find likely duplicates or a related ticket to update instead of creating one.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language description of the issue to search for' },
      limit: { type: 'number', description: 'Max results to return (default 5)' },
    },
    required: ['query'],
  },
};

// Minimal OpenAI chat-completions function-tool shape (avoids the SDK dep).
export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Tool['inputSchema'] };
}

function toChatTool(t: Tool): ChatTool {
  return { type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } };
}

// The agent's advertised tools: whitelisted MCP tools + search_board.
export const AGENT_TOOLS: ChatTool[] = [
  ...TOOLS.filter((t) => AGENT_TOOL_NAMES.has(t.name)),
  SEARCH_BOARD_TOOL,
].map(toChatTool);

// Text-only result matching the MCP ToolResult shape.
function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

async function searchBoard(args: Record<string, unknown> | undefined, index: DocumentIndex): Promise<ToolResult> {
  const query = typeof args?.query === 'string' ? args.query : null;
  if (!query) return textResult('Missing required field: query', true);
  const limit = typeof args?.limit === 'number' ? args.limit : 5;
  const results = await index.search(query, limit);
  // Explicit fields, NOT a `...meta` spread — so a future source's meta `score`/`title` key can't overwrite a core field, and generic fields like `source` don't leak in as prompt noise.
  const flat = results.map((r) => ({ id: r.id, title: r.title, status: r.meta?.status, score: r.score }));
  return textResult(JSON.stringify(flat, null, 2));
}

// Writes stamped with run provenance (source: agent + runId), so an agent-authored ticket traces back to its run's usage/cost.
const PROVENANCE_TOOLS = new Set(['create_ticket', 'update_ticket']);

// One tool call → one ToolResult. Anything outside the whitelist is refused — double-gating so delete_ticket/start_ticket can never reach the service via the agent. `runId` stamps create/update writes with provenance — the agent-only boundary the human MCP client never crosses.
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  index: DocumentIndex,
  runId?: string,
): Promise<ToolResult> {
  if (!AGENT_TOOL_NAMES.has(name)) {
    return textResult(`Tool not available to the agent: ${name}`, true);
  }
  if (name === 'search_board') return searchBoard(args, index);
  const provenance: Provenance | undefined =
    runId && PROVENANCE_TOOLS.has(name) ? { source: 'agent', runId } : undefined;
  return handleToolCall(name, args, provenance);
}

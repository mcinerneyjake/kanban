import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleToolCall, type ToolResult } from '../mcp/handlers.js';
import { type TicketIndex } from './retrieval.js';

// ---------------------------------------------------------------------------
// Tool layer (Phase 2). The agent's tool set = a safe whitelist of the MCP
// tools (reused verbatim via handleToolCall) plus search_board, which wraps the
// Phase 1 retrieval index. Tool defs are adapted to the OpenAI function-tool
// shape; no SDK dependency yet (that lands with the chat loop in Phase 3).
// ---------------------------------------------------------------------------

// Read + non-destructive writes only. Deliberately EXCLUDES delete_ticket
// (destructive, reachable from untrusted intake) and start_ticket (a
// dev-workflow tool). search_board is agent-only — it needs the embedding index.
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

async function searchBoard(args: Record<string, unknown> | undefined, index: TicketIndex): Promise<ToolResult> {
  const query = typeof args?.query === 'string' ? args.query : null;
  if (!query) return textResult('Missing required field: query', true);
  const limit = typeof args?.limit === 'number' ? args.limit : 5;
  const results = await index.search(query, limit);
  return textResult(JSON.stringify(results, null, 2));
}

// One tool call -> one ToolResult. search_board hits the index; whitelisted MCP
// tools reuse handleToolCall verbatim; anything else is refused (double-gating
// so delete_ticket/start_ticket can never reach the service via the agent).
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  index: TicketIndex,
): Promise<ToolResult> {
  if (!AGENT_TOOL_NAMES.has(name)) {
    return textResult(`Tool not available to the agent: ${name}`, true);
  }
  if (name === 'search_board') return searchBoard(args, index);
  return handleToolCall(name, args);
}

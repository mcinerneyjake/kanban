// Shim: the MCP tool definitions + dispatch now live in the `ticket-workflow`
// package (tkt-66f0e22efd5e). Named re-exports — see server/tickets.ts for why
// not `export *`. mcp/server.ts still wires these to the stdio transport locally,
// so the server key and tool names (mcp__kanban__*) are unchanged.
export { TOOLS, handleToolCall } from 'ticket-workflow';
export type { ToolResult } from 'ticket-workflow';

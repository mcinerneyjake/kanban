import { AGENT_TOOLS, dispatchTool } from './tools.js';
import { type ChatClient, type ChatMessage } from './llm.js';
import { type TicketIndex } from './retrieval.js';
import { type ToolResult } from '../mcp/handlers.js';

// ---------------------------------------------------------------------------
// Tool-use loop (Phase 3) + human-in-the-loop approval gate (Phase 4). Drives a
// ChatClient through the agent's tools until it produces a final answer. Every
// MUTATING tool is gated behind an approval callback; read tools run freely.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an intake agent for a kanban board. Given a raw report (a bug, a request, or a note), land it on the board correctly:
1. Extract the concrete issue(s) from the input.
2. For each issue, ALWAYS call search_board FIRST to find existing tickets.
3. If a clear duplicate or closely related ticket exists, prefer update_ticket over creating a new one.
4. Only call create_ticket when nothing on the board already covers the issue.
When finished, reply with a short plain-text summary of what you created or updated, and why.`;

// Tools that write to the board — gated behind human approval in the loop.
const MUTATING_TOOLS = new Set(['create_ticket', 'update_ticket']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Tool-call arguments arrive as a JSON string; tolerate malformed/empty values
// by passing undefined through to the tool (which reports its own error).
function parseArgs(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function declined(name: string): ToolResult {
  return {
    content: [{ type: 'text', text: `The human reviewer declined ${name}. Do not retry it; summarize what was and was not done.` }],
    isError: true,
  };
}

// A human approval gate for a proposed mutating action. Return false to skip it.
export type ApproveFn = (name: string, args: Record<string, unknown> | undefined) => boolean | Promise<boolean>;

export interface IntakeResult {
  final: string;
  messages: ChatMessage[];
  steps: number;
}

export interface IntakeDeps {
  chat: ChatClient;
  index: TicketIndex;
  maxSteps?: number;
  // Gate for mutating tools. Omit to auto-approve (programmatic use); the CLI
  // always supplies a prompting gate.
  approve?: ApproveFn;
}

// Run one tool call, gating any mutating tool behind the approval callback.
async function runCall(name: string, args: Record<string, unknown> | undefined, deps: IntakeDeps): Promise<ToolResult> {
  if (MUTATING_TOOLS.has(name) && deps.approve && !(await deps.approve(name, args))) {
    return declined(name);
  }
  return dispatchTool(name, args, deps.index);
}

// Run one intake conversation to completion (or until the step budget is spent).
export async function runIntake(input: string, deps: IntakeDeps): Promise<IntakeResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];
  const maxSteps = deps.maxSteps ?? 8;

  for (let step = 1; step <= maxSteps; step++) {
    const assistant = await deps.chat.complete(messages, AGENT_TOOLS);
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return { final: assistant.content ?? '', messages, steps: step };
    }

    for (const call of calls) {
      const result = await runCall(call.function.name, parseArgs(call.function.arguments), deps);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content.map((c) => c.text).join('\n'),
      });
    }
  }

  throw new Error(`Agent did not finish within ${maxSteps} steps`);
}

import { AGENT_TOOLS, dispatchTool } from './tools.js';
import { type ChatClient, type ChatMessage } from './llm.js';
import { type TicketIndex } from './retrieval.js';

// ---------------------------------------------------------------------------
// Tool-use loop (Phase 3). Drives a ChatClient through the agent's tools until
// it produces a final answer. No CLI and no human-in-the-loop gate yet — those
// land in Phase 4; here the loop runs the tools directly.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an intake agent for a kanban board. Given a raw report (a bug, a request, or a note), land it on the board correctly:
1. Extract the concrete issue(s) from the input.
2. For each issue, ALWAYS call search_board FIRST to find existing tickets.
3. If a clear duplicate or closely related ticket exists, prefer update_ticket over creating a new one.
4. Only call create_ticket when nothing on the board already covers the issue.
When finished, reply with a short plain-text summary of what you created or updated, and why.`;

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

export interface IntakeResult {
  final: string;
  messages: ChatMessage[];
  steps: number;
}

export interface IntakeDeps {
  chat: ChatClient;
  index: TicketIndex;
  maxSteps?: number;
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
      const result = await dispatchTool(call.function.name, parseArgs(call.function.arguments), deps.index);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content.map((c) => c.text).join('\n'),
      });
    }
  }

  throw new Error(`Agent did not finish within ${maxSteps} steps`);
}

import { AGENT_TOOLS, dispatchTool } from './tools.js';
import { type ChatClient, type ChatMessage } from './llm.js';
import { type TicketIndex } from './retrieval.js';
import { type ToolResult } from '../mcp/handlers.js';
import { type RunOutcome } from './economics.js';

// ---------------------------------------------------------------------------
// Tool-use loop (Phase 3) + human-in-the-loop approval gate (Phase 4). Drives a
// ChatClient through the agent's tools until it produces a final answer.
//
// The gate is fail-safe WHEN an `approve` fn is supplied: only read-only tools
// run freely; everything else (writes, and any tool added later) is routed
// through `approve`, so a newly added tool defaults to requiring approval rather
// than slipping through. Omitting `approve` is an explicit opt-out — auto-approve
// for programmatic callers that drive the loop themselves (see IntakeDeps.approve).
// The CLI always supplies a prompting gate.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are an intake agent for a kanban board. Given a raw report (a bug, a request, or a note), land it on the board correctly:
1. Extract the concrete issue(s) from the input.
2. For each issue, ALWAYS call search_board FIRST to find existing tickets.
3. If a clear, OPEN duplicate or closely related ticket exists, prefer update_ticket over creating a new one. Each search result includes a "status" — IGNORE archived or done tickets as update targets (they are closed); create a new ticket instead, and you may reference the related closed one.
4. Only call create_ticket when nothing OPEN on the board already covers the issue.
When finished, you MUST reply with a 1-3 sentence plain-text summary that names each ticket you created or updated (its id and title), or states that no action was taken and why. Never reply with an empty message.`;

// Read-only tools run without approval. Everything else is gated — so a tool
// added later defaults to requiring approval rather than slipping through
// unguarded (fail-safe, not fail-open).
const READ_ONLY_TOOLS = new Set(['search_board', 'list_tickets', 'get_ticket']);

// Shown if the model ever returns an empty final answer — the CLI should never
// print a blank result.
const EMPTY_SUMMARY_FALLBACK = 'The agent finished but did not return a summary.';

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

// The loop forwards only a result's text to the model, so this message must be
// self-describing: it tells the model the action was declined and not to retry.
function declined(name: string): ToolResult {
  return {
    content: [{ type: 'text', text: `The human reviewer declined ${name}. Do not retry it; summarize what was and was not done.` }],
  };
}

// A human approval gate for a proposed mutating action. Return false to skip it.
export type ApproveFn = (name: string, args: Record<string, unknown> | undefined) => boolean | Promise<boolean>;

export interface IntakeResult {
  final: string;
  messages: ChatMessage[];
  steps: number;
  outcome: RunOutcome;
}

export interface IntakeDeps {
  chat: ChatClient;
  index: TicketIndex;
  maxSteps?: number;
  // Gate for non-read-only tools. Omit to auto-approve (programmatic use); the
  // CLI always supplies a prompting gate.
  approve?: ApproveFn;
}

// create/update are the "accepted" mutations counted toward the run outcome —
// and the only tools a propose-mode capture should treat as a proposal.
export function mutationKind(name: string): 'create' | 'update' | null {
  if (name === 'create_ticket') return 'create';
  if (name === 'update_ticket') return 'update';
  return null;
}

// Run one tool call, gating anything that isn't read-only behind the callback.
// Reports whether the action was declined so the loop can tally the outcome.
async function runCall(name: string, args: Record<string, unknown> | undefined, deps: IntakeDeps): Promise<{ result: ToolResult; declined: boolean }> {
  const needsApproval = !READ_ONLY_TOOLS.has(name);
  if (needsApproval && deps.approve && !(await deps.approve(name, args))) {
    return { result: declined(name), declined: true };
  }
  return { result: await dispatchTool(name, args, deps.index), declined: false };
}

// Run one intake conversation to completion (or until the step budget is spent).
export async function runIntake(input: string, deps: IntakeDeps): Promise<IntakeResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];
  const maxSteps = deps.maxSteps ?? 8;
  let created = 0;
  let updated = 0;
  let declinedCount = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const assistant = await deps.chat.complete(messages, AGENT_TOOLS);
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      const final = (assistant.content ?? '').trim() || EMPTY_SUMMARY_FALLBACK;
      const outcome: RunOutcome = {
        created, updated, declined: declinedCount,
        noProposal: created + updated + declinedCount === 0,
        errored: false,
      };
      return { final, messages, steps: step, outcome };
    }

    for (const call of calls) {
      const { result, declined: wasDeclined } = await runCall(call.function.name, parseArgs(call.function.arguments), deps);
      const kind = mutationKind(call.function.name);
      // Count a mutation as accepted ONLY when it was neither declined nor
      // errored — a failed create/update (e.g. missing title → 400 → isError)
      // produced no ticket, so it must not be credited as created/updated (which
      // would make economics.ts claim manual value for work never done).
      if (kind && wasDeclined) declinedCount += 1;
      else if (kind && !result.isError) {
        if (kind === 'create') created += 1;
        else updated += 1;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result.content.map((c) => c.text).join('\n'),
      });
    }
  }

  // Step budget exhausted. Return an errored outcome rather than throwing, so
  // the usage/tally of mutations that DID execute before the budget ran out is
  // preserved (a throw would discard it and never set RunOutcome.errored).
  const outcome: RunOutcome = {
    created, updated, declined: declinedCount,
    noProposal: created + updated + declinedCount === 0,
    errored: true,
  };
  const final = `The agent did not finish within ${maxSteps} steps; stopping. ` +
    `${created + updated} mutation(s) were applied before the step budget ran out.`;
  return { final, messages, steps: maxSteps, outcome };
}

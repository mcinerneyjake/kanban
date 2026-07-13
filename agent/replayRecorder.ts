// Records a REAL agent run into a replay Trace (shared/replayTrace.ts) by wrapping
// the three dependency seams runIntake already accepts — chat, index, approve —
// so nothing in loop.ts / tools.ts / llm.ts changes. Each wrapper appends a typed
// step to one shared, ordered sink (call order = true run order); buildTrace then
// brackets that sink with the opening `note` and the closing `final`.

import type { ChatClient, ChatMessage } from './runtime/llm.js';
import type { ChatTool } from './runtime/tools.js';
import type { ApproveFn } from './runtime/loop.js';
import { DocumentIndex, type ScoredDocument } from './retrieval/retrieval.js';
import type { RunUsage } from './cost/usage.js';
import type { RunOutcome } from './cost/economics.js';
import type {
  Trace, TraceStep, RetrievalHit, TraceUsage, TraceOutcome,
  NoteStep, FinalStep, LlmCallStep, RetrievalStep, ApprovalStep,
} from '../shared/replayTrace.js';

// The chat wrapper needs per-call tokens, which the ChatClient interface doesn't
// expose — only the RuntimeChatClient's accumulating meter does. We read it by
// diffing getUsage() across the call, so any metered client works (real or fake).
export interface MeteredChatClient extends ChatClient {
  getUsage(): RunUsage;
}

type StepSink = (step: TraceStep) => void;

function parseArgs(json: string): unknown {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch {
    return json; // a runtime that emits non-JSON tool args — keep the raw string
  }
}

function toHit(d: ScoredDocument): RetrievalHit {
  const hit: RetrievalHit = { id: d.id, title: d.title, score: d.score, source: d.source };
  if (d.meta && typeof d.meta.status === 'string') hit.status = d.meta.status;
  if (d.chunk) hit.chunk = { index: d.chunk.index, text: d.chunk.text };
  return hit;
}

function toTraceUsage(u: RunUsage): TraceUsage {
  return {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    totalTokens: u.totalTokens,
    calls: u.calls,
    reportedCalls: u.reportedCalls,
    activeMs: u.activeMs,
  };
}

function toTraceOutcome(o: RunOutcome): TraceOutcome {
  return { created: o.created, updated: o.updated, declined: o.declined };
}

// Wraps a metered chat client, emitting one `llm_call` step per turn with the
// per-call active-compute time and tokens (via a getUsage() diff — undefined when
// the runtime reported no usage block, matching the meter's reportedCalls rule).
export class RecordingChatClient implements ChatClient {
  constructor(private readonly inner: MeteredChatClient, private readonly onStep: StepSink) {}

  async complete(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
    const before = this.inner.getUsage();
    const reply = await this.inner.complete(messages, tools);
    const after = this.inner.getUsage();

    const reported = after.reportedCalls - before.reportedCalls;
    const step: LlmCallStep = {
      type: 'llm_call',
      content: reply.content,
      toolCalls: (reply.tool_calls ?? []).map((tc) => ({ name: tc.function.name, args: parseArgs(tc.function.arguments) })),
      ms: after.activeMs - before.activeMs,
    };
    if (reported > 0) {
      step.tokens = {
        prompt: after.promptTokens - before.promptTokens,
        completion: after.completionTokens - before.completionTokens,
        total: after.totalTokens - before.totalTokens,
      };
    }
    this.onStep(step);
    return reply;
  }
}

// Instruments a DocumentIndex in place so every search emits a `retrieval` step
// with the full ScoredDocument hits (scores/meta/chunk) BEFORE the tool layer
// projects them down to id/title/status/score. Mutates the index the recorder
// owns — never a shared one.
export function instrumentIndexSearch(index: DocumentIndex, onStep: StepSink, now: () => number): void {
  const original = index.search.bind(index);
  index.search = async (query: string, k = 5, opts: { rollup?: boolean } = {}): Promise<ScoredDocument[]> => {
    const t0 = now();
    const hits = await original(query, k, opts);
    const step: RetrievalStep = { type: 'retrieval', query, limit: k, ms: now() - t0, hits: hits.map(toHit) };
    onStep(step);
    return hits;
  };
}

// Wraps an approval decision, emitting one `approval` step per gated (mutating)
// tool with the proposed action/args, the decision, and the gate-open time.
export function recordingApprove(decide: ApproveFn, onStep: StepSink, now: () => number): ApproveFn {
  return async (name, args) => {
    const t0 = now();
    const ok = await decide(name, args);
    const step: ApprovalStep = {
      type: 'approval',
      action: name,
      args: args ?? {},
      decision: ok ? 'approved' : 'declined',
      reviewMs: now() - t0,
    };
    onStep(step);
    return ok;
  };
}

export interface FinalizeInput {
  input: string;
  runId: string;
  model: string;
  at: string;              // ISO — the recorder stamps this
  final: string;
  createdIds: string[];
  updatedIds: string[];
  outcome: RunOutcome;
  usage: RunUsage;
}

// Brackets the collected mid-run steps with the opening note + closing final and
// assembles the meta. Pure — unit-tested independently of a live run.
export function buildTrace(steps: TraceStep[], input: FinalizeInput): Trace {
  const note: NoteStep = { type: 'note', text: input.input };
  const final: FinalStep = {
    type: 'final', text: input.final, createdIds: input.createdIds, updatedIds: input.updatedIds,
  };
  return {
    meta: {
      runId: input.runId,
      at: input.at,
      model: input.model,
      kind: 'intake',
      input: input.input,
      outcome: toTraceOutcome(input.outcome),
      totals: toTraceUsage(input.usage),
    },
    steps: [note, ...steps, final],
  };
}

// Owns the ordered step sink and hands out the three wrapped deps. The recorder
// builds its deps, wraps them here, runs the intake, then calls build().
export class ReplayRecorder {
  readonly steps: TraceStep[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}

  private readonly push: StepSink = (step) => { this.steps.push(step); };

  chat(inner: MeteredChatClient): ChatClient {
    return new RecordingChatClient(inner, this.push);
  }

  instrument(index: DocumentIndex): void {
    instrumentIndexSearch(index, this.push, this.now);
  }

  approve(decide: ApproveFn): ApproveFn {
    return recordingApprove(decide, this.push, this.now);
  }

  build(input: FinalizeInput): Trace {
    return buildTrace(this.steps, input);
  }
}

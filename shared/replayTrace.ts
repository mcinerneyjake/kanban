// Serialization contract for a recorded agent run — a generic envelope with
// typed steps, produced by the recorder (agent/recordRun.ts) and consumed by the
// replay viewer. Deliberately self-contained (no agent/ imports) so it stays a
// leaf module shared by both sides; the recorder maps its internal types
// (ScoredDocument, RunUsage, CallTokens) INTO these wire shapes.
//
// The envelope is generic on purpose: a second consumer (the ask-your-data SQL
// demo) reuses this viewer with different step types. Known step types are
// validated strictly; an unknown `type` is accepted as a GenericStep and the
// viewer renders it as key/value — the schema is not welded shut.

export interface RetrievalHit {
  id: string;
  title: string;
  score: number;
  status?: string;
  source?: string;
  chunk?: { index: number; text: string };
}

export interface CallTokens {
  prompt: number;
  completion: number;
  total: number;
  cached?: number;
}

// A subset of the agent's RunUsage, flattened for the trace. Token fields are
// meaningful only when reportedCalls > 0 (a local runtime may omit usage).
export interface TraceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  reportedCalls: number;
  activeMs: number;
}

export interface TraceOutcome {
  created: number;
  updated: number;
  declined: number;
}

export interface RunMeta {
  runId: string;
  at: string;              // ISO timestamp, recorder-stamped
  model: string;           // the LLM_MODEL the run ran against
  kind: string;            // 'intake' today; e.g. 'ask-your-data' later — kept open
  input: string;           // the user note / question that started the run
  outcome?: TraceOutcome;
  totals?: TraceUsage;
}

export type ApprovalDecision = 'approved' | 'declined';
export interface ToolCallRef { name: string; args: unknown }

export interface NoteStep { type: 'note'; text: string }
export interface RetrievalStep {
  type: 'retrieval';
  query: string;
  limit: number;
  ms: number;
  hits: RetrievalHit[];
}
export interface LlmCallStep {
  type: 'llm_call';
  content: string | null;
  toolCalls: ToolCallRef[];
  ms: number;
  tokens?: CallTokens;
}
export interface ApprovalStep {
  type: 'approval';
  action: string;
  args: Record<string, unknown>;
  decision: ApprovalDecision;
  reviewMs: number;
}
export interface FinalStep {
  type: 'final';
  text: string;
  createdIds: string[];
  updatedIds: string[];
}
// The escape hatch: any step type the viewer doesn't know, rendered generically.
export interface GenericStep { type: string; [key: string]: unknown }

export type TraceStep =
  | NoteStep
  | RetrievalStep
  | LlmCallStep
  | ApprovalStep
  | FinalStep
  | GenericStep;

export interface Trace {
  meta: RunMeta;
  steps: TraceStep[];
}

// --- validation (type predicates, no casts) --------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isRetrievalHit(v: unknown): v is RetrievalHit {
  if (!isObject(v)) return false;
  if (typeof v.id !== 'string' || typeof v.title !== 'string' || typeof v.score !== 'number') return false;
  if ('status' in v && v.status !== undefined && typeof v.status !== 'string') return false;
  if ('source' in v && v.source !== undefined && typeof v.source !== 'string') return false;
  if ('chunk' in v && v.chunk !== undefined) {
    const c = v.chunk;
    if (!isObject(c) || typeof c.index !== 'number' || typeof c.text !== 'string') return false;
  }
  return true;
}

function isCallTokens(v: unknown): v is CallTokens {
  if (!isObject(v)) return false;
  if (typeof v.prompt !== 'number' || typeof v.completion !== 'number' || typeof v.total !== 'number') return false;
  if ('cached' in v && v.cached !== undefined && typeof v.cached !== 'number') return false;
  return true;
}

function isToolCallRef(v: unknown): v is ToolCallRef {
  return isObject(v) && typeof v.name === 'string' && 'args' in v;
}

function isTraceUsage(v: unknown): v is TraceUsage {
  return isObject(v)
    && typeof v.promptTokens === 'number'
    && typeof v.completionTokens === 'number'
    && typeof v.totalTokens === 'number'
    && typeof v.calls === 'number'
    && typeof v.reportedCalls === 'number'
    && typeof v.activeMs === 'number';
}

function isTraceOutcome(v: unknown): v is TraceOutcome {
  return isObject(v)
    && typeof v.created === 'number'
    && typeof v.updated === 'number'
    && typeof v.declined === 'number';
}

function isRunMeta(v: unknown): v is RunMeta {
  if (!isObject(v)) return false;
  if (typeof v.runId !== 'string' || typeof v.at !== 'string') return false;
  if (typeof v.model !== 'string' || typeof v.kind !== 'string' || typeof v.input !== 'string') return false;
  if ('outcome' in v && v.outcome !== undefined && !isTraceOutcome(v.outcome)) return false;
  if ('totals' in v && v.totals !== undefined && !isTraceUsage(v.totals)) return false;
  return true;
}

// Per-type predicates. The GenericStep member makes the union's discriminant
// narrowing lossy (a `switch (step.type)` also matches GenericStep), so the
// viewer narrows with THESE instead — each returns a precise `s is KnownStep`.
export function isNoteStep(v: unknown): v is NoteStep {
  return isObject(v) && v.type === 'note' && typeof v.text === 'string';
}
export function isRetrievalStep(v: unknown): v is RetrievalStep {
  return isObject(v) && v.type === 'retrieval'
    && typeof v.query === 'string' && typeof v.limit === 'number' && typeof v.ms === 'number'
    && Array.isArray(v.hits) && v.hits.every(isRetrievalHit);
}
export function isLlmCallStep(v: unknown): v is LlmCallStep {
  return isObject(v) && v.type === 'llm_call'
    && (v.content === null || typeof v.content === 'string')
    && typeof v.ms === 'number'
    && Array.isArray(v.toolCalls) && v.toolCalls.every(isToolCallRef)
    && (!('tokens' in v) || v.tokens === undefined || isCallTokens(v.tokens));
}
export function isApprovalStep(v: unknown): v is ApprovalStep {
  return isObject(v) && v.type === 'approval'
    && typeof v.action === 'string' && isObject(v.args)
    && (v.decision === 'approved' || v.decision === 'declined')
    && typeof v.reviewMs === 'number';
}
export function isFinalStep(v: unknown): v is FinalStep {
  return isObject(v) && v.type === 'final'
    && typeof v.text === 'string' && isStringArray(v.createdIds) && isStringArray(v.updatedIds);
}

// A single step. KNOWN types are validated field-by-field; an UNKNOWN `type`
// string is accepted as a GenericStep (the viewer renders it as key/value) — the
// generic-envelope contract. A non-object or a missing/non-string `type` is
// always rejected.
export function isTraceStep(v: unknown): v is TraceStep {
  if (!isObject(v) || typeof v.type !== 'string') return false;
  switch (v.type) {
    case 'note': return isNoteStep(v);
    case 'retrieval': return isRetrievalStep(v);
    case 'llm_call': return isLlmCallStep(v);
    case 'approval': return isApprovalStep(v);
    case 'final': return isFinalStep(v);
    default: return true; // unknown type → generic fallback
  }
}

export function isTrace(v: unknown): v is Trace {
  return isObject(v)
    && isRunMeta(v.meta)
    && Array.isArray(v.steps) && v.steps.every(isTraceStep);
}

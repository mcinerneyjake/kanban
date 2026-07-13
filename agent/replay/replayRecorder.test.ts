import { describe, it, expect } from 'vitest';
import {
  RecordingChatClient, instrumentIndexSearch, recordingApprove, buildTrace, ReplayRecorder,
  type MeteredChatClient,
} from './replayRecorder.js';
import { DocumentIndex, type Embedder, type Document } from '../retrieval/retrieval.js';
import { emptyUsage, type RunUsage } from '../cost/usage.js';
import type { RunOutcome } from '../cost/economics.js';
import type { ChatMessage } from '../runtime/llm.js';
import type { ChatTool } from '../runtime/tools.js';
import { isTrace, isLlmCallStep, isRetrievalStep, isApprovalStep, type TraceStep } from './replayTrace.js';

// A metered chat fake: returns a canned reply and advances its usage meter by a
// fixed delta per call, so the RecordingChatClient's getUsage() diff is exact.
class FakeChat implements MeteredChatClient {
  private u: RunUsage = emptyUsage();
  constructor(private readonly reply: ChatMessage, private readonly delta: Partial<RunUsage> = {}) {}
  getUsage(): RunUsage { return { ...this.u }; }
  complete(_messages: ChatMessage[], _tools: ChatTool[]): Promise<ChatMessage> {
    this.u = {
      ...this.u,
      calls: this.u.calls + 1,
      reportedCalls: this.u.reportedCalls + (this.delta.reportedCalls ?? 0),
      promptTokens: this.u.promptTokens + (this.delta.promptTokens ?? 0),
      completionTokens: this.u.completionTokens + (this.delta.completionTokens ?? 0),
      totalTokens: this.u.totalTokens + (this.delta.totalTokens ?? 0),
      activeMs: this.u.activeMs + (this.delta.activeMs ?? 0),
    };
    return Promise.resolve(this.reply);
  }
}

class StubEmbedder implements Embedder {
  constructor(private readonly map: [string, number[]][]) {}
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map((t) => this.vec(t))); }
  embedQuery(text: string): Promise<number[]> { return Promise.resolve(this.vec(text)); }
  private vec(text: string): number[] {
    const hit = this.map.find(([k]) => text.toLowerCase().includes(k));
    return hit ? hit[1] : [0, 0, 1];
  }
}
function doc(id: string, title: string): Document {
  return { id, source: 'ticket', title, text: title, meta: { status: 'backlog' } };
}

const outcome: RunOutcome = { created: 1, updated: 0, declined: 0, noProposal: false, errored: false };

describe('RecordingChatClient', () => {
  it('emits an llm_call step with per-call tokens + ms from the usage diff', async () => {
    const reply: ChatMessage = {
      role: 'assistant', content: 'searching',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"login"}' } }],
    };
    const fake = new FakeChat(reply, { reportedCalls: 1, promptTokens: 12, completionTokens: 4, totalTokens: 16, activeMs: 50 });
    const steps: TraceStep[] = [];
    const out = await new RecordingChatClient(fake, (s) => steps.push(s)).complete([{ role: 'user', content: 'login broken' }], []);

    expect(out).toBe(reply);
    const s = steps[0];
    expect(isLlmCallStep(s)).toBe(true);
    if (isLlmCallStep(s)) {
      expect(s.ms).toBe(50);
      expect(s.tokens).toEqual({ prompt: 12, completion: 4, total: 16 });
      expect(s.toolCalls).toEqual([{ name: 'search_board', args: { query: 'login' } }]);
      expect(s.content).toBe('searching');
    }
  });

  it('omits tokens when the runtime reports no usage block', async () => {
    const fake = new FakeChat({ role: 'assistant', content: 'ok' }, { activeMs: 20 });
    const steps: TraceStep[] = [];
    await new RecordingChatClient(fake, (s) => steps.push(s)).complete([], []);
    const s = steps[0];
    expect(isLlmCallStep(s)).toBe(true);
    if (isLlmCallStep(s)) {
      expect(s.tokens).toBeUndefined();
      expect(s.ms).toBe(20);
    }
  });
});

describe('instrumentIndexSearch', () => {
  it('records a retrieval step with full hits and passes the results through', async () => {
    const index = await DocumentIndex.build(new StubEmbedder([['login', [1, 0, 0]]]), [
      doc('t1', 'Fix login bug'), doc('t2', 'Add dashboard'),
    ]);
    const steps: TraceStep[] = [];
    let clock = 0;
    instrumentIndexSearch(index, (s) => steps.push(s), () => (clock += 10));

    const hits = await index.search('login', 3);
    expect(hits.length).toBeGreaterThan(0);           // passthrough intact
    const s = steps[0];
    expect(isRetrievalStep(s)).toBe(true);
    if (isRetrievalStep(s)) {
      expect(s.query).toBe('login');
      expect(s.limit).toBe(3);
      expect(s.ms).toBe(10);
      expect(s.hits[0].id).toBe('t1');
      expect(s.hits[0].status).toBe('backlog');
      expect(typeof s.hits[0].score).toBe('number');
    }
  });
});

describe('recordingApprove', () => {
  it('records the decision + gate time and returns the decision', async () => {
    const steps: TraceStep[] = [];
    let clock = 0;
    const approve = recordingApprove(() => true, (s) => steps.push(s), () => (clock += 10));
    expect(await approve('create_ticket', { title: 'X' })).toBe(true);
    const s = steps[0];
    expect(isApprovalStep(s)).toBe(true);
    if (isApprovalStep(s)) {
      expect(s.action).toBe('create_ticket');
      expect(s.decision).toBe('approved');
      expect(s.args).toEqual({ title: 'X' });
      expect(s.reviewMs).toBe(10);
    }
  });

  it('records a declined gate with empty args when none were passed', async () => {
    const steps: TraceStep[] = [];
    const approve = recordingApprove(() => false, (s) => steps.push(s), () => 0);
    expect(await approve('update_ticket', undefined)).toBe(false);
    const s = steps[0];
    if (isApprovalStep(s)) {
      expect(s.decision).toBe('declined');
      expect(s.args).toEqual({});
    }
  });
});

describe('buildTrace', () => {
  it('brackets the mid-run steps with note + final and maps meta, producing a valid Trace', () => {
    const mid: TraceStep[] = [{ type: 'llm_call', content: 'thinking', toolCalls: [], ms: 5 }];
    const trace = buildTrace(mid, {
      input: 'the export button 500s', runId: 'run-1', model: 'qwen', at: '2026-01-01T00:00:00.000Z',
      final: 'Created a ticket.', createdIds: ['tkt-1'], updatedIds: [], outcome,
      usage: { ...emptyUsage(), promptTokens: 10, completionTokens: 5, totalTokens: 15, calls: 1, reportedCalls: 1, activeMs: 40 },
    });
    expect(isTrace(trace)).toBe(true);
    expect(trace.steps[0]).toEqual({ type: 'note', text: 'the export button 500s' });
    expect(trace.steps[trace.steps.length - 1]).toEqual({ type: 'final', text: 'Created a ticket.', createdIds: ['tkt-1'], updatedIds: [] });
    expect(trace.meta.outcome).toEqual({ created: 1, updated: 0, declined: 0 });
    expect(trace.meta.totals?.totalTokens).toBe(15);
    expect(trace.meta.kind).toBe('intake');
  });
});

describe('ReplayRecorder (composition)', () => {
  it('collects steps in run order and builds a valid trace', async () => {
    const rec = new ReplayRecorder(() => 0);
    await rec.chat(new FakeChat({ role: 'assistant', content: 'done' }, { reportedCalls: 1, totalTokens: 5, activeMs: 10 })).complete([], []);
    await rec.approve(() => true)('create_ticket', { title: 'X' });
    const trace = rec.build({
      input: 'note', runId: 'r', model: 'm', at: '2026-01-01T00:00:00.000Z',
      final: 'ok', createdIds: ['tkt-1'], updatedIds: [], outcome, usage: emptyUsage(),
    });
    expect(isTrace(trace)).toBe(true);
    expect(trace.steps.map((s) => s.type)).toEqual(['note', 'llm_call', 'approval', 'final']);
  });
});

import { type ChatTool } from './tools.js';
import { UsageMeter, type RunUsage, type CallTokens } from '../cost/usage.js';

// ---------------------------------------------------------------------------
// Chat client for the agent loop (Phase 3). Talks to an OpenAI-compatible
// /v1/chat/completions endpoint via fetch — the same no-SDK approach as the
// embedder. The provider seam (local vs Anthropic/cloud) is config-driven; the
// Anthropic driver itself lands with tkt-29788d084c21 as a separate ChatClient.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
// Local models can be slow to first token; give them generous headroom.
const CHAT_TIMEOUT_MS = 120_000;
// A liveness probe should fail fast — far shorter than a generation request.
const PING_TIMEOUT_MS = 5_000;

export interface LlmConfig {
  baseUrl: string;
  model: string;
  /** Optional bearer key — required by cloud endpoints, unused by local ones. */
  apiKey: string | null;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.LLM_MODEL ?? 'qwen/qwen3.5-9b';
  const apiKey = env.LLM_API_KEY ?? null;
  return { baseUrl, model, apiKey };
}

// --- message + tool-call shapes (OpenAI chat-completions) -------------------

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatClient {
  // Send the running conversation + advertised tools; return the assistant reply.
  complete(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage>;
}

// --- response validation (type predicates, no casts) ------------------------

function isToolCall(v: unknown): v is ToolCall {
  if (typeof v !== 'object' || v === null) return false;
  if (!('id' in v) || typeof v.id !== 'string') return false;
  if ('type' in v && v.type !== 'function') return false;
  if (!('function' in v) || typeof v.function !== 'object' || v.function === null) return false;
  const fn = v.function;
  return 'name' in fn && typeof fn.name === 'string'
    && 'arguments' in fn && typeof fn.arguments === 'string';
}

interface AssistantMessage { content: string | null; tool_calls?: ToolCall[] }
function isAssistantMessage(v: unknown): v is AssistantMessage {
  if (typeof v !== 'object' || v === null) return false;
  const content = 'content' in v ? v.content : null;
  if (content !== null && typeof content !== 'string') return false;
  if ('tool_calls' in v && v.tool_calls !== undefined) {
    if (!Array.isArray(v.tool_calls) || !v.tool_calls.every(isToolCall)) return false;
  }
  return true;
}

interface ChatCompletion { choices: { message: AssistantMessage }[] }
function isChatCompletion(v: unknown): v is ChatCompletion {
  if (typeof v !== 'object' || v === null) return false;
  if (!('choices' in v) || !Array.isArray(v.choices) || v.choices.length === 0) return false;
  const first: unknown = v.choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return false;
  return isAssistantMessage(first.message);
}

// Token usage is optional + best-effort: read it from the raw payload only when
// well-formed, so a runtime that omits or malforms it never breaks the response.
function chatUsageOf(v: unknown): CallTokens | undefined {
  if (typeof v !== 'object' || v === null || !('usage' in v)) return undefined;
  const u = v.usage;
  if (typeof u !== 'object' || u === null) return undefined;
  if (!('prompt_tokens' in u) || typeof u.prompt_tokens !== 'number') return undefined;
  if (!('completion_tokens' in u) || typeof u.completion_tokens !== 'number') return undefined;
  if (!('total_tokens' in u) || typeof u.total_tokens !== 'number') return undefined;
  // Optional cached-prompt-token hit count (newer llama.cpp / vLLM); omitted by older runtimes.
  let cached: number | undefined;
  if ('prompt_tokens_details' in u) {
    const d = u.prompt_tokens_details;
    if (typeof d === 'object' && d !== null && 'cached_tokens' in d && typeof d.cached_tokens === 'number') {
      cached = d.cached_tokens;
    }
  }
  return { prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens, cached };
}

export class RuntimeChatClient implements ChatClient {
  private readonly meter = new UsageMeter();

  // `now` is injectable so call durations are deterministic under test.
  constructor(
    private readonly cfg: LlmConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeChatClient {
    return new RuntimeChatClient(resolveLlmConfig(env));
  }

  // Accumulated token usage + active-compute time over this client's lifetime
  // (one client per run). Tokens are "available" only if reportedCalls > 0.
  getUsage(): RunUsage {
    return this.meter.get();
  }

  async complete(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
    const start = this.now();
    const res = await this.fetchCompletion(messages, tools);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Chat request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    const json: unknown = await res.json();
    if (!isChatCompletion(json)) throw new Error('Unexpected /chat/completions response shape');
    // Record the call's duration + token usage (when the runtime reported it).
    this.meter.record(this.now() - start, chatUsageOf(json));
    const msg = json.choices[0].message;
    return { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls };
  }

  // Liveness probe for the runtime — a cheap GET to the OpenAI-compatible
  // /models endpoint. Returns false on any failure (down, timeout, non-200) so
  // callers can branch without a try/catch.
  async available(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
      const res = await fetch(`${this.cfg.baseUrl}/models`, {
        headers, signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetchCompletion(messages: ChatMessage[], tools: ChatTool[]): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
    });
    try {
      return await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`Chat request timed out after ${CHAT_TIMEOUT_MS}ms — is the runtime at ${this.cfg.baseUrl} up?`);
      }
      throw err;
    }
  }
}

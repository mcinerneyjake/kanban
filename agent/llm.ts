import { type ChatTool } from './tools.js';

// ---------------------------------------------------------------------------
// Chat client for the agent loop (Phase 3). Talks to an OpenAI-compatible
// /v1/chat/completions endpoint via fetch — the same no-SDK approach as the
// embedder. The provider seam (local vs Anthropic/cloud) is config-driven; the
// Anthropic driver itself lands with tkt-29788d084c21 as a separate ChatClient.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
// Local models can be slow to first token; give them generous headroom.
const CHAT_TIMEOUT_MS = 120_000;

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

export class RuntimeChatClient implements ChatClient {
  constructor(private readonly cfg: LlmConfig) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeChatClient {
    return new RuntimeChatClient(resolveLlmConfig(env));
  }

  async complete(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
    const res = await this.fetchCompletion(messages, tools);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Chat request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    const json: unknown = await res.json();
    if (!isChatCompletion(json)) throw new Error('Unexpected /chat/completions response shape');
    const msg = json.choices[0].message;
    return { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls };
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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuntimeChatClient, resolveLlmConfig, type LlmConfig } from './llm.js';
import { AGENT_TOOLS } from './tools.js';

const cfg: LlmConfig = {
  baseUrl: 'http://test/v1', model: 'test-model', apiKey: null,
  temperature: 0, topP: null, seed: null, reasoningEffort: null,
};

function stubFetch(impl: (url: string, init: RequestInit) => { status?: number; json?: unknown; text?: string }) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = impl(url, init ?? {});
    const payload = r.text ?? JSON.stringify(r.json ?? {});
    return Promise.resolve(new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } }));
  }));
}

describe('resolveLlmConfig', () => {
  it('defaults base URL + model, no api key, and deterministic sampling (temperature 0, rest omitted)', () => {
    expect(resolveLlmConfig({})).toEqual({
      baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3.5-9b', apiKey: null,
      temperature: 0, topP: null, seed: null, reasoningEffort: null,
    });
  });
  it('strips a trailing slash and reads an api key', () => {
    const c = resolveLlmConfig({ LLM_BASE_URL: 'http://x/v1/', LLM_API_KEY: 'sk-1' });
    expect(c.baseUrl).toBe('http://x/v1');
    expect(c.apiKey).toBe('sk-1');
  });
  it('reads sampling params from env', () => {
    expect(resolveLlmConfig({ LLM_TEMPERATURE: '0.7', LLM_TOP_P: '0.9', LLM_SEED: '42', LLM_REASONING_EFFORT: 'high' }))
      .toMatchObject({ temperature: 0.7, topP: 0.9, seed: 42, reasoningEffort: 'high' });
  });
  it('falls back to a deterministic default on a blank/garbage temperature, and omits bad optional params', () => {
    expect(resolveLlmConfig({ LLM_TEMPERATURE: 'hot' })).toMatchObject({ temperature: 0 });
    expect(resolveLlmConfig({ LLM_TOP_P: 'nope', LLM_SEED: '3.5' })).toMatchObject({ topP: null, seed: null });
  });
});

describe('RuntimeChatClient (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards model + messages + tool schemas and parses the assistant reply', async () => {
    let sent: unknown;
    stubFetch((url, init) => {
      expect(url).toBe('http://test/v1/chat/completions');
      sent = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return { json: { choices: [{ message: { content: 'hello' } }] } };
    });
    const reply = await new RuntimeChatClient(cfg).complete([{ role: 'user', content: 'hi' }], AGENT_TOOLS);
    expect(reply).toMatchObject({ role: 'assistant', content: 'hello' });
    expect(sent).toMatchObject({
      model: 'test-model',
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      tools: expect.any(Array),
    });
  });

  it('parses tool_calls from the response', async () => {
    stubFetch(() => ({ json: { choices: [{ message: { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"x"}' } },
    ] } }] } }));
    const reply = await new RuntimeChatClient(cfg).complete([], AGENT_TOOLS);
    expect(reply.content).toBeNull();
    expect(reply.tool_calls?.[0].function.name).toBe('search_board');
  });

  it('sends a bearer header only when an api key is configured', async () => {
    let auth: string | null = null;
    stubFetch((_url, init) => {
      auth = new Headers(init.headers).get('authorization');
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    await new RuntimeChatClient({ ...cfg, apiKey: 'sk-123' }).complete([], []);
    expect(auth).toBe('Bearer sk-123');
  });

  it('omits the auth header without an api key', async () => {
    let auth: string | null = 'unset';
    stubFetch((_url, init) => {
      auth = new Headers(init.headers).get('authorization');
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    await new RuntimeChatClient(cfg).complete([], []);
    expect(auth).toBeNull();
  });

  it('sends temperature (default 0) and omits unset optional sampling params', async () => {
    let sent: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      sent = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    await new RuntimeChatClient(cfg).complete([{ role: 'user', content: 'hi' }], []);
    expect(sent.temperature).toBe(0);            // always sent
    expect(sent).not.toHaveProperty('top_p');    // null ⇒ omitted
    expect(sent).not.toHaveProperty('seed');
    expect(sent).not.toHaveProperty('reasoning_effort');
  });

  it('forwards top_p / seed / reasoning_effort when configured', async () => {
    let sent: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      sent = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    const tuned = { ...cfg, temperature: 0.5, topP: 0.9, seed: 7, reasoningEffort: 'high' };
    await new RuntimeChatClient(tuned).complete([{ role: 'user', content: 'hi' }], []);
    expect(sent).toMatchObject({ temperature: 0.5, top_p: 0.9, seed: 7, reasoning_effort: 'high' });
  });

  it('omits tools and tool_choice when no tools are given', async () => {
    let sent: unknown;
    stubFetch((_url, init) => {
      sent = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    await new RuntimeChatClient(cfg).complete([{ role: 'user', content: 'hi' }], []);
    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('tool_choice');
  });

  it('forwards the model + base URL resolved by fromEnv', async () => {
    let url = '';
    let sent: unknown;
    stubFetch((u, init) => {
      url = u;
      sent = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
      return { json: { choices: [{ message: { content: 'ok' } }] } };
    });
    await RuntimeChatClient.fromEnv({ LLM_BASE_URL: 'http://env-host/v1', LLM_MODEL: 'env-model' }).complete([], []);
    expect(url).toBe('http://env-host/v1/chat/completions');
    expect(sent).toMatchObject({ model: 'env-model' });
  });

  it('rejects a malformed tool_call (missing arguments)', async () => {
    stubFetch(() => ({ json: { choices: [{ message: { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_board' } },
    ] } }] } }));
    await expect(new RuntimeChatClient(cfg).complete([], AGENT_TOOLS)).rejects.toThrow(/Unexpected/);
  });

  it('surfaces the response body on a non-OK status', async () => {
    stubFetch(() => ({ status: 500, text: 'boom' }));
    await expect(new RuntimeChatClient(cfg).complete([], [])).rejects.toThrow(/500.*boom/);
  });

  it('throws on an unexpected response shape', async () => {
    stubFetch(() => ({ json: { nope: true } }));
    await expect(new RuntimeChatClient(cfg).complete([], [])).rejects.toThrow(/Unexpected/);
  });

  // tkt-dcf9ceff7174: a token-limit truncation (finish_reason: "length") returns partial/empty
  // content with no tool_calls. Untreated, the loop reads "no tool calls" as "the model is done" and
  // returns the truncated text as the run's final answer, logging a truncated run as a success.
  it('throws on a truncated response (finish_reason: length) rather than returning partial content', async () => {
    stubFetch(() => ({ json: { choices: [{ finish_reason: 'length', message: { content: 'the CSV export cra' } }] } }));
    await expect(new RuntimeChatClient(cfg).complete([], [])).rejects.toThrow(/truncat|length/i);
  });

  it('meters a truncated call — the compute happened even though the call errors', async () => {
    const times = [0, 9]; let i = 0;
    stubFetch(() => ({ json: { choices: [{ finish_reason: 'length', message: { content: 'x' } }], usage: { prompt_tokens: 5, completion_tokens: 31, total_tokens: 36 } } }));
    const client = new RuntimeChatClient(cfg, () => times[i++]);
    await expect(client.complete([], [])).rejects.toThrow(/length/i);
    // Unlike a non-OK HTTP failure (no completion produced), a truncated call ran the model — meter it.
    expect(client.getUsage()).toMatchObject({ calls: 1, activeMs: 9, completionTokens: 31 });
  });

  it('does NOT throw on a normal finish_reason (stop / tool_calls / absent)', async () => {
    for (const fr of ['stop', 'tool_calls', undefined]) {
      stubFetch(() => ({ json: { choices: [{ ...(fr ? { finish_reason: fr } : {}), message: { content: 'ok' } }] } }));
      const reply = await new RuntimeChatClient(cfg).complete([], []);
      expect(reply.content).toBe('ok');
    }
  });

  it('reports a friendly error when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    await expect(new RuntimeChatClient(cfg).complete([], [])).rejects.toThrow(/timed out/);
  });

  it('available() returns true and probes /models when the runtime responds', async () => {
    let url = '';
    stubFetch((u) => { url = u; return { json: { data: [] } }; });
    expect(await new RuntimeChatClient(cfg).available()).toBe(true);
    expect(url).toBe('http://test/v1/models');
  });

  it('available() returns false on a non-OK status', async () => {
    stubFetch(() => ({ status: 503, text: 'down' }));
    expect(await new RuntimeChatClient(cfg).available()).toBe(false);
  });

  it('available() returns false when the runtime is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    expect(await new RuntimeChatClient(cfg).available()).toBe(false);
  });

  it('available() sends a bearer header only when an api key is configured', async () => {
    let auth: string | null = 'unset';
    stubFetch((_u, init) => { auth = new Headers(init.headers).get('authorization'); return { json: { data: [] } }; });
    await new RuntimeChatClient({ ...cfg, apiKey: 'sk-9' }).available();
    expect(auth).toBe('Bearer sk-9');
    await new RuntimeChatClient(cfg).available();
    expect(auth).toBeNull();
  });

  it('getUsage() accumulates tokens + active time across calls (injected clock)', async () => {
    const times = [100, 105, 200, 230]; let i = 0;
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } }));
    const client = new RuntimeChatClient(cfg, () => times[i++]);
    await client.complete([{ role: 'user', content: 'a' }], []);
    await client.complete([{ role: 'user', content: 'b' }], []);
    expect(client.getUsage()).toMatchObject({
      promptTokens: 20, completionTokens: 8, totalTokens: 28, calls: 2, reportedCalls: 2, activeMs: 35,
    });
  });

  it('getUsage() records time but marks tokens unavailable when usage is omitted', async () => {
    const times = [0, 7]; let i = 0;
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    const client = new RuntimeChatClient(cfg, () => times[i++]);
    await client.complete([], []);
    expect(client.getUsage()).toMatchObject({ totalTokens: 0, calls: 1, reportedCalls: 0, activeMs: 7 });
  });

  it('tolerates a malformed usage block — still returns, not counted as reported', async () => {
    const times = [0, 3]; let i = 0;
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5 } } }));
    const client = new RuntimeChatClient(cfg, () => times[i++]);
    const reply = await client.complete([], []);
    expect(reply.content).toBe('ok');
    expect(client.getUsage()).toMatchObject({ calls: 1, reportedCalls: 0, totalTokens: 0, activeMs: 3 });
  });

  it('does not count a failed (non-OK) call in usage', async () => {
    stubFetch(() => ({ status: 500, text: 'boom' }));
    const client = new RuntimeChatClient(cfg);
    await expect(client.complete([], [])).rejects.toThrow();
    expect(client.getUsage()).toMatchObject({ calls: 0, reportedCalls: 0, activeMs: 0 });
  });

  it('surfaces runtime cached_tokens from prompt_tokens_details', async () => {
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } } } }));
    const client = new RuntimeChatClient(cfg);
    await client.complete([], []);
    expect(client.getUsage()).toMatchObject({ cachedTokens: 40, cachedReported: true });
  });

  it('leaves cachedReported false when the runtime omits prompt_tokens_details', async () => {
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } }));
    const client = new RuntimeChatClient(cfg);
    await client.complete([], []);
    expect(client.getUsage()).toMatchObject({ cachedReported: false, cachedTokens: 0 });
  });

  it('flags cachedReported on a reported cached_tokens of 0 (cache miss, still reported)', async () => {
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } } } }));
    const client = new RuntimeChatClient(cfg);
    await client.complete([], []);
    expect(client.getUsage()).toMatchObject({ cachedTokens: 0, cachedReported: true });
  });

  it('ignores a malformed prompt_tokens_details (cachedReported stays false)', async () => {
    stubFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 'nope' } } } }));
    const client = new RuntimeChatClient(cfg);
    await client.complete([], []);
    expect(client.getUsage()).toMatchObject({ cachedReported: false });
  });
});

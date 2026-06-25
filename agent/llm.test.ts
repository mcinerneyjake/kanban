import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuntimeChatClient, resolveLlmConfig, type LlmConfig } from './llm.js';
import { AGENT_TOOLS } from './tools.js';

const cfg: LlmConfig = { baseUrl: 'http://test/v1', model: 'test-model', apiKey: null };

function stubFetch(impl: (url: string, init: RequestInit) => { status?: number; json?: unknown; text?: string }) {
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = impl(url, init ?? {});
    const payload = r.text ?? JSON.stringify(r.json ?? {});
    return Promise.resolve(new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } }));
  }));
}

describe('resolveLlmConfig', () => {
  it('defaults base URL + model and reports no api key', () => {
    expect(resolveLlmConfig({})).toEqual({
      baseUrl: 'http://localhost:1234/v1', model: 'qwen/qwen3.5-9b', apiKey: null,
    });
  });
  it('strips a trailing slash and reads an api key', () => {
    const c = resolveLlmConfig({ LLM_BASE_URL: 'http://x/v1/', LLM_API_KEY: 'sk-1' });
    expect(c.baseUrl).toBe('http://x/v1');
    expect(c.apiKey).toBe('sk-1');
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

  it('reports a friendly error when the request times out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    await expect(new RuntimeChatClient(cfg).complete([], [])).rejects.toThrow(/timed out/);
  });
});

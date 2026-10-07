import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatLLM, OllamaChat } from '../providers/llm';
import { canonicalModel, normalizeLlm, plansLongRequests } from '../config';
import { buildTools } from '../agent/tools';
import { toToolSchema } from '../agent/tool';
import { SYSTEM_PROMPT } from '../agent/prompt';

const cfg = { provider: 'ollama' as const, apiUrl: 'http://ollama.test', model: 'qwen3.5:9b', timeoutMs: 5000, numGpu: 99, numCtx: 12288, maxSteps: 8 };

describe('OllamaChat — the context window always fits the instructions and tools', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('grows past the configured window when the system prompt and tool schemas need it, and stays put between requests', async () => {
    const sent: Array<{ options: { num_ctx: number; num_predict: number } }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ message: { content: 'ok' }, done_reason: 'stop' }), { status: 200 });
    });
    const llm = new OllamaChat(cfg);
    llm.dispose();
    const tools = buildTools().map(toToolSchema);
    const messages = [{ role: 'system' as const, content: SYSTEM_PROMPT }, { role: 'user' as const, content: 'open the dashboard' }];
    await llm.chat(messages, tools);
    await llm.chat([...messages, { role: 'user' as const, content: 'and the inbox' }], tools);

    const fixedTokens = (JSON.stringify(tools).length + SYSTEM_PROMPT.length) / 3.6; // as measured on Qwen 3.5
    expect(sent[0].options.num_ctx).toBeGreaterThan(fixedTokens + 2048);
    expect(sent[0].options.num_ctx).toBeGreaterThanOrEqual(cfg.numCtx);
    expect(sent[1].options.num_ctx).toBe(sent[0].options.num_ctx); // no reload between requests
    expect(sent[0].options.num_predict).toBeGreaterThan(1000); // room for a tool call with many records
  });

  it('keeps the configured window when it is already big enough', async () => {
    const sent: Array<{ options: { num_ctx: number } }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ message: { content: '' }, done_reason: 'length' }), { status: 200 });
    });
    const llm = new OllamaChat({ ...cfg, numCtx: 65536 });
    llm.dispose();
    const turn = await llm.chat([{ role: 'system', content: 'short' }], []);
    expect(sent[0].options.num_ctx).toBe(65536);
    expect(turn.truncated).toBe(true);
  });
});

describe('the configured provider alone decides where the model runs — for every agent', () => {
  afterEach(() => vi.unstubAllGlobals());
  const base = { timeoutMs: 5000, numGpu: 99, numCtx: 12288, maxSteps: 8, model: 'qwen3.5:4b' };

  /** Every request the adapter makes: where it went and what it sent. */
  function capture() {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const openai = String(url).endsWith('/v1/chat/completions');
      return new Response(JSON.stringify(openai ? { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } : { message: { content: 'ok' }, done_reason: 'stop' }), { status: 200 });
    });
    return sent;
  }

  it('This Computer → Ollama; vLLM → the vLLM server; OpenRouter → the bridge’s OpenRouter proxy; the Kaggle GPU → vLLM through the bridge', async () => {
    const sent = capture();
    const cases = [
      { cfg: { ...base, provider: 'ollama' as const, apiUrl: 'http://127.0.0.1:11434' }, url: 'http://127.0.0.1:11434/api/chat', name: 'ollama:qwen3.5:4b' },
      { cfg: { ...base, provider: 'vllm' as const, apiUrl: 'http://gpu.lan:8000' }, url: 'http://gpu.lan:8000/v1/chat/completions', name: 'vllm:qwen3.5:4b' },
      { cfg: { ...base, provider: 'vllm' as const, apiUrl: 'http://127.0.0.1:8765/vllm' }, url: 'http://127.0.0.1:8765/vllm/v1/chat/completions', name: 'vllm:qwen3.5:4b' },
      { cfg: { ...base, provider: 'openrouter' as const, apiUrl: 'http://127.0.0.1:8765/openrouter/api', model: 'openai/gpt-6-sol' }, url: 'http://127.0.0.1:8765/openrouter/api/v1/chat/completions', name: 'openrouter:openai/gpt-6-sol' },
    ];
    for (const c of cases) {
      const llm = createChatLLM(c.cfg);
      llm.dispose?.();
      expect(llm.name).toBe(c.name);
      await llm.chat([{ role: 'user', content: 'hi' }], []);
      expect(sent.at(-1)!.url).toBe(c.url);
    }
    expect(sent.filter((s) => s.url.includes('11434'))).toHaveLength(1); // only the This Computer case
  });

  it('vLLM is told not to think (Qwen’s template switch, like Ollama’s think: false) and primes its prefix cache with one token', async () => {
    const sent = capture();
    const llm = createChatLLM({ ...base, provider: 'vllm', apiUrl: 'http://gpu.lan:8000' });
    await llm.chat([{ role: 'user', content: 'hi' }], []);
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(await llm.warmUp!([{ role: 'system', content: 'static prefix' }], [])).toBeNull();
    expect(sent[1].body).toMatchObject({ max_tokens: 1, model: 'qwen3.5:4b' });
    expect((sent[1].body.messages as Array<{ content: string }>)[0].content).toBe('static prefix');
  });

  it('the Kaggle GPU says whether the model is really in memory — not merely served — and a load that failed while the line was kept open is an error', async () => {
    const kaggle = { ...base, provider: 'vllm' as const, apiUrl: 'http://127.0.0.1:8765/vllm', model: 'qwen3.5:9b' };
    // 9b is served but not in memory (as when it stuck on Kaggle): not loaded — the panel says "Loading", not "Preparing".
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('/careflow/status') ? new Response(JSON.stringify({ models: ['qwen3.5:4b', 'qwen3.5:9b'], loaded: ['qwen3.5:4b'] })) : new Response(JSON.stringify({ data: [] })),
    );
    const llm = createChatLLM(kaggle);
    expect(await llm.isLoaded!()).toBe(false);
    expect(await createChatLLM({ ...kaggle, model: 'qwen3.5:4b' }).isLoaded!()).toBe(true);
    // Another vLLM server has no /careflow/status: served is taken as loaded, as before.
    vi.stubGlobal('fetch', async (url: string) => new Response('{}', { status: String(url).endsWith('/careflow/status') ? 404 : 200 }));
    expect(await createChatLLM({ ...base, provider: 'vllm', apiUrl: 'http://gpu.lan:8000' }).isLoaded!()).toBe(true);
    // The server answered at once, kept the line open with spaces, then said the model would not load.
    vi.stubGlobal('fetch', async () => new Response('   {"error": {"message": "Ollama: qwen3.5:9b would not load", "code": 503}}', { status: 200 }));
    expect(await llm.warmUp!([{ role: 'system', content: 'prefix' }], [])).toMatch(/would not load/);
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/would not load/);
    // …and a good answer after the spaces is read as usual.
    vi.stubGlobal('fetch', async () => new Response(`   ${JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] })}`, { status: 200 }));
    expect(await llm.warmUp!([{ role: 'system', content: 'prefix' }], [])).toBeNull();
    expect((await llm.chat([{ role: 'user', content: 'hi' }], [])).content).toBe('ok');
  });

  it('an unknown provider never falls back to Ollama — it says so', async () => {
    const sent = capture();
    const llm = createChatLLM({ ...base, provider: 'something-else' as never, apiUrl: 'http://127.0.0.1:11434' });
    await expect(llm.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/not known/);
    expect(sent).toHaveLength(0);
  });

  it('settings saved by earlier versions are read in today’s terms: OpenRouter, and the Kaggle GPU as vLLM', () => {
    expect(normalizeLlm({ ...base, provider: 'openai-compatible', apiUrl: 'http://127.0.0.1:8765/openrouter/api' }).provider).toBe('openrouter');
    expect(normalizeLlm({ ...base, provider: 'ollama', apiUrl: 'http://127.0.0.1:8765/ollama' })).toMatchObject({ provider: 'vllm', apiUrl: 'http://127.0.0.1:8765/vllm' });
    expect(normalizeLlm({ ...base, provider: 'ollama', apiUrl: 'http://127.0.0.1:11434' }).provider).toBe('ollama');
    expect(normalizeLlm({ ...base, provider: 'openai-compatible', apiUrl: 'http://127.0.0.1:8080' }).provider).toBe('openai-compatible');
  });

  it('model rules hold under every runtime’s name for the model', () => {
    for (const name of ['qwen3.5:9b', 'Qwen/Qwen3.5-9B', 'Qwen/Qwen3.5-9B-AWQ']) expect(canonicalModel(name)).toBe('qwen3.5:9b');
    expect(canonicalModel('openai/gpt-6-sol')).toBe('openai/gpt-6-sol');
    expect(canonicalModel('qwen/qwen3.5-9b')).toBe('qwen/qwen3.5-9b'); // OpenRouter's build: not what was measured
    expect(plansLongRequests({ model: 'Qwen/Qwen3.5-9B' })).toBe(false);
    expect(plansLongRequests({ model: 'Qwen/Qwen3.5-4B' })).toBe(true);
  });
});

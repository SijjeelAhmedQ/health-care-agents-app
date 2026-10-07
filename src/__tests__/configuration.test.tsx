/**
 * The Configuration page in the real application — Models (where models can run: This Computer, Kaggle,
 * OpenRouter, any of them on) and Agents (which model each agent uses, independently) — with Ollama, the
 * bridge, the Kaggle server and OpenRouter answered by a fake `fetch`. Nothing reaches the assistant until
 * Apply; then every agent runs on the model it was given.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { getAIOverride, clearAIOverride } from '@/services/ai/config';
import { getVoiceController } from '@/services/ai/voiceController';
import { installBrowserStubs, pageText, renderAppAt, unmountApp, wait, waitUntil } from './harness';

const TIMEOUT = 40000;
const KAGGLE = 'https://gpu.trycloudflare.com';

const tag = (name: string, caps: string[], size = '4.7B') => ({ name, size: 3.4e9, modified_at: '2026-09-20T00:00:00Z', capabilities: caps, details: { family: 'qwen35', parameter_size: size, quantization_level: 'Q4_K_M' } });

let installed = [tag('qwen3.5:4b', ['completion', 'tools']), tag('gemma-no-tools:2b', ['completion'], '2B')];
const requests: Array<{ url: string; method: string; body?: unknown }> = [];
let sttSettings = { engine: 'gguf', repo: 'omi-health/omi-med-stt-v1-gguf', gguf_file: 'omi-med-stt-v1-q8_0.gguf', backend: 'cpu', threads: 0, endpoint_ms: 900, partial_ms: 500, record: false };

const sttConfig = () => ({
  settings: sttSettings,
  engine: { engine: 'gguf (omi-med-stt-v1-gguf / parakeet.cpp cpu)', model: sttSettings.repo, ready: true },
  models: [
    { id: 'omi-health/omi-med-stt-v1-gguf::omi-med-stt-v1-q8_0.gguf', repo: 'omi-health/omi-med-stt-v1-gguf', engine: 'gguf', gguf_file: 'omi-med-stt-v1-q8_0.gguf', label: 'Omi Med STT v1 · GGUF q8_0', downloaded: true, download_mb: null, available: true, reason: '' },
    { id: 'omi-health/omi-med-stt-v1-mlx-q8', repo: 'omi-health/omi-med-stt-v1-mlx-q8', engine: 'mlx', gguf_file: null, label: 'Omi Med STT v1 · MLX 8-bit', downloaded: false, download_mb: 700, available: false, reason: 'MLX builds run only on Apple Silicon Macs' },
  ],
  backends: [
    { id: 'cpu', installed: true, available: true, reason: '' },
    { id: 'cuda', installed: false, available: false, reason: 'Building it needs CMake, the CUDA Toolkit' },
    { id: 'vulkan', installed: false, available: false, reason: 'Building it needs CMake, the Vulkan SDK' },
  ],
});

/** The Kaggle server: both Qwen models served (a T4 x2), Whisper and Omi. */
const HEALTH = { ok: true, model: 'whisper-large-v3-turbo', device: 'cuda', gpu: 'Tesla T4, 2199 MiB, 15360 MiB', engines: { whisper: {}, omi: {} }, llm: { ok: true, engine: 'vllm', models: ['qwen3.5:4b', 'qwen3.5:9b'] } };
const OPENROUTER_MODELS = {
  data: [
    { id: 'openai/gpt-6-sol', name: 'OpenAI: GPT-6 Sol', created: 100, context_length: 1050000, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools'] },
    { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash', created: 300, context_length: 128000, pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['tools'] },
    { id: 'openai/gpt-oss-120b', name: 'OpenAI: gpt-oss-120b', created: 250, context_length: 131000, pricing: { prompt: '0.00000005', completion: '0.00000025' }, supported_parameters: ['tools'] },
    { id: 'vendor/no-tools', name: 'Vendor: No Tools', created: 400, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
  ],
};

let compute: Record<string, unknown>;
let kaggleUp = true;
const puts: Array<Record<string, unknown>> = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(installBrowserStubs);

beforeEach(async () => {
  clearAIOverride();
  installed = [tag('qwen3.5:4b', ['completion', 'tools']), tag('gemma-no-tools:2b', ['completion'], '2B')];
  requests.length = 0;
  puts.length = 0;
  kaggleUp = true;
  compute = { mode: 'local', providers: ['local'], speech: 'local', remote_url: '', has_key: false, remote: null, has_openrouter_key: false, openrouter_model: 'openai/gpt-6-sol', openrouter: null, stt: sttConfig().engine };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    if (url.endsWith('/api/tags')) return json({ models: installed });
    if (url.endsWith('/api/generate')) return json({ done: true });
    if (url.endsWith('/api/chat')) return json({ message: { content: '', tool_calls: [{ function: { name: 'open_page', arguments: { page: 'dashboard' } } }] } });
    if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ function: { name: 'open_page', arguments: '{"page":"dashboard"}' } }] } }] });
    if (url.endsWith('/openrouter/api/v1/models')) return json(OPENROUTER_MODELS);
    if (url.endsWith('/api/config/compute/check')) return json(kaggleUp ? HEALTH : { ok: false, error: `Cannot reach the remote GPU server at ${KAGGLE}` });
    if (url.endsWith('/api/config/compute')) {
      if (method === 'PUT') {
        puts.push(body);
        const providers = body.providers as string[];
        compute = {
          ...compute,
          mode: body.mode,
          providers,
          speech: body.speech,
          remote_url: body.remote_url || compute.remote_url,
          remote_engine: body.remote_engine,
          has_key: compute.has_key || !!body.remote_key,
          remote: providers.includes('kaggle') || body.speech === 'remote' ? HEALTH : null,
          has_openrouter_key: compute.has_openrouter_key || !!body.openrouter_key,
          openrouter_model: body.openrouter_model || compute.openrouter_model,
          openrouter: providers.includes('openrouter') ? { ok: true, limit_remaining: 4.45 } : null,
        };
      }
      return json(compute);
    }
    if (url.endsWith('/api/config/stt') && method === 'GET') return json(sttConfig());
    if (url.endsWith('/api/config/stt') && method === 'PUT') {
      sttSettings = body;
      return json(sttConfig());
    }
    return json({}, 404);
  });
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
});

afterEach(async () => {
  await unmountApp();
  vi.unstubAllGlobals();
  clearAIOverride();
  getVoiceController().reconfigure();
});

// ---- driving the page like a person
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T | null;
const provider = (source: string) => $(`.cfg-provider[data-source="${source}"]`)!;
const detail = () => $('.cfg-detail')!;
const openProvider = async (source: string) => {
  (provider(source).querySelector('.cfg-provider-main') as HTMLButtonElement).click();
  await waitUntil(() => detail().getAttribute('data-source') === source);
};
const switchOn = async (source: string) => {
  const sw = provider(source).querySelector('.cfg-provider-switch') as HTMLButtonElement;
  if (sw.getAttribute('aria-checked') !== 'true') sw.click();
  await waitUntil(() => provider(source).getAttribute('data-on') === 'true' && detail().getAttribute('data-source') === source);
};
const tab = async (name: string) => {
  ($(`.cfg-tab[data-tab="${name}"]`) as HTMLButtonElement).click();
  await waitUntil(() => $(`.cfg-tab[data-tab="${name}"]`)!.getAttribute('aria-selected') === 'true');
  await wait(30);
};
const agent = (key: string) => $(`.cfg-agent[data-agent="${key}"]`)!;
const apply = () => $<HTMLButtonElement>('.cfg-apply')!;
const saveBar = () => $('.cfg-save')?.textContent ?? '';
const type = (selector: string, value: string) => {
  const el = $<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const visibleOptions = () => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')] as HTMLElement[];
/** Open the antd Select inside `root` and pick the option whose text contains `text`. */
async function pick(root: Element, text: string) {
  (root.querySelector('.ant-select-selector') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await waitUntil(() => visibleOptions().some((o) => o.textContent?.includes(text)));
  visibleOptions().find((o) => o.textContent?.includes(text))!.click();
  await wait(60);
}
async function selectOptions(root: Element) {
  (root.querySelector('.ant-select-selector') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await waitUntil(() => visibleOptions().length > 0);
  return visibleOptions();
}
const setSource = async (key: string, source: string) => {
  (agent(key).querySelector(`.cfg-source[data-value="${source}"]`) as HTMLButtonElement).click();
  await waitUntil(() => agent(key).getAttribute('data-source') === source);
};
const connectKaggle = async () => {
  type('#compute-url', KAGGLE);
  type('#compute-key', 'secret');
  await waitUntil(() => pageText().includes('Connected · Tesla T4'), 5000);
};
const ready = () => pageText().includes('Ollama · 2 models');

describe('Configuration — tabs', () => {
  it('three tabs — Models, Agents, Advanced — remembered in the address; a tab says when it holds a change or a problem', async () => {
    await renderAppAt('/configuration', ready);
    expect([...document.querySelectorAll('.cfg-tab')].map((t) => t.getAttribute('data-tab'))).toEqual(['models', 'agents', 'advanced']);
    expect($('.cfg-tab[data-tab="models"]')!.getAttribute('aria-selected')).toBe('true');
    expect($('.cfg-save')).toBeNull(); // nothing changed: no save bar

    await tab('agents');
    expect(window.location.search).toContain('tab=agents');
    expect($('.cfg-agent[data-agent="inbox"]')).not.toBeNull();
    await tab('models');
    await switchOn('openrouter'); // a change, and a problem (no key yet) — every agent moves to it
    expect($('.cfg-tab[data-tab="models"] .cfg-tab-badge.is-bad')!.textContent).toBe('1');
    await tab('agents');
    expect(agent('inbox').getAttribute('data-source')).toBe('openrouter');
    expect($('.cfg-tab[data-tab="agents"] .cfg-tab-badge.is-dot')).not.toBeNull();
    expect(saveBar()).toMatch(/\d+ unsaved/);
    expect(saveBar()).toContain('OpenRouter on');
    expect(saveBar()).toContain('Give your OpenRouter API key');
  }, TIMEOUT);
});

describe('Configuration — Models', () => {
  it('This Computer: no model or speech rows any more — each agent\'s dropdown lists the installed models live, marks tool calling, shows a newly pulled one', async () => {
    await renderAppAt('/configuration', ready);
    expect(detail().textContent).not.toContain('Language model');
    expect(detail().textContent).not.toContain('Speech');
    expect(detail().textContent).toContain('Qwen3.5 4B'); // what switching it on gives every agent
    expect(detail().textContent).toContain('omi-med-stt-v1');
    expect($('.cfg-speech')).toBeNull(); // the microphone is chosen in Agents now
    await tab('agents');
    const options = await selectOptions(agent('master'));
    const byName = (n: string) => options.find((o) => o.textContent?.includes(n))!;
    expect(byName('qwen3.5:4b').textContent).toContain('tool calling');
    expect(byName('gemma-no-tools:2b').textContent).toContain('no tool calling');
    expect(byName('gemma-no-tools:2b').className).toContain('ant-select-item-option-disabled');
    document.body.click();

    // `ollama pull qwen3.5:2b` in a terminal, then back to the app.
    installed = [...installed, tag('qwen3.5:2b', ['completion', 'tools'], '2.3B')];
    window.dispatchEvent(new Event('focus'));
    await tab('models');
    await waitUntil(() => pageText().includes('Ollama · 3 models'));
    expect(pageText()).toContain('3 models installed');
  }, TIMEOUT);

  it('any combination of providers can be on; a provider that is off is not offered to the agents', async () => {
    await renderAppAt('/configuration', ready);
    expect(provider('local').getAttribute('data-on')).toBe('true');
    expect(provider('kaggle').getAttribute('data-on')).toBe('false');
    await openProvider('kaggle');
    expect(detail().textContent).toContain('Kaggle is off');
    await tab('agents');
    const kaggleButton = () => agent('inbox').querySelector('.cfg-source[data-value="kaggle"]') as HTMLButtonElement;
    expect(kaggleButton().disabled).toBe(true);

    await tab('models');
    await switchOn('kaggle');
    await switchOn('openrouter');
    expect($('.cfg-tab[data-tab="models"]')!.textContent).toContain('3 of 3 providers on');
    await tab('agents');
    expect(kaggleButton().disabled).toBe(false);
    expect((agent('inbox').querySelector('.cfg-source[data-value="openrouter"]') as HTMLButtonElement).disabled).toBe(false);
    // Nothing is applied before Apply.
    expect(puts).toHaveLength(0);
    expect(saveBar()).toContain('Kaggle on');
    expect(saveBar()).toContain('OpenRouter on');
  }, TIMEOUT);

  it('Kaggle on: every agent on Qwen3.5 9B (the Summary Agent on Ternary Bonsai 27B), the microphone on Whisper — no Setup or Default Qwen rows; the dropdown offers 9B, Bonsai, MedGemma and Qwen3Guard (no 4B)', async () => {
    await renderAppAt('/configuration', ready);
    await switchOn('kaggle');
    await connectKaggle();
    expect(detail().querySelector('.cfg-tile')).toBeNull();
    expect(detail().textContent).not.toContain('Default Qwen');
    expect(detail().textContent).toContain('Qwen3.5 9B');
    expect(detail().textContent).toContain('Whisper large-v3-turbo');
    await tab('agents');
    for (const key of ['master', 'inbox', 'safety', 'summary']) expect(agent(key).getAttribute('data-source')).toBe('kaggle');
    expect(agent('summary').querySelector('.ant-select-selection-item')?.textContent).toContain('Ternary Bonsai 27B');
    expect($('.cfg-mic .cfg-speech-option.is-on')!.getAttribute('data-value')).toBe('kaggle-whisper');
    // The microphone: This Computer's and Kaggle's two, as their switches are on.
    expect([...document.querySelectorAll('.cfg-mic .cfg-speech-option')].map((o) => o.getAttribute('data-value'))).toEqual(['local-omi', 'kaggle-whisper', 'kaggle-omi']);

    const options = (await selectOptions(agent('summary'))).map((o) => o.textContent ?? '');
    expect(options).toHaveLength(4);
    expect(options[0]).toContain('Qwen3.5 9B');
    expect(options[1]).toContain('Ternary Bonsai 27B');
    expect(options[2]).toContain('MedGemma 4B');
    expect(options[2]).toContain('no tool calling');
    expect(options[3]).toContain('Qwen3Guard 4B');
    expect(options.join(' ')).not.toContain('4B tool calling'); // no Qwen3.5 4B on Kaggle
    // The Summary Agent only writes — MedGemma suits it: chosen, and nothing flagged.
    visibleOptions().find((o) => o.textContent?.includes('MedGemma 4B'))!.click();
    await waitUntil(() => (agent('summary').querySelector('.ant-select-selection-item')?.textContent ?? '').includes('MedGemma 4B'));
    expect(agent('summary').getAttribute('data-no-tools')).toBe('false');
    expect(agent('summary').querySelector('.cfg-short-flag')).toBeNull();
    expect(agent('summary').textContent).toContain('no tools'); // its role line: it holds none
    expect($('.cfg-notools')).toBeNull();
    // An agent that acts through tools on a model that calls none: the row only marks it (it keeps its height);
    // one notice above the list says what it means.
    await pick(agent('medications'), 'MedGemma 4B');
    await waitUntil(() => agent('medications').getAttribute('data-no-tools') === 'true');
    expect(agent('medications').querySelector('.cfg-short-flag')?.textContent).toContain('no tools');
    expect(agent('medications').querySelector('.cfg-agent-warn')).toBeNull();
    await pick(agent('safety'), 'Qwen3Guard 4B');
    await waitUntil(() => agent('safety').getAttribute('data-no-tools') === 'true');
    const notice = $('.cfg-notools')!.textContent ?? '';
    expect(notice).toContain('No tool calling on MedGemma 4B / Qwen3Guard 4B');
    expect(notice).toContain('Medication cannot carry out actions on it');
    expect(notice).not.toContain('Summary');
    expect(notice).toContain('the model review is skipped');
    expect(puts).toHaveLength(0);
  }, TIMEOUT);

  it('OpenRouter on: every agent on DeepSeek V4.1 Flash, the microphone stays on This Computer — alone, it has no microphone and cannot be applied', async () => {
    await renderAppAt('/configuration', ready);
    await switchOn('openrouter');
    expect(detail().textContent).not.toContain('Default cloud model');
    expect(detail().textContent).not.toContain('Hears with');
    expect(detail().querySelector('#compute-url')).toBeNull(); // Kaggle need not be set up for the microphone
    await tab('agents');
    expect(agent('inbox').getAttribute('data-source')).toBe('openrouter');
    expect(agent('inbox').textContent).toContain('deepseek-v4.1-flash');
    expect($('.cfg-mic .cfg-speech-option.is-on')!.getAttribute('data-value')).toBe('local-omi');
    // Every OpenRouter model that calls tools, in each agent's dropdown.
    await waitUntil(() => !!agent('inbox').querySelector('.ant-select'));
    const text = (await selectOptions(agent('inbox'))).map((o) => o.textContent).join(' | ');
    expect(text).toContain('DeepSeek V4.1 Flash');
    expect(text).toContain('gpt-oss-120b');
    expect(text).not.toContain('No Tools');
    document.body.click();

    // This Computer off: OpenRouter alone — no microphone model; said, and Apply stops.
    await tab('models');
    (provider('local').querySelector('.cfg-provider-switch') as HTMLButtonElement).click();
    await waitUntil(() => provider('local').getAttribute('data-on') === 'false');
    expect(pageText()).toContain('No microphone model');
    expect(saveBar()).toContain('OpenRouter has no speech recognition');
    expect(apply().disabled).toBe(true);
    await tab('agents');
    expect($('.cfg-mic')!.textContent).toContain('No microphone model');
  }, TIMEOUT);

  it('the Omi Med STT engine settings of this computer still go to the bridge (Advanced tab)', async () => {
    await renderAppAt('/configuration?tab=advanced', () => pageText().includes('Running:'));
    const text = pageText();
    expect(text).toContain('gguf (omi-med-stt-v1-gguf / parakeet.cpp cpu)');
    expect(text).toContain('Building it needs CMake, the CUDA Toolkit');
    const cuda = Array.from(document.querySelectorAll('.ant-radio-wrapper')).find((r) => r.textContent?.includes('CUDA'))!;
    expect(cuda.className).toContain('ant-radio-wrapper-disabled');

    const options = await selectOptions($('#cfg-speech-engine')!);
    const mlx = options.find((o) => o.textContent?.includes('MLX 8-bit'))!;
    expect(mlx.className).toContain('ant-select-item-option-disabled');
    expect(mlx.textContent).toContain('Apple Silicon');
    document.body.click();

    const threads = Array.from(document.querySelectorAll('#cfg-speech-engine .config-field')).find((f) => f.textContent?.startsWith('CPU threads'))!.querySelector('input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(threads, '4');
    threads.dispatchEvent(new Event('input', { bubbles: true }));
    threads.dispatchEvent(new Event('blur', { bubbles: true }));
    const save = () => Array.from(document.querySelectorAll('#cfg-speech-engine button')).find((b) => b.textContent?.includes('Save')) as HTMLButtonElement;
    await waitUntil(() => !save().disabled);
    save().click();
    await waitUntil(() => requests.some((r) => r.url.endsWith('/api/config/stt') && r.method === 'PUT'));
    const put = requests.find((r) => r.url.endsWith('/api/config/stt') && r.method === 'PUT')!.body as { threads: number; repo: string };
    expect(put.threads).toBe(4);
    expect(put.repo).toBe('omi-health/omi-med-stt-v1-gguf');
  }, TIMEOUT);

  it('says so when the bridge is not running', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/tags')) return json({ models: installed });
      throw new TypeError('Failed to fetch');
    });
    await renderAppAt('/configuration', () => pageText().includes('The bridge is not reachable'));
    expect(pageText()).toContain('npm run bridge');
  }, TIMEOUT);

  it('a Kaggle server that does not answer is said plainly — before anything is switched', async () => {
    kaggleUp = false;
    await renderAppAt('/configuration', ready);
    await switchOn('kaggle');
    type('#compute-url', KAGGLE);
    type('#compute-key', 'secret');
    await waitUntil(() => pageText().includes('Not reachable'), 5000);
    expect(pageText()).toContain(`Cannot reach the remote GPU server at ${KAGGLE}`);
    expect(puts).toHaveLength(0);
  }, TIMEOUT);
});

describe('Configuration — Agents', () => {
  it('every agent on its own model — the example from the spec — and after Apply each agent really runs on it', async () => {
    await renderAppAt('/configuration', ready);
    await switchOn('kaggle');
    await connectKaggle();
    await switchOn('openrouter');
    type('#openrouter-key', 'sk-or-secret');
    await waitUntil(() => pageText().includes('3 models call tools'));

    await tab('agents');
    ($('#llm-multi') as HTMLButtonElement).click();
    await wait(50);
    // Everyone back on This Computer first ("Assign all to"), then four agents on their own models.
    ($('.cfg-assign-all') as HTMLButtonElement).click();
    const thisComputer = () => [...document.querySelectorAll('.ant-dropdown-menu-item')].find((i) => i.textContent?.includes('This Computer')) as HTMLElement | undefined;
    await waitUntil(() => !!thisComputer());
    thisComputer()!.click();
    await waitUntil(() => agent('master').getAttribute('data-source') === 'local');
    // Dashboard → OpenRouter / DeepSeek Flash; Patients → OpenRouter / GPT-OSS-120B
    await setSource('dashboard', 'openrouter');
    await pick(agent('dashboard'), 'DeepSeek V4.1 Flash');
    await setSource('patients', 'openrouter');
    await pick(agent('patients'), 'gpt-oss-120b');
    // My Appointment → Kaggle / Qwen3.5 9B; Inbox → Kaggle / MedGemma 4B
    await setSource('appointments', 'kaggle');
    await pick(agent('appointments'), 'Qwen3.5 9B');
    await setSource('inbox', 'kaggle');
    await pick(agent('inbox'), 'MedGemma 4B');
    await wait(50);
    // Summary (and the Master) stay on This Computer / Qwen3.5 4B.
    expect(agent('summary').getAttribute('data-source')).toBe('local');
    expect(saveBar()).toMatch(/\d+ unsaved/);
    expect(puts).toHaveLength(0);

    apply().click();
    await waitUntil(() => puts.length === 1 && !$('.cfg-save'), 8000);
    expect(pageText()).toContain('Applied — the agents are ready');
    expect(puts[0]).toMatchObject({ mode: 'local', providers: ['local', 'kaggle', 'openrouter'], remote_url: KAGGLE, remote_key: 'secret', openrouter_key: 'sk-or-secret' });
    expect(getAIOverride().agents).toMatchObject({
      dashboard: { source: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
      patients: { source: 'openrouter', model: 'openai/gpt-oss-120b' },
      appointments: { source: 'kaggle', model: 'qwen3.5:9b' },
      inbox: { source: 'kaggle', model: 'hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M' },
      summary: { source: 'local', model: 'qwen3.5:4b' },
    });
    // The routing itself: every agent's adapter goes where its model runs.
    expect(getVoiceController().agentModelNames).toEqual({
      master: 'ollama:qwen3.5:4b',
      planning: 'ollama:qwen3.5:4b', // none of its own: the master's
      dashboard: 'openrouter:deepseek/deepseek-v4.1-flash',
      patients: 'openrouter:openai/gpt-oss-120b',
      appointments: 'vllm:qwen3.5:9b',
      inbox: 'vllm:hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M',
      summary: 'ollama:qwen3.5:4b',
      // none of their own: the master's
      patient_appointments: 'ollama:qwen3.5:4b',
      medications: 'ollama:qwen3.5:4b',
      diagnoses: 'ollama:qwen3.5:4b',
      tasks: 'ollama:qwen3.5:4b',
      recalls: 'ollama:qwen3.5:4b',
      notes: 'ollama:qwen3.5:4b',
    });
    // "Running now" says so.
    const now = Object.fromEntries([...document.querySelectorAll('.cfg-now-agent')].map((e) => [e.getAttribute('data-agent') ?? e.textContent, e.getAttribute('data-source')]));
    expect(Object.values(now).filter((v) => v === 'openrouter')).toHaveLength(2);
    expect(Object.values(now).filter((v) => v === 'kaggle')).toHaveLength(2);
    expect(Object.values(now).filter((v) => v === 'local')).toHaveLength(10);
  }, TIMEOUT);

  it('switching a provider off moves its agents to one that is on — Apply never waits on it; “Assign all to” moves everyone', async () => {
    await renderAppAt('/configuration', ready);
    await switchOn('openrouter');
    type('#openrouter-key', 'sk-or-secret');
    await tab('agents');
    expect(agent('inbox').getAttribute('data-source')).toBe('openrouter');
    await tab('models');
    (provider('openrouter').querySelector('.cfg-provider-switch') as HTMLButtonElement).click();
    await waitUntil(() => provider('openrouter').getAttribute('data-on') === 'false');
    expect($('.cfg-tab[data-tab="agents"] .cfg-tab-badge.is-bad')).toBeNull();
    await tab('agents');
    expect(agent('inbox').getAttribute('data-source')).toBe('local');
    expect(agent('inbox').getAttribute('data-bad')).toBe('false');

    await tab('models');
    await switchOn('kaggle');
    await tab('agents');
    expect(agent('inbox').getAttribute('data-source')).toBe('kaggle');
    ($('.cfg-assign-all') as HTMLButtonElement).click();
    const menuItem = () => [...document.querySelectorAll('.ant-dropdown-menu-item')].find((i) => i.textContent?.includes('This Computer')) as HTMLElement | undefined;
    await waitUntil(() => !!menuItem());
    menuItem()!.click();
    await waitUntil(() => agent('inbox').getAttribute('data-source') === 'local');
  }, TIMEOUT);

  it('single-agent mode: a new model for the Master switches the real assistant, frees the old model and loads the new one', async () => {
    installed = [...installed, tag('qwen3.5:2b', ['completion', 'tools'], '2.3B')];
    await renderAppAt('/configuration', () => pageText().includes('Ollama · 3 models'));
    await tab('agents');
    await pick(agent('master'), 'qwen3.5:2b');
    expect(agent('dashboard').textContent).toContain('Used in multi-agent mode');
    expect(agent('dashboard').getAttribute('data-idle')).toBe('true');
    apply().click();
    await waitUntil(() => pageText().includes('Applied — the agents are ready'), 8000);

    expect(getAIOverride().llm?.model).toBe('qwen3.5:2b');
    expect(store.getState().voice.llmProvider).toBe('ollama:qwen3.5:2b');
    expect(requests.some((r) => r.url.endsWith('/api/generate') && (r.body as { model: string; keep_alive: number }).model === 'qwen3.5:4b' && (r.body as { keep_alive: number }).keep_alive === 0)).toBe(true);
    const warm = requests.filter((r) => r.url.endsWith('/api/chat')).at(-1)!.body as { model: string; tools: unknown[] };
    expect(warm.model).toBe('qwen3.5:2b');
    expect(warm.tools.length).toBeGreaterThan(20);
    // Only This Computer is on: the bridge was not asked to change anything.
    expect(puts).toHaveLength(0);
  }, TIMEOUT);

  it('Test proves an agent’s model calls tools; a provider the bridge does not forward to yet waits for Apply', async () => {
    await renderAppAt('/configuration', ready);
    await tab('agents');
    (agent('summary').querySelector('.cfg-agent-test') as HTMLButtonElement).click();
    await waitUntil(() => !!agent('summary').querySelector('.cfg-agent-test.is-ok'));
    await tab('models');
    await switchOn('openrouter');
    await tab('agents');
    await setSource('summary', 'openrouter');
    expect((agent('summary').querySelector('.cfg-agent-test') as HTMLButtonElement).disabled).toBe(true);
  }, TIMEOUT);

  it('Planning and Safety are agents like the others — a row each, with provider, model and Test, and their own on/off switch', async () => {
    await renderAppAt('/configuration', ready);
    await tab('agents');
    // Not toggles in the orchestration card any more.
    expect($('.cfg-orchestration #llm-safety')).toBeNull();
    expect($('.cfg-orchestration #llm-planning')).toBeNull();
    expect([...document.querySelectorAll('.cfg-agent')].map((r) => r.getAttribute('data-agent'))).toEqual([
      'master',
      'planning',
      'dashboard',
      'patients',
      'appointments',
      'patient_appointments',
      'medications',
      'diagnoses',
      'tasks',
      'recalls',
      'notes',
      'inbox',
      'summary',
      'safety',
    ]);
    for (const key of ['planning', 'safety']) {
      expect(agent(key).querySelectorAll('.cfg-source')).toHaveLength(3);
      expect(agent(key).querySelector('.cfg-agent-test')).not.toBeNull();
      expect(agent(key).querySelector(`#llm-${key}`)!.getAttribute('aria-checked')).toBe('true');
    }
    // The Safety Agent works in single-agent mode too; the Planning Agent waits for multi-agent mode.
    expect(agent('safety').getAttribute('data-idle')).toBe('false');
    expect(agent('planning').getAttribute('data-idle')).toBe('true');

    // Its own model, like any agent's.
    await tab('models');
    await switchOn('openrouter');
    type('#openrouter-key', 'sk-or-secret');
    await tab('agents');
    await setSource('safety', 'openrouter');
    expect(saveBar()).toContain('Safety Agent → OpenRouter');

    // Off: dimmed, its controls disabled — and the save bar says so.
    ($('#llm-planning') as HTMLButtonElement).click();
    await waitUntil(() => agent('planning').getAttribute('data-off') === 'true');
    expect(agent('planning').textContent).toContain('Off');
    expect((agent('planning').querySelector('.cfg-agent-test') as HTMLButtonElement).disabled).toBe(true);
    expect([...agent('planning').querySelectorAll<HTMLButtonElement>('.cfg-source')].every((b) => b.disabled)).toBe(true);
    expect(saveBar()).toContain('Planning Agent off');

    // Multi-agent mode: the tab counts the agents that take part (Planning is off).
    ($('#llm-multi') as HTMLButtonElement).click();
    await waitUntil(() => ($('.cfg-tab[data-tab="agents"]')!.textContent ?? '').includes('7 agents'));

    apply().click();
    await waitUntil(() => !$('.cfg-save'), 8000);
    expect(getAIOverride().llm).toMatchObject({ planning: false, safety: true, multiAgent: true });
    expect(getAIOverride().agents?.safety).toMatchObject({ source: 'openrouter' });
  }, TIMEOUT);

  it('Discard puts the draft back to what runs', async () => {
    await renderAppAt('/configuration', ready);
    await switchOn('kaggle');
    await tab('agents');
    await setSource('inbox', 'kaggle');
    expect(saveBar()).toMatch(/unsaved/);
    ($('.cfg-save-discard') as HTMLButtonElement).click();
    await waitUntil(() => !$('.cfg-save'));
    expect(agent('inbox').getAttribute('data-source')).toBe('local');
    await tab('models');
    expect(provider('kaggle').getAttribute('data-on')).toBe('false');
  }, TIMEOUT);
});

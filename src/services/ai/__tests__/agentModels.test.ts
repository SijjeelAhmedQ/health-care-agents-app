import { afterEach, describe, expect, it } from 'vitest';
import { aiConfig, clearAIOverride, setAIOverride, type ModelsConfig } from '../config';
import { defaultModelsConfig, getAgentModels, llmConfigFor, resolveAgentLlms, sourceOfLlm } from '../agentModels';
import { changesBetween, problemsOf, speechChoices, switchProvider, type Draft } from '@/components/config/configModel';
import { AGENT_KEYS, KAGGLE_BONSAI, KAGGLE_MEDGEMMA, KAGGLE_MODELS, KAGGLE_QWEN_GUARD, lacksTools, modelLabel } from '../agentModels';

const models = (over: Partial<ModelsConfig> = {}): ModelsConfig => ({
  local: { enabled: true, model: 'qwen3.5:4b', apiUrl: 'http://127.0.0.1:11434' },
  kaggle: { enabled: true, model: 'qwen3.5:9b' },
  openrouter: { enabled: true, model: 'openai/gpt-6-sol' },
  speech: 'local-omi',
  ...over,
});

afterEach(() => clearAIOverride());

describe('models and agents', () => {
  it('each source has its own runtime path — Ollama only for This Computer', () => {
    const m = models();
    expect(llmConfigFor({ source: 'local', model: 'qwen3.5:4b' }, m)).toMatchObject({ provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' });
    expect(llmConfigFor({ source: 'kaggle', model: 'qwen3.5:9b' }, m)).toMatchObject({ provider: 'vllm', apiUrl: 'http://127.0.0.1:8765/vllm', model: 'qwen3.5:9b' });
    expect(llmConfigFor({ source: 'openrouter', model: 'openai/gpt-oss-120b' }, m)).toMatchObject({ provider: 'openrouter', apiUrl: 'http://127.0.0.1:8765/openrouter/api', model: 'openai/gpt-oss-120b' });
    expect(sourceOfLlm({ provider: 'vllm', apiUrl: 'http://127.0.0.1:8765/vllm' })).toBe('kaggle');
    expect(sourceOfLlm({ provider: 'vllm', apiUrl: 'http://gpu.lan:8000' })).toBeNull(); // your own vLLM: not a Models source
  });

  it('every agent resolves to its own model — mixed freely across providers', () => {
    setAIOverride({
      llm: { provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' },
      models: models(),
      agents: {
        dashboard: { source: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
        patients: { source: 'openrouter', model: 'openai/gpt-oss-120b' },
        appointments: { source: 'kaggle', model: 'qwen3.5:4b' },
        inbox: { source: 'kaggle', model: 'qwen3.5:9b' },
        summary: { source: 'kaggle', model: KAGGLE_MEDGEMMA },
      },
    });
    const llms = resolveAgentLlms();
    expect(Object.fromEntries(Object.entries(llms).map(([k, v]) => [k, `${v.provider}:${v.model}`]))).toEqual({
      master: 'ollama:qwen3.5:4b',
      planning: 'ollama:qwen3.5:4b', // none of its own: the master's
      dashboard: 'openrouter:deepseek/deepseek-v4.1-flash',
      patients: 'openrouter:openai/gpt-oss-120b',
      appointments: 'vllm:qwen3.5:9b', // Kaggle no longer serves Qwen3.5 4B: a saved one runs on 9B
      inbox: 'vllm:qwen3.5:9b',
      // the agents that took over the Summary Agent's records — none of their own: the master's
      patient_appointments: 'ollama:qwen3.5:4b',
      medications: 'ollama:qwen3.5:4b',
      diagnoses: 'ollama:qwen3.5:4b',
      tasks: 'ollama:qwen3.5:4b',
      recalls: 'ollama:qwen3.5:4b',
      notes: 'ollama:qwen3.5:4b',
      summary: `vllm:${KAGGLE_MEDGEMMA}`, // it only writes summaries: MedGemma, no tools needed
      safety: 'ollama:qwen3.5:4b', // its reviewer: none of its own, the master's
    });
    expect(modelLabel(`vllm:${KAGGLE_MEDGEMMA}`)).toBe('MedGemma 4B');
    expect(modelLabel('ollama:qwen3.5:4b')).toBe('Qwen3.5 4B');
  });

  it('a model whose provider is switched off is never used — the agent falls back to the master’s', () => {
    setAIOverride({
      llm: { provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' },
      models: models({ openrouter: { enabled: false, model: 'openai/gpt-6-sol' } }),
      agents: { dashboard: { source: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' } },
    });
    expect(resolveAgentLlms().dashboard).toMatchObject({ provider: 'ollama', model: 'qwen3.5:4b' });
    expect(getAgentModels().dashboard).toEqual({ source: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }); // still saved, for when it is back on
  });

  it('before anything is saved: only the main model’s source is on, every agent on the main model', () => {
    const d = defaultModelsConfig({ ...aiConfig.llm, provider: 'openrouter', apiUrl: 'http://127.0.0.1:8765/openrouter/api', model: 'openai/gpt-6-luna' });
    expect([d.local.enabled, d.kaggle.enabled, d.openrouter.enabled]).toEqual([false, false, true]);
    expect(d.openrouter.model).toBe('openai/gpt-6-luna');
    expect(new Set(Object.values(getAgentModels()).map((a) => `${a.source}:${a.model}`)).size).toBe(1);
  });
});

describe('the Configuration draft', () => {
  const base = (): Draft => ({
    models: models({ kaggle: { enabled: false, model: 'qwen3.5:4b' }, openrouter: { enabled: false, model: 'openai/gpt-6-sol' } }),
    agents: Object.fromEntries(AGENT_KEYS.map((k) => [k, { source: 'local', model: 'qwen3.5:4b' }])) as Draft['agents'],
    multiAgent: false,
    parallelReads: true,
    planSteps: true,
    safety: true,
    planning: true,
    perf: { numCtx: 12288, numGpu: 99, timeoutMs: 90000, maxSteps: 8 },
    kaggleUrl: '',
    kaggleKey: '',
    openrouterKey: '',
  });
  const keys = { hasKaggleKey: false, hasOpenRouterKey: false };

  it('says what Apply would change, in words', () => {
    const saved = base();
    const draft: Draft = { ...base(), models: { ...base().models, kaggle: { enabled: true, model: 'qwen3.5:9b' }, speech: 'kaggle-whisper' }, agents: { ...base().agents, inbox: { source: 'kaggle', model: 'qwen3.5:9b' } } };
    expect(changesBetween(saved, draft).map((c) => c.text)).toEqual(['Kaggle on', 'Microphone → Whisper large-v3-turbo · Kaggle', 'Inbox Agent → Kaggle · Qwen3.5 9B']);
    expect(changesBetween(saved, saved)).toEqual([]);
  });

  it('says what stops an Apply: no provider, an agent on one that is off, speech that cannot run, missing keys', () => {
    const none: Draft = { ...base(), models: { ...base().models, local: { ...base().models.local, enabled: false } } };
    expect(problemsOf(none, keys).map((x) => x.text).join(' ')).toMatch(/at least one/);
    expect(problemsOf(none, keys).map((x) => x.text).join(' ')).toMatch(/Master Agent, Planning Agent, Patients Agent.*use a model whose provider is off/);

    const kaggle: Draft = { ...base(), models: { ...base().models, kaggle: { enabled: true, model: 'qwen3.5:4b' } } };
    expect(problemsOf(kaggle, keys).map((x) => x.text)).toEqual(['Give the Kaggle server’s address (careflow_kaggle.ipynb prints it).', 'Give the Kaggle server’s key.']);
    expect(problemsOf({ ...kaggle, kaggleUrl: 'https://x', kaggleKey: 'k' }, keys)).toEqual([]);

    const cloud: Draft = { ...base(), models: { ...base().models, openrouter: { enabled: true, model: 'openai/gpt-6-sol' } } };
    expect(problemsOf(cloud, keys).map((x) => x.text)).toEqual(['Give your OpenRouter API key.']);

    // Planning and Safety switched off run on nothing: their provider being off stops nothing.
    const kaggleOnly: Draft = { ...base(), models: { ...base().models, kaggle: { enabled: true, model: 'qwen3.5:4b' } }, kaggleUrl: 'https://x', kaggleKey: 'k' };
    const onKaggle = { source: 'kaggle', model: 'qwen3.5:4b' } as const;
    const offLocal: Draft = { ...kaggleOnly, models: { ...kaggleOnly.models, local: { ...kaggleOnly.models.local, enabled: false }, speech: 'kaggle-whisper' }, agents: Object.fromEntries(Object.keys(kaggleOnly.agents).map((k) => [k, onKaggle])) as Draft['agents'] };
    offLocal.agents.safety = { source: 'local', model: 'qwen3.5:4b' };
    expect(problemsOf(offLocal, keys).map((x) => x.text)).toEqual(['Safety Agent uses a model whose provider is off — pick another.']);
    expect(problemsOf({ ...offLocal, safety: false }, keys)).toEqual([]);
    expect(problemsOf(cloud, { ...keys, hasOpenRouterKey: true })).toEqual([]);
    expect(problemsOf({ ...cloud, openrouterKey: '   ' }, keys).map((x) => x.text)).toEqual(['Give your OpenRouter API key.']); // a blank key is no key
  });

  it('offers only the microphone models of the providers switched on — OpenRouter has none', () => {
    expect(speechChoices(base().models)).toEqual(['local-omi']);
    expect(speechChoices({ ...base().models, local: { ...base().models.local, enabled: false }, kaggle: { enabled: true, model: 'qwen3.5:9b' } })).toEqual(['kaggle-whisper', 'kaggle-omi']);
    // OpenRouter alone: no microphone — and Apply says why.
    const cloudOnly: Draft = { ...base(), models: { ...base().models, local: { ...base().models.local, enabled: false }, openrouter: { enabled: true, model: 'deepseek/deepseek-v4.1-flash' } } };
    expect(speechChoices(cloudOnly.models)).toEqual([]);
    expect(problemsOf(cloudOnly, { hasKaggleKey: false, hasOpenRouterKey: true }).map((x) => x.text).join(' ')).toMatch(/No microphone model: OpenRouter has no speech recognition/);
  });

  it('switching a provider on puts every agent on its default model and the microphone on its default', () => {
    const kaggle = switchProvider(base(), 'kaggle', true);
    // Every agent on Qwen3.5 9B — the Summary Agent on Ternary Bonsai 27B, made for its summaries.
    const { summary, ...others } = kaggle.agents;
    expect(new Set(Object.values(others).map((a) => `${a.source}:${a.model}`))).toEqual(new Set(['kaggle:qwen3.5:9b']));
    expect(summary).toEqual({ source: 'kaggle', model: KAGGLE_BONSAI });
    expect(kaggle.models.speech).toBe('kaggle-whisper');
    const local = switchProvider({ ...base(), models: { ...base().models, local: { ...base().models.local, enabled: false } } }, 'local', true);
    expect(new Set(Object.values(local.agents).map((a) => `${a.source}:${a.model}`))).toEqual(new Set(['local:qwen3.5:4b']));
    expect(local.models.speech).toBe('local-omi');
    // OpenRouter: DeepSeek V4.1 Flash; it hears on This Computer (omi-med-stt-v1) — Kaggle need not be on.
    const cloud = switchProvider(base(), 'openrouter', true);
    expect(new Set(Object.values(cloud.agents).map((a) => `${a.source}:${a.model}`))).toEqual(new Set(['openrouter:deepseek/deepseek-v4.1-flash']));
    expect(cloud.models.speech).toBe('local-omi');
    // …or on Kaggle, when that is on and This Computer is not.
    const onKaggle = switchProvider({ ...kaggle, models: { ...kaggle.models, local: { ...kaggle.models.local, enabled: false } } }, 'openrouter', true);
    expect(onKaggle.models.speech).toBe('kaggle-whisper');
  });

  it('switching a provider off moves its agents to one that is on — Apply is never stuck on it', () => {
    const cloud = switchProvider(base(), 'openrouter', true);
    const off = switchProvider(cloud, 'openrouter', false);
    expect(new Set(Object.values(off.agents).map((a) => a.source))).toEqual(new Set(['local']));
    expect(problemsOf(off, keys)).toEqual([]);
  });

  it('Kaggle serves Qwen3.5 9B, Ternary Bonsai 27B, MedGemma 4B and Qwen3Guard 4B — no Qwen3.5 4B; the last two call no tools', () => {
    expect([...KAGGLE_MODELS]).toEqual(['qwen3.5:9b', KAGGLE_BONSAI, KAGGLE_MEDGEMMA, KAGGLE_QWEN_GUARD]);
    expect([lacksTools('qwen3.5:9b'), lacksTools(KAGGLE_BONSAI), lacksTools(KAGGLE_MEDGEMMA), lacksTools(KAGGLE_QWEN_GUARD)]).toEqual([false, false, true, true]);
    expect(modelLabel(`vllm:${KAGGLE_BONSAI}`)).toBe('Ternary Bonsai 27B');
  });
});

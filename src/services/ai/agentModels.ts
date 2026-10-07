/**
 * Models and agents — the two halves of the Configuration page, kept apart:
 *
 *   MODEL CONFIGURATION   where models can run and which ones (This Computer, Kaggle, OpenRouter — any of them on)
 *   AGENT CONFIGURATION   which of those available models each agent uses (independent per agent)
 *
 * This module turns the two into what the assistant runs on: a language-model setting per agent. The master
 * agent's model is the main one — the single assistant uses it too, and it is what `effectiveConfig().llm`
 * holds, so the voice tools that change "the model" keep working. A specialist without a model of its own,
 * or whose model's source was switched off, thinks with the master's: a disabled source is never used.
 */
import { AGENT_NAMES } from './agents/taskGraph';
import { aiConfig, bridgeHttpUrl, effectiveConfig, getAIOverride, type AgentKey, type AgentModel, type AgentModels, type AIConfig, type ModelsConfig, type ModelSource, type SpeechChoice } from './config';

export const AGENT_KEYS: readonly AgentKey[] = ['master', 'planning', ...AGENT_NAMES, 'safety'];

export const SOURCE_LABELS: Record<ModelSource, string> = { local: 'This Computer', kaggle: 'Kaggle', openrouter: 'OpenRouter' };

/** MedGemma 4B (Google's medical Gemma 3) and Qwen3Guard 4B (Qwen's safety classifier), as Ollama pulls them. */
export const KAGGLE_MEDGEMMA = 'hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M';
export const KAGGLE_QWEN_GUARD = 'hf.co/mradermacher/Qwen3Guard-Gen-4B-GGUF:Q4_K_M';

/**
 * Ternary Bonsai 2 27B (Qwen3.8-27B in ternary weights, PQ2_0 7.2 GB): the Summary Agent's model on Kaggle. Only
 * PrismML's llama.cpp fork runs it — the notebook starts its llama-server on the second T4 (T4 x2 only).
 */
export const KAGGLE_BONSAI = 'ternary-bonsai-2-27b';

/** The models the Kaggle notebook serves, in the order the Agents tab offers them. */
export const KAGGLE_MODELS = ['qwen3.5:9b', KAGGLE_BONSAI, KAGGLE_MEDGEMMA, KAGGLE_QWEN_GUARD] as const;

/**
 * What each Kaggle model is — and whether it calls tools. Every agent works through tools: a model that cannot
 * call them can be chosen, but that agent will not be able to act (MedGemma is built on Gemma 3, which Ollama
 * runs without tools; Qwen3Guard only classifies text as safe or unsafe).
 */
export const KAGGLE_MODEL_INFO: Record<string, { label: string; note: string; tools: boolean }> = {
  'qwen3.5:9b': { label: 'Qwen3.5 9B', note: 'tool calling · every agent', tools: true },
  [KAGGLE_BONSAI]: { label: 'Ternary Bonsai 27B', note: 'summaries · 27B ternary · T4 x2', tools: true },
  [KAGGLE_MEDGEMMA]: { label: 'MedGemma 4B', note: 'medical summaries · no tool calling', tools: false },
  [KAGGLE_QWEN_GUARD]: { label: 'Qwen3Guard 4B', note: 'safety classifier · no tool calling', tools: false },
};

/** A model known not to call tools (an agent on it cannot act). */
export const lacksTools = (model: string) => KAGGLE_MODEL_INFO[model]?.tools === false;

/**
 * The agents that need no tools: the Summary Agent only writes (the app gathers the data), so a model that calls
 * none — MedGemma — suits it.
 */
export const TOOL_FREE_AGENTS: ReadonlySet<AgentKey> = new Set(['summary']);

/** A model as a person reads it, from its adapter name ("vllm:hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M" → "MedGemma 4B"). */
export function modelLabel(name: string): string {
  const model = name.replace(/^(ollama|vllm|openrouter|openai|bridge|llamacpp|lmstudio|scripted):/i, '');
  if (KAGGLE_MODEL_INFO[model]) return KAGGLE_MODEL_INFO[model].label;
  const qwen = model.match(/^qwen3\.5:(\d+(?:\.\d+)?)b$/i);
  if (qwen) return `Qwen3.5 ${qwen[1]}B`;
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
}

export const LOCAL_DEFAULT_MODEL = 'qwen3.5:4b';
export const KAGGLE_DEFAULT_MODEL = 'qwen3.5:9b';
export const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * What switching a provider on gives: every agent's model, and the microphone. OpenRouter has no speech
 * model: it hears on This Computer (omi-med-stt-v1) — or on Kaggle (Whisper) when that is on instead.
 */
/**
 * What switching a provider on gives: every agent its default model — or, per agent, the one made for its work
 * (on Kaggle the Summary Agent writes with Ternary Bonsai 27B) — and the microphone its default.
 */
export const PROVIDER_DEFAULTS: Record<ModelSource, { model: string; speech: SpeechChoice; agents?: Partial<Record<AgentKey, string>> }> = {
  local: { model: LOCAL_DEFAULT_MODEL, speech: 'local-omi' },
  kaggle: { model: KAGGLE_DEFAULT_MODEL, speech: 'kaggle-whisper', agents: { summary: KAGGLE_BONSAI } },
  openrouter: { model: OPENROUTER_DEFAULT_MODEL, speech: 'local-omi' },
};

export const SPEECH_LABELS: Record<SpeechChoice, { title: string; where: string }> = {
  'local-omi': { title: 'omi-med-stt-v1', where: 'This Computer' },
  'kaggle-whisper': { title: 'Whisper large-v3-turbo', where: 'Kaggle' },
  'kaggle-omi': { title: 'omi-med-stt-v1', where: 'Kaggle' },
};

/** The source that must be on for a speech choice: Kaggle speech needs the Kaggle server, not Kaggle's Qwen. */
export const speechNeedsKaggle = (speech: SpeechChoice) => speech !== 'local-omi';

const bridge = () => bridgeHttpUrl(effectiveConfig().stt.wsUrl).replace(/\/+$/, '');

/** Which source a language-model setting runs on — null for a runtime set outside the Models section. */
export function sourceOfLlm(llm: Pick<AIConfig['llm'], 'provider' | 'apiUrl'>): ModelSource | null {
  if (llm.provider === 'ollama') return 'local';
  if (llm.provider === 'openrouter') return 'openrouter';
  if (llm.provider === 'vllm' && /\/vllm\/?$/.test(llm.apiUrl)) return 'kaggle';
  return null;
}

/** The Models configuration before anything was saved: only the source the main model runs on is on. */
export function defaultModelsConfig(llm: AIConfig['llm'] = effectiveConfig().llm, openrouterDefault = OPENROUTER_DEFAULT_MODEL): ModelsConfig {
  const source = sourceOfLlm(llm) ?? 'local';
  return {
    local: { enabled: source === 'local', model: source === 'local' ? llm.model : LOCAL_DEFAULT_MODEL, apiUrl: source === 'local' ? llm.apiUrl : aiConfig.llm.apiUrl },
    kaggle: { enabled: source === 'kaggle', model: source === 'kaggle' && kaggleServes(llm.model) ? llm.model : KAGGLE_DEFAULT_MODEL },
    openrouter: { enabled: source === 'openrouter', model: source === 'openrouter' ? llm.model : openrouterDefault },
    speech: source === 'kaggle' ? 'kaggle-whisper' : 'local-omi',
  };
}

export function getModelsConfig(): ModelsConfig {
  const saved = getAIOverride().models ?? defaultModelsConfig();
  // A model the Kaggle notebook no longer serves (Qwen3.5 4B) is its default now.
  return kaggleServes(saved.kaggle.model) ? saved : { ...saved, kaggle: { ...saved.kaggle, model: KAGGLE_DEFAULT_MODEL } };
}

/** The Kaggle notebook serves this model. */
export const kaggleServes = (model: string) => (KAGGLE_MODELS as readonly string[]).includes(model);

/** An agent's saved model, as it can run now: one on Kaggle the notebook no longer serves becomes Qwen3.5 9B. */
const current = (m: AgentModel): AgentModel => (m.source === 'kaggle' && !kaggleServes(m.model) ? { ...m, model: KAGGLE_DEFAULT_MODEL } : m);

/** The master's model: the main language model, as a source and a model. */
export function masterModel(llm: AIConfig['llm'] = effectiveConfig().llm): AgentModel {
  return { source: sourceOfLlm(llm) ?? 'local', model: llm.model };
}

/** Every agent's model as saved; a specialist with none of its own has the master's. */
export function getAgentModels(): AgentModels {
  const master = masterModel();
  const saved = getAIOverride().agents ?? {};
  return Object.fromEntries(AGENT_KEYS.map((key) => [key, current(key === 'master' ? master : (saved[key] ?? master))])) as AgentModels;
}

/** A source's models are offered to the agents only while it is on. */
export const isAvailable = (model: AgentModel, models: ModelsConfig) => models[model.source].enabled;

/** The language-model setting that runs an agent's model: the runtime path is decided here, per source. */
export function llmConfigFor(model: AgentModel, models: ModelsConfig, base: AIConfig['llm'] = effectiveConfig().llm): AIConfig['llm'] {
  switch (model.source) {
    case 'local':
      return { ...base, provider: 'ollama', apiUrl: models.local.apiUrl, model: model.model };
    case 'kaggle':
      return { ...base, provider: 'vllm', apiUrl: `${bridge()}/vllm`, model: model.model };
    case 'openrouter':
      return { ...base, provider: 'openrouter', apiUrl: `${bridge()}/openrouter/api`, model: model.model };
  }
}

/**
 * What every agent runs on now. The master: the main language model, exactly as configured (a custom runtime
 * set by environment or by voice included). A specialist: its own model when its source is on, else the
 * master's.
 */
export function resolveAgentLlms(): Record<AgentKey, AIConfig['llm']> {
  const main = effectiveConfig().llm;
  const models = getModelsConfig();
  const saved = getAIOverride().agents ?? {};
  const own = (name: Exclude<AgentKey, 'master'>) => {
    const model = saved[name] && current(saved[name]!);
    return model && isAvailable(model, models) ? llmConfigFor(model, models, main) : main;
  };
  return { master: main, planning: own('planning'), safety: own('safety'), ...Object.fromEntries(AGENT_NAMES.map((name) => [name, own(name)])) } as Record<AgentKey, AIConfig['llm']>;
}

/** The bridge's name for where the main model runs. */
export const computeModeOf = (source: ModelSource) => (source === 'kaggle' ? 'remote' : source === 'openrouter' ? 'openrouter' : 'local') as 'local' | 'remote' | 'openrouter';

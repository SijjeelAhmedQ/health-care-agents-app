/**
 * The assistant's configuration.
 *
 * Speech is transcribed by Omi Med STT, streamed live over the bridge's
 * WebSocket; every decision about what to do is made by the local model
 * through tool calling. There is no rule-based path.
 *
 * Environment variables give the defaults. The Configuration page saves the
 * provider's choices on top of them (model runtime, model, performance knobs,
 * bridge address) in this browser; the Omi Med STT model, backend and timings
 * are saved by the bridge itself (python/stt_settings.json).
 */
import type { AgentName } from '@/types/ai';

/**
 * Where the language model runs — the one switch that decides the runtime path. Every agent (the single
 * assistant, the master, the specialists) talks to it through the same ChatLLM interface
 * (providers/llm.ts) and never knows which one answers.
 *
 *   ollama             This Computer: the local Ollama — the ONLY provider that uses Ollama
 *   vllm               a vLLM server's OpenAI-compatible API (your own, or the Kaggle notebook's through the bridge)
 *   openrouter         OpenRouter's API, through the bridge (which holds the key)
 *   openai-compatible  any other OpenAI-compatible server (llama.cpp, LM Studio, mlx_lm.server)
 *   bridge             the Python bridge's own runtime on this computer (python/.env)
 */
export type LLMProviderKind = 'ollama' | 'vllm' | 'openrouter' | 'openai-compatible' | 'bridge';

export const LLM_PROVIDERS: readonly LLMProviderKind[] = ['ollama', 'vllm', 'openrouter', 'openai-compatible', 'bridge'];

export interface AIConfig {
  stt: {
    /** WebSocket of the bridge's streaming endpoint. */
    wsUrl: string;
  };
  llm: {
    provider: LLMProviderKind;
    apiUrl: string;
    model: string;
    timeoutMs: number;
    /** Layers offloaded to the GPU (99 = all). Without it Ollama may split the model and run 3× slower. */
    numGpu: number;
    /** Context window: the system prompt with every tool schema, the conversation and tool results. */
    numCtx: number;
    /** Most model calls one utterance may take (tool call → result → next tool …). */
    maxSteps: number;
    /** Split a long request into its actions first, then carry them out one by one (on unless turned off). */
    planSteps?: boolean;
    /**
     * Multi-agent mode: a master agent gives each request to five specialist agents as a task graph. Off:
     * the single assistant. Both use the same tools, runtime, validation and confirmations.
     */
    multiAgent?: boolean;
    /** Multi-agent mode: independent read-only tasks run together (on unless turned off). */
    parallelReads?: boolean;
    /**
     * The Safety Agent: a value the provider did not say never reaches the application — removed, corrected
     * from their words, or asked for (on unless turned off). Every mode.
     */
    safety?: boolean;
    /** Multi-agent mode: the Planning Agent gathers what an action needs, and asks for what is missing, before it runs (on unless turned off). */
    planning?: boolean;
  };
  enableVoice: boolean;
  enableDebugPanel: boolean;
  appName: string;
}

const env = import.meta.env;
const bool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === 'true' || v === '1');
const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Models that carry out a long request better in one go than split into steps first. Measured with the
 * care-plan benchmark (src/services/ai/__evals__/carePlanBench.eval.ts) on the Kaggle GPU: qwen3.5:9b took
 * 111–173 s and 19–21 model calls with steps, 47–62 s and 6–8 calls without — and got more of it right.
 * (qwen3.5:4b did not: it gets doses wrong without steps.) Every other model plans as before.
 */
export const ONE_GO_MODELS: ReadonlySet<string> = new Set(['qwen3.5:9b']);

/**
 * A model's name as the rules above know it, whichever runtime serves this build: Ollama's tag
 * ("qwen3.5:9b"), or the Hugging Face repository vLLM serves by default ("Qwen/Qwen3.5-9B",
 * "Qwen/Qwen3.5-9B-AWQ"). Other providers' models of the same name (OpenRouter's "qwen/qwen3.5-9b") are
 * other builds the rules were not measured on, and keep their own name.
 */
export function canonicalModel(name: string): string {
  const hf = name.match(/^Qwen\/Qwen3\.5-(\d+(?:\.\d+)?)B(?:[-_][\w.-]+)?$/);
  return hf ? `qwen3.5:${hf[1].toLowerCase()}b` : name;
}

/** Whether the model does a long request better in one go (see ONE_GO_MODELS), under any runtime's name. */
export const isOneGoModel = (model: string) => ONE_GO_MODELS.has(canonicalModel(model));

/** Whether a long request is split into steps first, for this model and setting. */
export const plansLongRequests = (llm: Pick<AIConfig['llm'], 'model' | 'planSteps'>) => llm.planSteps !== false && !isOneGoModel(llm.model);

/**
 * The saved language-model settings in today's terms. Settings saved by earlier versions named OpenRouter
 * "openai-compatible" at the bridge's /openrouter proxy, and the Kaggle GPU "ollama" at its /ollama proxy
 * (Kaggle now serves the model with vLLM). A provider this version does not know is kept as it is —
 * createChatLLM then says so rather than quietly falling back to Ollama.
 */
export function normalizeLlm(llm: AIConfig['llm']): AIConfig['llm'] {
  const url = llm.apiUrl.replace(/\/+$/, '');
  if (llm.provider === 'openai-compatible' && url.endsWith('/openrouter/api')) return { ...llm, provider: 'openrouter' };
  if (llm.provider === 'ollama' && url.endsWith('/ollama') && !/:11434$/.test(url)) return { ...llm, provider: 'vllm', apiUrl: url.replace(/\/ollama$/, '/vllm') };
  return llm;
}

/** The defaults, from the environment. */
export const aiConfig: AIConfig = {
  stt: {
    wsUrl: env.VITE_STT_WS_URL || 'ws://127.0.0.1:8765/ws/stt',
  },
  llm: {
    provider: (env.VITE_LLM_PROVIDER as LLMProviderKind) || 'ollama',
    apiUrl: env.VITE_LLM_API_URL || 'http://127.0.0.1:11434',
    model: env.VITE_LLM_MODEL || 'qwen3.5:4b',
    timeoutMs: num(env.VITE_LLM_TIMEOUT_MS, 90000),
    numGpu: num(env.VITE_LLM_NUM_GPU, 99),
    numCtx: num(env.VITE_LLM_NUM_CTX, 12288),
    maxSteps: num(env.VITE_AGENT_MAX_STEPS, 8),
    planSteps: bool(env.VITE_AGENT_PLAN_STEPS, true),
    multiAgent: bool(env.VITE_AGENT_MULTI, false),
    parallelReads: bool(env.VITE_AGENT_PARALLEL_READS, true),
    safety: bool(env.VITE_AGENT_SAFETY, true),
    planning: bool(env.VITE_AGENT_PLANNING, true),
  },
  enableVoice: bool(env.VITE_ENABLE_VOICE, true),
  enableDebugPanel: bool(env.VITE_ENABLE_DEBUG_PANEL, true),
  appName: env.VITE_APP_NAME || 'CareFlow PMS',
};

// ---------------------------------------------------------------------------------- models and agents

/** Where a language model can run: This Computer (Ollama), the Kaggle GPU (vLLM), OpenRouter. */
export type ModelSource = 'local' | 'kaggle' | 'openrouter';
export const MODEL_SOURCES: readonly ModelSource[] = ['local', 'kaggle', 'openrouter'];

/** The microphone's speech recognition: one at a time — this computer's Omi, or Whisper / Omi on Kaggle. */
export type SpeechChoice = 'local-omi' | 'kaggle-whisper' | 'kaggle-omi';

/**
 * MODEL CONFIGURATION — where models can run, and which. Any of the three may be on; the models of the ones
 * that are become available to the agents. (Keys and the Kaggle address are kept by the bridge.)
 */
export interface ModelsConfig {
  local: { enabled: boolean; model: string; apiUrl: string };
  kaggle: { enabled: boolean; model: string };
  openrouter: { enabled: boolean; model: string };
  speech: SpeechChoice;
}

/** Every agent that thinks with a model: the master (also the single assistant), the Planning Agent, the five specialists and the Safety Agent (its reviewer). */
export type AgentKey = 'master' | 'planning' | 'safety' | AgentName;

/** One agent's model: where it runs and which. */
export interface AgentModel {
  source: ModelSource;
  model: string;
}

/**
 * AGENT CONFIGURATION — which of the available models each agent uses. Independent per agent: any agent
 * may use any enabled source.
 */
export type AgentModels = Record<AgentKey, AgentModel>;

/** What the Configuration page saved in this browser, on top of the defaults. */
export interface AIOverride {
  llm?: Partial<AIConfig['llm']>;
  stt?: Partial<AIConfig['stt']>;
  models?: ModelsConfig;
  agents?: Partial<AgentModels>;
}

const OVERRIDE_KEY = 'careflow.ai.config';

export function getAIOverride(): AIOverride {
  try {
    const parsed = JSON.parse(localStorage.getItem(OVERRIDE_KEY) ?? '{}') as AIOverride;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function setAIOverride(override: AIOverride) {
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(override));
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

export function clearAIOverride() {
  try {
    localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function effectiveConfig(): AIConfig {
  const o = getAIOverride();
  return { ...aiConfig, llm: normalizeLlm({ ...aiConfig.llm, ...o.llm }), stt: { ...aiConfig.stt, ...o.stt } };
}

/** The bridge's HTTP address, from its streaming WebSocket address (ws://host:port/ws/stt → http://host:port). */
export function bridgeHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/stt\/?$/, '');
}

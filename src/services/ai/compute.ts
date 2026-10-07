/**
 * Where the AI can run — the bridge's side of Configuration → Models. Any of three providers may be on at
 * once, and each agent picks its model from the ones that are (Configuration → Agents):
 *
 *   local       This Computer: Qwen in the local Ollama (the only use of Ollama) + Omi Med STT on this CPU
 *   kaggle      the Kaggle GPU (python/kaggle/careflow_gpu_server.py): Qwen 4B / 9B served by vLLM, and
 *               Whisper or Omi Med STT
 *   openrouter  a cloud model on OpenRouter (no speech recognition: the microphone is heard on Kaggle)
 *
 * The bridge moves speech recognition and forwards the language models — `/vllm` to Kaggle, `/openrouter`
 * to OpenRouter (the bridge adds the keys; the browser never holds them). This computer's Ollama is called
 * directly.
 */
import { bridgeHttpUrl, effectiveConfig, type ModelSource } from './config';

/** Where the language model runs: this computer, the Kaggle GPU, or OpenRouter. */
export type ComputeMode = 'local' | 'remote' | 'openrouter';
/** Where speech recognition runs: this computer, or the Kaggle GPU (Whisper / Omi there). */
export type SpeechPlace = 'local' | 'remote';
export type RemoteSpeech = 'whisper' | 'omi';

/** The language models the Kaggle notebook serves (Ollama): each agent picks one in Configuration → Agents. */
export const REMOTE_LLMS = [
  { name: 'qwen3.5:9b', hint: 'tool calling — every agent' },
  { name: 'ternary-bonsai-2-27b', hint: 'Ternary Bonsai 2 27B — summaries (T4 x2, PrismML llama-server)' },
  { name: 'hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M', hint: 'MedGemma 4B — medical text, no tool calling' },
  { name: 'hf.co/mradermacher/Qwen3Guard-Gen-4B-GGUF:Q4_K_M', hint: 'Qwen3Guard 4B — safety classifier, no tool calling' },
] as const;

/**
 * The GPT models offered on OpenRouter — all call tools, which the assistant needs. GPT-6 Sol is the
 * default: the strongest of the three at a price that suits one call per step of every request.
 */
export const OPENROUTER_LLMS = [
  { name: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', hint: 'the default — fast, cheap, calls tools' },
  { name: 'openai/gpt-6-sol', label: 'GPT-6 Sol', hint: 'recommended — accurate with many tools and long requests · $2 / $10 per million tokens' },
  { name: 'openai/gpt-6-luna', label: 'GPT-6 Luna', hint: 'fastest and cheapest · $0.10 / $0.50 per million tokens' },
  { name: 'openai/gpt-6-astra', label: 'GPT-6 Astra', hint: 'the most capable, and the most expensive · $10 / $50 per million tokens' },
] as const;
export const DEFAULT_OPENROUTER_LLM = OPENROUTER_LLMS[0].name;

/** One OpenRouter model that can call tools, as the Configuration list shows it. */
export interface OpenRouterModel {
  id: string;
  name: string;
  /** US dollars per million prompt / completion tokens. */
  promptPerM: number;
  completionPerM: number;
  context: number;
  /** Why CareFlow recommends it (only for the picks at the top). */
  note?: string;
}

/**
 * CareFlow's picks, best first for this app (many tools, multi-step and multi-patient requests, clinical
 * wording): GPT first — the requirement — then the other strongest tool-callers. Every other model that
 * calls tools follows, newest first.
 */
const RECOMMENDED: Array<{ id: string; note: string }> = [
  { id: 'openai/gpt-6-sol', note: 'recommended — accurate with many tools and long requests' },
  { id: 'openai/gpt-6-astra', note: 'the most capable GPT — the most expensive' },
  { id: 'openai/gpt-6-luna', note: 'fastest and cheapest GPT' },
  { id: 'openai/gpt-6-sol-pro', note: 'GPT-6 Sol, thinks longer — slower' },
  { id: 'anthropic/claude-sonnet-5.5', note: 'very strong at tool use' },
  { id: 'anthropic/claude-opus-5.5', note: 'strongest Claude — expensive' },
  { id: 'google/gemini-3.8-flash', note: 'fast, long context' },
  { id: 'x-ai/grok-4.7', note: 'strong reasoning' },
  { id: 'qwen/qwen3.8-max-0902', note: 'largest Qwen' },
  { id: 'deepseek/deepseek-v4.1-flash', note: 'low cost' },
];

/**
 * Every OpenRouter model that can call tools (the assistant needs that), recommended ones first. Read live
 * through the bridge, so a model OpenRouter adds shows up by itself. Batch variants are left out: the
 * assistant needs an answer now.
 */
export async function listOpenRouterModels(): Promise<OpenRouterModel[]> {
  // Through the bridge; the list is public, so straight from OpenRouter when the bridge cannot give it.
  let res = await fetch(`${bridge()}/openrouter/api/v1/models`).catch(() => null);
  if (!res?.ok) res = await fetch('https://openrouter.ai/api/v1/models').catch(() => null);
  if (!res?.ok) throw new Error(`OpenRouter's model list is not available${res ? ` (${res.status})` : ' — check the internet connection'}`);
  const data = ((await res.json()) as { data?: Array<{ id: string; name?: string; created?: number; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }> }).data ?? [];
  const usable = data.filter((m) => (m.supported_parameters ?? []).includes('tools') && !m.id.endsWith(':batch'));
  const toModel = (m: (typeof usable)[number], note?: string): OpenRouterModel => ({
    id: m.id,
    name: m.name?.replace(/^[^:]+:\s*/, '') || m.id,
    promptPerM: Number(m.pricing?.prompt ?? 0) * 1e6,
    completionPerM: Number(m.pricing?.completion ?? 0) * 1e6,
    context: m.context_length ?? 0,
    note,
  });
  const picks = RECOMMENDED.flatMap((r) => usable.filter((m) => m.id === r.id).map((m) => toModel(m, r.note)));
  const rest = usable
    .filter((m) => !RECOMMENDED.some((r) => r.id === m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => toModel(m));
  return [...picks, ...rest];
}

/** The Kaggle server's language model runtime: vLLM and the model names it serves. */
export interface RemoteLlm {
  ok: boolean;
  engine?: string;
  models?: string[];
  error?: string;
}

/** What the remote server serves (`ollama`: a server from before vLLM — the bridge no longer uses it). */
export const remoteLlmOf = (remote: ComputeStatus['remote'] | undefined): RemoteLlm | undefined => remote?.llm;

export interface ComputeStatus {
  mode: ComputeMode;
  /** Where speech recognition runs (a bridge from before this setting leaves it out). */
  speech?: SpeechPlace;
  remote_url: string;
  /** The speech model on the remote server: whisper (best with non-US accents) or omi. */
  remote_engine?: RemoteSpeech;
  has_key: boolean;
  /** The providers that are on (a bridge from before they could be combined leaves it out). */
  providers?: ModelSource[];
  remote: { ok?: boolean; error?: string; model?: string; device?: string; gpu?: string | null; engines?: Record<string, { model: string; device: string }>; llm?: RemoteLlm; ollama?: RemoteLlm } | null;
  /** An OpenRouter key is saved in the bridge (the key itself never comes back). */
  has_openrouter_key?: boolean;
  openrouter_model?: string;
  openrouter?: { ok?: boolean; error?: string; label?: string | null; usage?: number | null; limit?: number | null; limit_remaining?: number | null } | null;
  stt: { engine: string; ready: boolean; error?: string | null };
}

const trimSlash = (u: string) => u.replace(/\/$/, '');

async function call(url: string, init?: RequestInit): Promise<ComputeStatus> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(`Cannot reach the bridge at ${url}. Start it with "npm run bridge".`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `The bridge responded ${res.status}`);
  }
  return (await res.json()) as ComputeStatus;
}

const bridge = () => trimSlash(bridgeHttpUrl(effectiveConfig().stt.wsUrl));

export const getCompute = () => call(`${bridge()}/api/config/compute`);

export type KaggleHealth = NonNullable<ComputeStatus['remote']>;

/** Is the Kaggle server there, and what does it run? Nothing is switched. An empty key means the saved one. */
export async function checkKaggle(url: string, key: string): Promise<KaggleHealth> {
  const res = await fetch(`${bridge()}/api/config/compute/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remote_url: url, remote_key: key }) }).catch(() => null);
  if (!res) return { ok: false, error: 'Cannot reach the bridge. Start it with "npm run bridge".' };
  if (res.status === 404) return { ok: false, error: 'The bridge is out of date — restart it ("npm run bridge").' };
  return (await res.json()) as KaggleHealth;
}

/** What the bridge is told when the Models configuration is applied. Empty keys keep the saved ones. */
export interface ModelSetup {
  /** Where the MAIN model runs (the master agent's): local | remote (Kaggle) | openrouter. */
  mode: ComputeMode;
  /** Every provider that is on: its models are offered to the agents, and the bridge forwards to it. */
  providers: ModelSource[];
  /** Where the microphone is heard: this computer, or the Kaggle server. */
  speech: SpeechPlace;
  remote_url: string;
  remote_key: string;
  remote_engine: RemoteSpeech;
  openrouter_key: string;
  openrouter_model: string;
}

/**
 * Apply the Models configuration on the bridge. It checks every part first — the Kaggle server (and its
 * vLLM, when Kaggle's Qwen is on), the OpenRouter key — and changes nothing unless all of it holds.
 */
export const saveModelSetup = (setup: ModelSetup) =>
  call(`${bridge()}/api/config/compute`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setup) });

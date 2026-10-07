/**
 * The models a runtime has, read live from the runtime itself — so a model
 * pulled with `ollama pull` appears as soon as the list is refreshed.
 */
import { z } from 'zod';
import type { AIConfig, LLMProviderKind } from './config';
import { createChatLLM } from './providers/llm';
import { defineTool, toToolSchema } from './agent/tool';

export interface ModelInfo {
  name: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  /** Can call tools (the assistant needs it). null = the runtime does not say. */
  tools: boolean | null;
}

interface OllamaTag {
  name: string;
  size?: number;
  modified_at?: string;
  capabilities?: string[];
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

const trimSlash = (u: string) => u.replace(/\/$/, '');

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${url} did not answer`);
    throw new Error(`Cannot reach ${url}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

const fromOllama = (m: OllamaTag): ModelInfo => ({
  name: m.name,
  family: m.details?.family,
  parameterSize: m.details?.parameter_size,
  quantization: m.details?.quantization_level,
  sizeBytes: m.size,
  modifiedAt: m.modified_at,
  tools: m.capabilities ? m.capabilities.includes('tools') : null,
});

export async function listModels(provider: LLMProviderKind, apiUrl: string): Promise<ModelInfo[]> {
  const base = trimSlash(apiUrl);
  let models: ModelInfo[];
  if (provider === 'ollama') {
    const data = await getJson<{ models?: OllamaTag[] }>(`${base}/api/tags`);
    models = (data.models ?? []).map(fromOllama);
  } else if (provider === 'bridge') {
    const data = await getJson<{ models?: OllamaTag[] }>(`${base}/api/llm/models`);
    models = (data.models ?? []).map(fromOllama);
  } else {
    const data = await getJson<{ data?: Array<{ id: string }> }>(`${base}/v1/models`);
    models = (data.data ?? []).map((m) => ({ name: m.id, tools: null }));
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

/** Free the GPU memory a model holds (Ollama). Loading a new model on a small card needs the room. */
export async function unloadOllamaModel(apiUrl: string, model: string) {
  try {
    await fetch(`${trimSlash(apiUrl)}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) });
  } catch {
    /* nothing to free, or the runtime is down */
  }
}

export interface ModelTestResult {
  ok: boolean;
  /** The model answered with a tool call — the assistant can work with it. */
  toolCalling: boolean;
  ms: number;
  detail: string;
}

/**
 * A real request with one small tool: proves the model loads, answers and calls tools. `tools: false` — an agent
 * that only writes (the Summary Agent): a short summary to write, no tools offered; it must answer.
 */
export async function testModel(llm: AIConfig['llm'], opts: { tools?: boolean } = {}): Promise<ModelTestResult> {
  if (opts.tools === false) {
    const chat = createChatLLM({ ...llm, timeoutMs: Math.max(llm.timeoutMs, 300000) });
    const started = Date.now();
    try {
      const turn = await chat.chat([{ role: 'system', content: 'Summarize the data in one sentence.' }, { role: 'user', content: 'DATA\n- Lipid panel — Tom Baker (Normal)\n- HbA1c 8.1% — Chloe Bell (Abnormal)' }], [], { maxTokens: 96 });
      const ms = Date.now() - started;
      const text = turn.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      return text ? { ok: true, toolCalling: false, ms, detail: `Wrote: “${text.slice(0, 140)}”` } : { ok: false, toolCalling: false, ms, detail: 'Answered with nothing.' };
    } catch (e) {
      return { ok: false, toolCalling: false, ms: Date.now() - started, detail: (e as Error).message };
    } finally {
      chat.dispose?.();
    }
  }
  const probe = defineTool({
    name: 'open_page',
    description: 'Open a page of the app.',
    parameters: z.object({ page: z.enum(['dashboard', 'patients', 'inbox']) }),
    run: async () => ({ ok: true, message: '' }),
  });
  const chat = createChatLLM({ ...llm, timeoutMs: Math.max(llm.timeoutMs, 300000) });
  const started = Date.now();
  try {
    const turn = await chat.chat([{ role: 'system', content: 'You operate an app by calling tools.' }, { role: 'user', content: 'Open the dashboard.' }], [toToolSchema(probe)], { maxTokens: 128 });
    const call = turn.toolCalls.find((c) => c.name === 'open_page');
    const ms = Date.now() - started;
    if (call) return { ok: true, toolCalling: true, ms, detail: `Called open_page(${JSON.stringify(call.arguments)}).` };
    return { ok: true, toolCalling: false, ms, detail: `Answered without calling a tool${turn.content ? `: “${turn.content.slice(0, 120)}”` : ''}. The assistant needs a model that calls tools.` };
  } catch (e) {
    return { ok: false, toolCalling: false, ms: Date.now() - started, detail: (e as Error).message };
  } finally {
    chat.dispose?.();
  }
}

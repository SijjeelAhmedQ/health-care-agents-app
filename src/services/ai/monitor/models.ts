/**
 * Which model and provider each agent runs on, as the monitoring screen names them — from the same
 * settings the agents were built from (agentModels.ts), so a change applied on the Configuration page shows
 * here as soon as the agents are rebuilt.
 */
import type { AgentModelInfo, MonitorAgentKey } from '@/types/monitor';
import type { AIConfig } from '../config';
import { getModelsConfig, SOURCE_LABELS, SPEECH_LABELS, sourceOfLlm } from '../agentModels';

/** "ollama:qwen3.5:4b" → { provider: 'ollama', model: 'qwen3.5:4b' }. */
function split(name: string): AgentModelInfo {
  const at = name.indexOf(':');
  return at > 0 ? { provider: name.slice(0, at), model: name.slice(at + 1) } : { provider: name, model: name };
}

/**
 * Each agent's model. `configs`: the language-model settings the agents were built from (null when a model
 * was swapped in directly, as in tests — then the runtime's own name is all there is).
 */
export function agentModelInfo(names: Partial<Record<MonitorAgentKey, string>>, configs: Partial<Record<MonitorAgentKey, AIConfig['llm']>> | null): Partial<Record<MonitorAgentKey, AgentModelInfo>> {
  const out: Partial<Record<MonitorAgentKey, AgentModelInfo>> = {};
  for (const [agent, name] of Object.entries(names) as Array<[MonitorAgentKey, string]>) {
    const config = configs?.[agent];
    if (!config) {
      out[agent] = split(name);
      continue;
    }
    const source = sourceOfLlm(config);
    out[agent] = { model: config.model, provider: source ? SOURCE_LABELS[source] : config.provider };
  }
  return out;
}

/** The speech model the microphone is heard with. */
export function speechInfo(runtimeName?: string): AgentModelInfo {
  try {
    const label = SPEECH_LABELS[getModelsConfig().speech];
    if (label) return { model: label.title, provider: label.where };
  } catch {
    // no saved configuration: fall back to the runtime's name
  }
  return { model: runtimeName ?? 'speech', provider: '—' };
}

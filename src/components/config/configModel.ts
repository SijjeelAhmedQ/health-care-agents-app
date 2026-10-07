/**
 * The Configuration page's draft, and what can be said about it without rendering anything: which agents
 * there are, what each source offers, what changed since the last Apply, and what would stop an Apply.
 *
 * The page holds a DRAFT. Nothing reaches the assistant until Apply — a switch that silently repointed six
 * running agents the moment it was touched would be the wrong control for this job.
 */
import type { AgentKey, AgentModel, AgentModels, AIConfig, ModelsConfig, ModelSource, SpeechChoice } from '@/services/ai/config';
import { AGENT_KEYS, KAGGLE_MODEL_INFO, PROVIDER_DEFAULTS, SOURCE_LABELS, SPEECH_LABELS } from '@/services/ai/agentModels';

export interface Draft {
  models: ModelsConfig;
  agents: AgentModels;
  multiAgent: boolean;
  parallelReads: boolean;
  planSteps: boolean;
  /** The Safety Agent (every mode) and the Planning Agent (multi-agent mode). */
  safety: boolean;
  planning: boolean;
  perf: Pick<AIConfig['llm'], 'numCtx' | 'numGpu' | 'timeoutMs' | 'maxSteps'>;
  /** The Kaggle server's address, and a new key ('' keeps the one the bridge holds). */
  kaggleUrl: string;
  kaggleKey: string;
  /** A new OpenRouter key ('' keeps the one the bridge holds). */
  openrouterKey: string;
}

export const AGENT_META: Record<AgentKey, { title: string; role: string; examples: string }> = {
  master: { title: 'Master Agent', role: 'Understands each request, plans it as tasks and hands them out. In single-agent mode it is the whole assistant.', examples: 'Routing · planning · combining results' },
  planning: { title: 'Planning Agent', role: 'Works out what each action needs, and asks for what is missing before anything runs — never fills it in itself.', examples: '“Select patient” → “Which patient?”' },
  safety: { title: 'Safety Agent', role: 'Checks every value against what you said — rules on every call; its model reviews the risky ones (changes, several records, “not …”).', examples: '“Add medication” → never a made-up drug or dose' },
  patients: { title: 'Patients Agent', role: 'Finds, selects, adds, edits and deletes patients.', examples: '“Find John Ahmed” · “Add a new patient”' },
  dashboard: { title: 'Dashboard Agent', role: 'Questions about your own day: workload, next appointment, tasks and recalls due.', examples: '“How busy am I today?”' },
  appointments: { title: 'My Appointment Agent', role: 'Your own appointments — list, search, move and cancel.', examples: '“Cancel my 3 PM”' },
  patient_appointments: { title: 'Appointments Agent', role: 'Patients’ appointments — book, change, move, cancel, delete, search.', examples: '“Book John a follow-up on Monday”' },
  medications: { title: 'Medication Agent', role: 'A patient’s medications — add, update, delete, search, get.', examples: '“Add metformin 500 mg”' },
  diagnoses: { title: 'Diagnoses Agent', role: 'A patient’s diagnoses — add, update, delete, search, get.', examples: '“Add type 2 diabetes”' },
  tasks: { title: 'Tasks Agent', role: 'A patient’s tasks — add, update, delete, search, get.', examples: '“Create a task for BP monitoring”' },
  recalls: { title: 'Recalls Agent', role: 'A patient’s recalls — add, update, delete, search, get.', examples: '“Recall him in 3 months”' },
  notes: { title: 'Notes Agent', role: 'Dictated clinical notes, and the items the AI Summary extracts from them.', examples: '“Take a note…”' },
  inbox: { title: 'Inbox Agent', role: 'Lab, radiology, referrals and discharge summaries — open, file, comment.', examples: '“Open John’s latest lab”' },
  summary: { title: 'Summary Agent', role: 'Every summary — dashboard, Inbox, any page, a patient’s chart. Writes only (no tools): MedGemma suits it.', examples: '“Summarize all normal Inbox records”' },
};

/** The order the page shows the agents in, as a request flows: master, planning, the specialists (as the sidebar has them), safety. */
export const AGENT_ORDER: readonly AgentKey[] = [
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
];

/** The agents that can be switched off — and the draft's switch for each. */
export const SWITCHABLE: Partial<Record<AgentKey, 'planning' | 'safety'>> = { planning: 'planning', safety: 'safety' };

/** Whether an agent takes part in requests with these settings (the master always). */
export function agentRuns(key: AgentKey, d: Pick<Draft, 'multiAgent' | 'planning' | 'safety'>): boolean {
  if (key === 'master') return true;
  if (key === 'safety') return d.safety; // every mode
  if (key === 'planning') return d.multiAgent && d.planning;
  return d.multiAgent;
}

export const SOURCE_META: Record<ModelSource, { title: string; tagline: string }> = {
  local: { title: SOURCE_LABELS.local, tagline: 'Private and offline — this computer’s GPU and CPU' },
  kaggle: { title: SOURCE_LABELS.kaggle, tagline: 'A free T4 GPU in your Kaggle notebook — Qwen on vLLM' },
  openrouter: { title: SOURCE_LABELS.openrouter, tagline: 'Any tool-calling cloud model, paid per use' },
};

/** A model name as a person reads it: "qwen3.5:9b" → "Qwen3.5 9B", "openai/gpt-6-sol" → "gpt-6-sol". */
export function shortModel(model: string): string {
  if (KAGGLE_MODEL_INFO[model]) return KAGGLE_MODEL_INFO[model].label;
  const qwen = model.match(/^qwen3\.5:(\d+(?:\.\d+)?)b$/i);
  if (qwen) return `Qwen3.5 ${qwen[1]}B`;
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
}

export const sameModel = (a: AgentModel, b: AgentModel) => a.source === b.source && a.model === b.model;

/** The sources that are on, in the page's order. */
export const enabledSources = (models: ModelsConfig): ModelSource[] => (['local', 'kaggle', 'openrouter'] as const).filter((s) => models[s].enabled);

/** A source's default model — what an agent gets when it is moved there. */
export const defaultModelOf = (models: ModelsConfig, source: ModelSource) => models[source].model;

/**
 * The microphone choices with these sources on: omi-med-stt-v1 on This Computer, Whisper or omi-med-stt-v1 on
 * Kaggle. OpenRouter has no speech recognition — on its own it offers none (and cannot be applied).
 */
export function speechChoices(models: ModelsConfig): SpeechChoice[] {
  return (['local-omi', 'kaggle-whisper', 'kaggle-omi'] as const).filter((c) => (c === 'local-omi' ? models.local.enabled : models.kaggle.enabled));
}

/** The source an agent moves to when its own is switched off: the first one on, Kaggle first. */
const fallbackSource = (models: ModelsConfig): ModelSource | null => (['kaggle', 'local', 'openrouter'] as const).find((s) => models[s].enabled) ?? null;

/**
 * A provider switched on: every agent runs on its default model (Kaggle Qwen3.5 9B, This Computer Qwen3.5 4B,
 * OpenRouter DeepSeek V4.1 Flash) and the microphone on its default — OpenRouter, having none, hears on This
 * Computer (omi-med-stt-v1), or on Kaggle when only that is on.
 * Switched off: the agents on it move to another provider that is on; the microphone too, if it was there.
 */
export function switchProvider(draft: Draft, source: ModelSource, on: boolean): Draft {
  const models = { ...draft.models, [source]: { ...draft.models[source], enabled: on, ...(on ? { model: PROVIDER_DEFAULTS[source].model } : {}) } } as ModelsConfig;
  let agents = draft.agents;
  if (on) {
    agents = Object.fromEntries(Object.keys(draft.agents).map((k) => [k, { source, model: PROVIDER_DEFAULTS[source].agents?.[k as AgentKey] ?? PROVIDER_DEFAULTS[source].model }])) as Draft['agents'];
    const wanted = PROVIDER_DEFAULTS[source].speech;
    const choices = speechChoices(models);
    models.speech = choices.includes(wanted) ? wanted : choices.includes(models.speech) ? models.speech : (choices[0] ?? models.speech);
  } else {
    const to = fallbackSource(models);
    if (to) agents = Object.fromEntries(Object.entries(draft.agents).map(([k, m]) => [k, m.source === source ? { source: to, model: models[to].model } : m])) as Draft['agents'];
    const choices = speechChoices(models);
    if (!choices.includes(models.speech)) models.speech = choices[0] ?? models.speech;
  }
  return { ...draft, models, agents };
}

/** The page's tabs. */
export type ConfigTab = 'models' | 'agents' | 'advanced';

/** A changed line of the draft, and the tab it was made on. */
export interface Change {
  key: string;
  text: string;
  tab: ConfigTab;
}

/** Something that stops an Apply, and the tab where it is put right. */
export interface Problem {
  text: string;
  tab: ConfigTab;
}

/** What Apply would change, in words — the dock lists them. */
export function changesBetween(saved: Draft, draft: Draft): Change[] {
  const out: Change[] = [];
  for (const source of ['local', 'kaggle', 'openrouter'] as const) {
    const a = saved.models[source];
    const b = draft.models[source];
    if (a.enabled !== b.enabled) out.push({ key: `on-${source}`, text: `${SOURCE_LABELS[source]} ${b.enabled ? 'on' : 'off'}`, tab: 'models' });
    else if (b.enabled && a.model !== b.model) out.push({ key: `model-${source}`, text: `${SOURCE_LABELS[source]} default → ${shortModel(b.model)}`, tab: 'models' });
  }
  if (saved.models.speech !== draft.models.speech) out.push({ key: 'speech', text: `Microphone → ${SPEECH_LABELS[draft.models.speech].title} · ${SPEECH_LABELS[draft.models.speech].where}`, tab: 'agents' });
  if (saved.kaggleUrl !== draft.kaggleUrl) out.push({ key: 'kaggle-url', text: 'Kaggle server address', tab: 'models' });
  if (draft.kaggleKey.trim()) out.push({ key: 'kaggle-key', text: 'New Kaggle key', tab: 'models' });
  if (draft.openrouterKey.trim()) out.push({ key: 'or-key', text: 'New OpenRouter key', tab: 'models' });
  for (const key of AGENT_KEYS) {
    if (!sameModel(saved.agents[key], draft.agents[key])) out.push({ key: `agent-${key}`, text: `${AGENT_META[key].title} → ${SOURCE_LABELS[draft.agents[key].source]} · ${shortModel(draft.agents[key].model)}`, tab: 'agents' });
  }
  if (saved.multiAgent !== draft.multiAgent) out.push({ key: 'multi', text: `Multi-agent mode ${draft.multiAgent ? 'on' : 'off'}`, tab: 'agents' });
  if (saved.parallelReads !== draft.parallelReads) out.push({ key: 'parallel', text: `Parallel tasks ${draft.parallelReads ? 'on' : 'off'}`, tab: 'agents' });
  if (saved.planSteps !== draft.planSteps) out.push({ key: 'plan', text: `Step planning ${draft.planSteps ? 'on' : 'off'}`, tab: 'agents' });
  if (saved.safety !== draft.safety) out.push({ key: 'safety', text: `Safety Agent ${draft.safety ? 'on' : 'off'}`, tab: 'agents' });
  if (saved.planning !== draft.planning) out.push({ key: 'planning', text: `Planning Agent ${draft.planning ? 'on' : 'off'}`, tab: 'agents' });
  if (JSON.stringify(saved.perf) !== JSON.stringify(draft.perf)) out.push({ key: 'perf', text: 'Performance settings', tab: 'advanced' });
  return out;
}

/** What stops an Apply, as the provider would put it right — and on which tab. */
export function problemsOf(draft: Draft, bridge: { hasKaggleKey: boolean; hasOpenRouterKey: boolean }): Problem[] {
  const problems: Problem[] = [];
  const models = (text: string) => problems.push({ text, tab: 'models' });
  const on = enabledSources(draft.models);
  if (!on.length) models('Switch on at least one of This Computer, Kaggle or OpenRouter.');
  // An agent switched off (Planning, Safety) runs on nothing: its model's provider being off stops nothing.
  const off = AGENT_KEYS.filter((k) => !(SWITCHABLE[k] && !draft[SWITCHABLE[k]!]) && !draft.models[draft.agents[k].source].enabled);
  if (off.length) problems.push({ text: `${off.map((k) => AGENT_META[k].title).join(', ')} ${off.length === 1 ? 'uses' : 'use'} a model whose provider is off — pick another.`, tab: 'agents' });
  // The app is voice-first: a microphone model is a must. OpenRouter has none.
  if (!speechChoices(draft.models).length) {
    if (on.length) models('No microphone model: OpenRouter has no speech recognition. Switch on This Computer (omi-med-stt-v1) or Kaggle (Whisper large-v3-turbo).');
  } else if (!speechChoices(draft.models).includes(draft.models.speech)) problems.push({ text: 'Choose the microphone model in Agents → Microphone.', tab: 'agents' });
  const kaggleServer = draft.models.kaggle.enabled;
  if (kaggleServer && !draft.kaggleUrl.trim()) models('Give the Kaggle server’s address (careflow_kaggle.ipynb prints it).');
  if (kaggleServer && !bridge.hasKaggleKey && !draft.kaggleKey.trim()) models('Give the Kaggle server’s key.');
  if (draft.models.openrouter.enabled && !bridge.hasOpenRouterKey && !draft.openrouterKey.trim()) models('Give your OpenRouter API key.');
  return problems;
}

/**
 * Agents — WHICH of the available models each agent uses. One row per agent, every agent on its own: any
 * of them may run on any provider that is on (Models tab), whatever the others use.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Dropdown, Switch, Tooltip } from 'antd';
import {
  BellRing,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  Link2,
  ListChecks,
  ListTodo,
  Loader2,
  Mic,
  NotebookPen,
  Pill,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  TriangleAlert,
  Users,
  Workflow,
  XCircle,
} from 'lucide-react';
import type { AgentKey, AgentModel, ModelSource, SpeechChoice } from '@/services/ai/config';
import { lacksTools, SOURCE_LABELS, SPEECH_LABELS, TOOL_FREE_AGENTS } from '@/services/ai/agentModels';
import { AGENT_NAMES } from '@/services/ai/agents/taskGraph';
import { buildTools } from '@/services/ai/agent/tools';
import { MASTER_TOOLS, specialistTools } from '@/services/ai/agents/specialists';
import type { ModelTestResult } from '@/services/ai/modelCatalog';
import { AGENT_META, AGENT_ORDER, defaultModelOf, enabledSources, sameModel, shortModel, speechChoices, SWITCHABLE, type Draft } from './configModel';
import { ModelPicker, SOURCE_ICON, type PickerData } from './modelPickers';
import type { ConfigDraftState } from './useConfigDraft';

export const AGENT_ICON: Record<AgentKey, (size?: number) => ReactNode> = {
  master: (size = 18) => <Workflow size={size} />,
  planning: (size = 18) => <ListChecks size={size} />,
  dashboard: (size = 18) => <LayoutDashboard size={size} />,
  patients: (size = 18) => <Users size={size} />,
  appointments: (size = 18) => <CalendarClock size={size} />,
  patient_appointments: (size = 18) => <CalendarDays size={size} />,
  medications: (size = 18) => <Pill size={size} />,
  diagnoses: (size = 18) => <Stethoscope size={size} />,
  tasks: (size = 18) => <ListTodo size={size} />,
  recalls: (size = 18) => <BellRing size={size} />,
  notes: (size = 18) => <NotebookPen size={size} />,
  inbox: (size = 18) => <Inbox size={size} />,
  summary: (size = 18) => <Sparkles size={size} />,
  safety: (size = 18) => <ShieldCheck size={size} />,
};

/** What a switchable agent's badge and switch say. */
const SWITCH_TEXT: Partial<Record<AgentKey, { badge: string; on: string; off: string }>> = {
  planning: { badge: 'Before tasks run', on: 'On — asks for what is missing before anything runs', off: 'Off — tasks run with what the provider said' },
  safety: { badge: 'Every mode', on: 'On — nothing unsaid reaches the app; every reply is checked before it is shown', off: 'Off — tool calls are not checked (every reply still is)' },
};

const SOURCES: readonly ModelSource[] = ['local', 'kaggle', 'openrouter'];

/** How many tools each agent holds — the specialists far fewer than the single assistant. */
function useToolCounts(): Record<AgentKey, number> {
  return useMemo(() => {
    const all = buildTools();
    const specialists = Object.fromEntries(AGENT_NAMES.map((n) => [n, specialistTools(n, all).length]));
    return { master: MASTER_TOOLS.length + 1, planning: 2, safety: 1, ...specialists } as Record<AgentKey, number>;
  }, []);
}

/** A switch with its title and one line — the orchestration settings. */
function Toggle({ id, checked, disabled, onChange, title, text, big }: { id: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; title: string; text: string; big?: boolean }) {
  return (
    <label className={`cfg-toggle${big ? ' is-big' : ''}`} data-disabled={disabled ? 'true' : 'false'} htmlFor={id}>
      <span className="cfg-toggle-text">
        <strong>{title}</strong>
        <span>{text}</span>
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function AgentRow({ agent, draft, setAgent, data, tools, idle, canTest, test, enabled }: { agent: AgentKey; draft: Draft; setAgent: (m: AgentModel) => void; data: PickerData; tools: number; idle: boolean; canTest: (m: AgentModel) => string | null; test: (m: AgentModel, toolFree?: boolean) => Promise<ModelTestResult>; enabled?: { on: boolean; set: (v: boolean) => void } }) {
  const meta = AGENT_META[agent];
  const model = draft.agents[agent];
  const off = !!enabled && !enabled.on;
  const sourceOff = !off && !draft.models[model.source].enabled;
  const words = SWITCH_TEXT[agent];
  const [result, setResult] = useState<ModelTestResult | 'running' | null>(null);
  const why = canTest(model);
  const linked = agent !== 'master' && sameModel(model, draft.agents.master);
  const pick = (source: ModelSource) => {
    setResult(null);
    if (source !== model.source) setAgent({ source, model: defaultModelOf(draft.models, source) });
  };
  const toolFree = TOOL_FREE_AGENTS.has(agent);
  const passed = result && result !== 'running' && result.ok && (result.toolCalling || toolFree);
  return (
    <div
      className={`cfg-agent${agent === 'master' ? ' is-master' : ''}`}
      data-agent={agent}
      data-source={model.source}
      data-idle={idle ? 'true' : 'false'}
      data-off={off ? 'true' : 'false'}
      data-bad={sourceOff ? 'true' : 'false'}
      data-no-tools={!off && !sourceOff && !toolFree && lacksTools(model.model) ? 'true' : 'false'}
      role="group"
      aria-label={meta.title}
    >
      <div className="cfg-agent-who">
        <span className="cfg-agent-avatar" aria-hidden>
          {AGENT_ICON[agent](18)}
        </span>
        <span className="cfg-agent-text">
          <span className="cfg-agent-name">
            <span className="cfg-agent-title">{meta.title}</span>
            {agent === 'master' && <span className="cfg-badge">Orchestrator</span>}
            {words && !off && !idle && <span className="cfg-badge is-soft">{words.badge}</span>}
            {off && <span className="cfg-badge is-muted">Off</span>}
            {idle && !off && <span className="cfg-badge is-muted">Used in multi-agent mode</span>}
          </span>
          <Tooltip title={`${meta.role} ${meta.examples}.`} placement="bottomLeft">
            <span className="cfg-agent-role">
              {meta.role} <span className="cfg-agent-tools">· {toolFree && !tools ? 'no tools' : `${tools} ${tools === 1 ? 'tool' : 'tools'}`}</span>
            </span>
          </Tooltip>
        </span>
        {enabled && words && (
          <Tooltip title={enabled.on ? words.on : words.off}>
            <Switch id={`llm-${agent}`} className="cfg-agent-switch" size="small" checked={enabled.on} onChange={enabled.set} aria-label={`${meta.title} on`} />
          </Tooltip>
        )}
      </div>

      <div className="cfg-agent-sources" role="radiogroup" aria-label={`${meta.title} provider`}>
        {SOURCES.map((source) => {
          const on = draft.models[source].enabled && !off;
          return (
            <Tooltip key={source} title={off ? `${meta.title} is off` : on ? SOURCE_LABELS[source] : `${SOURCE_LABELS[source]} is off — switch it on in Models`}>
              <button type="button" role="radio" aria-checked={model.source === source} aria-label={SOURCE_LABELS[source]} data-value={source} data-source={source} disabled={!on} className={`cfg-source${model.source === source ? ' is-on' : ''}`} onClick={() => pick(source)}>
                {SOURCE_ICON[source](15)}
                <span>{SOURCE_LABELS[source]}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      <div className="cfg-agent-model">
        {sourceOff ? (
          <div className="cfg-agent-warn">
            <TriangleAlert size={15} /> {SOURCE_LABELS[model.source]} is off — pick a provider that is on.
          </div>
        ) : (
          <ModelPicker
            source={model.source}
            value={model.model}
            onChange={(v) => {
              setResult(null);
              setAgent({ ...model, model: v });
            }}
            data={data}
            ariaLabel={`${meta.title} model`}
            disabled={off}
            toolFree={toolFree}
          />
        )}
      </div>

      <div className="cfg-agent-actions">
        {linked ? (
          <Tooltip title="Follows the Master: a new model for the Master moves this agent too">
            <span className="cfg-link-chip">
              <Link2 size={13} /> Master
            </span>
          </Tooltip>
        ) : (
          <span className="cfg-link-chip is-empty" aria-hidden />
        )}
        <Tooltip title={result && result !== 'running' ? result.detail : (why ?? (toolFree ? 'Try it: a real request it must answer' : 'Try it: a real request that must call a tool'))}>
          <Button
            className={`cfg-agent-test${passed ? ' is-ok' : result && result !== 'running' ? ' is-bad' : ''}`}
            icon={result === 'running' ? <Loader2 size={15} className="spin" /> : passed ? <CheckCircle2 size={15} /> : result ? <XCircle size={15} /> : <FlaskConical size={15} />}
            disabled={!!why || sourceOff || off || result === 'running'}
            onClick={async () => {
              setResult('running');
              setResult(await test(model, toolFree));
            }}
            aria-label={`Test ${meta.title}`}
          >
            {result === 'running' ? 'Testing' : passed ? `${((result as ModelTestResult).ms / 1000).toFixed(1)} s` : result ? 'Failed' : 'Test'}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Agents on a model that calls no tools (MedGemma, Qwen3Guard): said once, above the list — each row only
 * marks it, so no row grows taller than the others.
 */
function NoToolsNotice({ draft }: { draft: Draft }) {
  const on = AGENT_ORDER.filter((k) => !TOOL_FREE_AGENTS.has(k) && draft.models[draft.agents[k].source].enabled && lacksTools(draft.agents[k].model) && !(SWITCHABLE[k] && !draft[SWITCHABLE[k]!]));
  if (!on.length) return null;
  const acting = on.filter((k) => k !== 'safety');
  return (
    <div className="cfg-notools" role="note">
      <TriangleAlert size={15} aria-hidden />
      <span>
        <strong>No tool calling on {[...new Set(on.map((k) => shortModel(draft.agents[k].model)))].join(' / ')}.</strong>{' '}
        {acting.length > 0 && <>{acting.map((k) => AGENT_META[k].title.replace(' Agent', '')).join(', ')} cannot carry out actions on it. </>}
        {on.includes('safety') && <>Safety: the model review is skipped — its rules still check every call.</>}
      </span>
    </div>
  );
}

/** Where each microphone model runs — and the switch it needs (Models tab). */
const MIC_OPTIONS: ReadonlyArray<{ value: SpeechChoice; source: ModelSource }> = [
  { value: 'local-omi', source: 'local' },
  { value: 'kaggle-whisper', source: 'kaggle' },
  { value: 'kaggle-omi', source: 'kaggle' },
];

/**
 * The microphone: one speech model hears the provider. Only those of the providers switched on are offered —
 * OpenRouter has none, so with it alone there is nothing to choose, and that is said.
 */
function MicrophoneCard({ draft, onChange }: { draft: Draft; onChange: (speech: SpeechChoice) => void }) {
  const choices = speechChoices(draft.models);
  const shown = MIC_OPTIONS.filter((o) => choices.includes(o.value));
  return (
    <div className="cfg-card cfg-mic" role="radiogroup" aria-label="Microphone">
      <header className="cfg-mic-head">
        <span className="cfg-mic-icon" aria-hidden>
          <Mic size={18} />
        </span>
        <span>
          <span className="cfg-card-title">Microphone</span>
          <span className="cfg-card-text">One speech model hears you — the voice assistant cannot work without one.</span>
        </span>
      </header>
      {shown.length ? (
        <div className="cfg-mic-options">
          {shown.map((o) => {
            const label = SPEECH_LABELS[o.value];
            const on = draft.models.speech === o.value;
            return (
              <button key={o.value} type="button" role="radio" aria-checked={on} data-value={o.value} data-source={o.source} className={`cfg-speech-option${on ? ' is-on' : ''}`} onClick={() => onChange(o.value)}>
                <span className="cfg-radio" aria-hidden />
                <span className="cfg-speech-text">
                  <strong>{label.title}</strong>
                  <span>{label.where}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="cfg-agent-warn" role="alert">
          <TriangleAlert size={15} /> No microphone model: OpenRouter has no speech recognition. Switch on This Computer (omi-med-stt-v1) or Kaggle (Whisper large-v3-turbo) in Models.
        </div>
      )}
    </div>
  );
}

export function AgentsSection(p: ConfigDraftState) {
  const { draft, update, status, localModels, kaggleServed, orModels, testAgent } = p;
  const tools = useToolCounts();
  const data: PickerData = { localModels, kaggleServed, orModels };
  // A specialist that follows the Master moves with it.
  const setAgent = (key: AgentKey) => (m: AgentModel) =>
    update((d) => {
      if (key !== 'master') return { ...d, agents: { ...d.agents, [key]: m } };
      const agents = Object.fromEntries(AGENT_ORDER.map((k) => [k, k === 'master' || sameModel(d.agents[k], d.agents.master) ? m : d.agents[k]])) as Draft['agents'];
      return { ...d, agents };
    });
  const everyone = (m: AgentModel) => update((d) => ({ ...d, agents: Object.fromEntries(AGENT_ORDER.map((k) => [k, m])) as Draft['agents'] }));
  /** A model can be tried once the bridge already forwards to its provider (after Apply). */
  const canTest = (m: AgentModel): string | null => (m.source === 'local' || (status?.providers ?? []).includes(m.source) ? null : `Apply first — the bridge does not forward to ${SOURCE_LABELS[m.source]} yet`);

  const assignItems = [
    ...enabledSources(draft.models).map((source) => ({
      key: source,
      icon: SOURCE_ICON[source](15),
      label: `${SOURCE_LABELS[source]} · ${shortModel(defaultModelOf(draft.models, source))}`,
      onClick: () => everyone({ source, model: defaultModelOf(draft.models, source) }),
    })),
    { type: 'divider' as const },
    { key: 'master', icon: <Link2 size={15} />, label: 'Everyone on the Master’s model', onClick: () => everyone(draft.agents.master) },
  ];

  return (
    <div className="cfg-agents">
      <div className="cfg-card cfg-orchestration">
        <Toggle
          big
          id="llm-multi"
          checked={draft.multiAgent}
          onChange={(v) => update((d) => ({ ...d, multiAgent: v }))}
          title="Multi-agent mode"
          text={draft.multiAgent ? 'The Master plans each request as tasks, the Planning Agent gathers what they need, the five specialists carry them out — each agent on its own model.' : 'Off — one assistant, on the Master’s model, does everything (the Safety Agent still checks it).'}
        />
        <div className="cfg-orchestration-more">
          <Toggle id="llm-parallel" checked={draft.parallelReads} disabled={!draft.multiAgent} onChange={(v) => update((d) => ({ ...d, parallelReads: v }))} title="Run independent tasks together" text="Agents work at the same time; the screen changes one step at a time, and only one question waits for you." />
          <Toggle id="llm-plan" checked={draft.planSteps} disabled={draft.multiAgent} onChange={(v) => update((d) => ({ ...d, planSteps: v }))} title="Break long requests into steps" text="Single-agent mode only — the Master plans otherwise." />
        </div>
      </div>

      <MicrophoneCard draft={draft} onChange={(speech) => update((d) => ({ ...d, models: { ...d.models, speech } }))} />

      <div className="cfg-card cfg-roster">
        <header className="cfg-roster-top">
          <span>
            <span className="cfg-card-title">Agent models</span>
            <span className="cfg-card-text">Every agent thinks with its own model — mix providers freely.</span>
          </span>
          <Dropdown trigger={['click']} menu={{ items: assignItems }} placement="bottomRight">
            <Button className="cfg-assign-all">
              Assign all to <ChevronDown size={14} />
            </Button>
          </Dropdown>
        </header>
        <NoToolsNotice draft={draft} />
        <div className="cfg-roster-cols" aria-hidden>
          <span>Agent</span>
          <span>Provider</span>
          <span>Model</span>
          <span />
        </div>
        {AGENT_ORDER.map((key) => {
          const flag = SWITCHABLE[key];
          return (
            <AgentRow
              key={key}
              agent={key}
              draft={draft}
              setAgent={setAgent(key)}
              data={data}
              tools={tools[key]}
              idle={!draft.multiAgent && key !== 'master' && key !== 'safety'}
              canTest={canTest}
              test={testAgent}
              enabled={flag ? { on: draft[flag], set: (v) => update((d) => ({ ...d, [flag]: v })) } : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

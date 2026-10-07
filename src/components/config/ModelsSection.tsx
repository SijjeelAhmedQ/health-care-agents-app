/**
 * Models — WHERE models can run.
 *
 * A settings layout: the three providers in a list on the left (each with its own switch: one, two or all
 * three on), the one selected opened on the right. Switching one on puts every agent on its default model and
 * the microphone on its default; WHICH model each agent uses, and the microphone, are chosen in Agents.
 */
import { useState, type ReactNode } from 'react';
import { Button, Input, Switch, Tooltip } from 'antd';
import { AudioLines, CheckCircle2, ChevronRight, Cpu, KeyRound, Mic, Power, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ModelSource } from '@/services/ai/config';
import { PROVIDER_DEFAULTS, SPEECH_LABELS } from '@/services/ai/agentModels';
import { remoteLlmOf } from '@/services/ai/compute';
import { AGENT_META, AGENT_ORDER, shortModel, SOURCE_META, speechChoices, switchProvider, type Draft } from './configModel';
import { Pill, SOURCE_ICON } from './modelPickers';
import type { ConfigDraftState } from './useConfigDraft';

type Props = ConfigDraftState & { openAdvanced: () => void };

const SOURCES: readonly ModelSource[] = ['local', 'kaggle', 'openrouter'];

/** One block of settings in the detail pane: a title and a line on the left, the controls on the right. */
function Block({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="cfg-block">
      <div className="cfg-block-text">
        <h4>{title}</h4>
        {description && <p>{description}</p>}
      </div>
      <div className="cfg-block-body">{children}</div>
    </div>
  );
}

/** What switching this provider on gives: every agent's model and the microphone (both can be changed in Agents). */
function Defaults({ source }: { source: ModelSource }) {
  const d = PROVIDER_DEFAULTS[source];
  const mic = SPEECH_LABELS[d.speech];
  return (
    <div className="cfg-defaults">
      <span className="cfg-default">
        <span className="cfg-default-label">Agents</span>
        <strong>{shortModel(d.model)}</strong>
      </span>
      <span className="cfg-default">
        <span className="cfg-default-label">
          <Mic size={12} aria-hidden /> Microphone
        </span>
        <strong>{mic.title}</strong>
        <span className="muted">· {mic.where}</span>
      </span>
    </div>
  );
}

/** The Kaggle server: address, key, and what it runs. Shared by Kaggle's Qwen and Kaggle's speech. */
function KaggleConnection(p: Props) {
  const { draft, update, status, kaggleHealth: health, checking } = p;
  const llm = remoteLlmOf(health);
  return (
    <div className="cfg-connection">
      <div className="cfg-inline-field">
        <Input id="compute-url" size="large" value={draft.kaggleUrl} onChange={(e) => update((d) => ({ ...d, kaggleUrl: e.target.value }))} placeholder="https://….trycloudflare.com" allowClear aria-label="Kaggle server address" />
        <Tooltip title="Check the connection now">
          <Button size="large" icon={<RefreshCw size={15} className={checking ? 'spin' : undefined} />} onClick={() => void p.checkKaggle()} disabled={!draft.kaggleUrl.trim() || checking} aria-label="Check connection" />
        </Tooltip>
      </div>
      {status?.has_key && !draft.kaggleKey ? (
        <div className="cfg-keyline">
          <CheckCircle2 size={15} aria-hidden /> Server key saved on the bridge
          <Button type="link" size="small" onClick={() => update((d) => ({ ...d, kaggleKey: ' ' }))}>
            Change
          </Button>
        </div>
      ) : (
        <Input.Password id="compute-key" size="large" value={draft.kaggleKey.trim()} onChange={(e) => update((d) => ({ ...d, kaggleKey: e.target.value }))} prefix={<KeyRound size={15} className="muted" />} placeholder="Server key (KEY in the notebook)" aria-label="Kaggle server key" />
      )}
      {health?.ok === false && <div className="cfg-error">{health.error}</div>}
      {health?.ok && (
        <div className="cfg-facts">
          {health.gpu && (
            <span className="cfg-note">
              <Cpu size={12} /> {String(health.gpu).split('\n')[0].split(',')[0]}
            </span>
          )}
          {Object.keys(health.engines ?? {}).map((e) => (
            <span key={e} className="cfg-note">
              <AudioLines size={12} /> {e === 'omi' ? 'omi-med-stt-v1' : e === 'whisper' ? 'Whisper' : e}
            </span>
          ))}
          {llm?.models?.map((m) => (
            <span key={m} className="cfg-note is-good">
              {m}
            </span>
          ))}
          {llm && !llm.ok && <span className="cfg-note is-bad">{llm.error ?? 'vLLM is not running'}</span>}
        </div>
      )}
    </div>
  );
}

function kaggleStatus(p: Props): ReactNode {
  if (!p.draft.kaggleUrl.trim()) return <Pill tone="idle">Not set up</Pill>;
  if (p.checking) return <Pill tone="busy">Checking…</Pill>;
  if (!p.kaggleHealth) return <Pill tone="idle">Not checked</Pill>;
  if (p.kaggleHealth.ok === false) return <Pill tone="bad">Not reachable</Pill>;
  const gpu = p.kaggleHealth.gpu ? ` · ${String(p.kaggleHealth.gpu).split('\n')[0].split(',')[0]}` : '';
  return <Pill tone="ok">Connected{gpu}</Pill>;
}

function statusOf(p: Props, source: ModelSource): ReactNode {
  if (source === 'local') return p.localError ? <Pill tone="bad">Ollama not running</Pill> : p.localModels ? <Pill tone="ok">Ollama · {p.localModels.length} models</Pill> : <Pill tone="busy">Looking for Ollama…</Pill>;
  if (source === 'kaggle') return kaggleStatus(p);
  const credit = p.status?.openrouter?.limit_remaining;
  return p.status?.has_openrouter_key || p.draft.openrouterKey.trim() ? <Pill tone="ok">Key {p.status?.has_openrouter_key ? 'saved' : 'entered'}{credit != null ? ` · $${credit.toFixed(2)} left` : ''}</Pill> : <Pill tone="warn">Key needed</Pill>;
}

/** The agents that are on a source now (in the draft). */
const usedBy = (draft: Draft, source: ModelSource) => AGENT_ORDER.filter((k) => draft.agents[k].source === source);

export function ModelsSection(p: Props) {
  const { draft, update, localModels } = p;
  const m = draft.models;
  const [selected, setSelected] = useState<ModelSource>(() => SOURCES.find((s) => m[s].enabled) ?? 'local');

  /** On: every agent on this provider's default model, the microphone on its default. Off: agents move on. */
  const toggle = (source: ModelSource, on: boolean) => update((d) => switchProvider(d, source, on));

  const on = m[selected].enabled;
  const meta = SOURCE_META[selected];
  const users = usedBy(draft, selected);
  // The app is voice-first: OpenRouter on its own has no microphone model.
  const noMicrophone = !speechChoices(m).length && (m.openrouter.enabled || m.local.enabled || m.kaggle.enabled);

  return (
    <div className="cfg-md">
      {/* ---- the list */}
      <aside className="cfg-md-side">
        <div className="cfg-card cfg-providers" role="tablist" aria-label="Providers" aria-orientation="vertical">
          <div className="cfg-card-title">Providers</div>
          {SOURCES.map((source) => (
            <div key={source} className={`cfg-provider${selected === source ? ' is-selected' : ''}`} data-source={source} data-on={m[source].enabled ? 'true' : 'false'}>
              <button type="button" role="tab" aria-selected={selected === source} className="cfg-provider-main" onClick={() => setSelected(source)}>
                <span className="cfg-provider-icon" aria-hidden>
                  {SOURCE_ICON[source](18)}
                </span>
                <span className="cfg-provider-text">
                  <span className="cfg-provider-name">{SOURCE_META[source].title}</span>
                  <span className="cfg-provider-state">{m[source].enabled ? statusOf(p, source) : <span className="cfg-off-text">Off</span>}</span>
                </span>
                <ChevronRight size={16} className="cfg-provider-chevron" aria-hidden />
              </button>
              <Switch className="cfg-provider-switch" size="small" checked={m[source].enabled} onChange={(v) => { toggle(source, v); setSelected(source); }} aria-label={`${SOURCE_META[source].title} ${m[source].enabled ? 'on' : 'off'}`} />
            </div>
          ))}
        </div>

        {noMicrophone && (
          <div className="cfg-card cfg-mic-warning" role="alert">
            <TriangleAlert size={16} aria-hidden />
            <div>
              <strong>No microphone model</strong>
              <span>OpenRouter has no speech recognition, and CareFlow is voice-first. Switch on This Computer (omi-med-stt-v1) or Kaggle (Whisper large-v3-turbo) — then choose it in Agents → Microphone.</span>
            </div>
          </div>
        )}
      </aside>

      {/* ---- the selected provider */}
      <section className="cfg-card cfg-detail" data-source={selected} data-on={on ? 'true' : 'false'} role="tabpanel" aria-label={meta.title}>
        <header className="cfg-detail-head">
          <span className="cfg-detail-icon" aria-hidden>
            {SOURCE_ICON[selected](22)}
          </span>
          <span className="cfg-detail-titles">
            <h3>{meta.title}</h3>
            <span>{meta.tagline}</span>
          </span>
          <span className="cfg-detail-status">{on ? statusOf(p, selected) : <Pill tone="idle">Off</Pill>}</span>
        </header>

        {!on ? (
          <div className="cfg-empty">
            <span className="cfg-empty-icon" aria-hidden>
              <Power size={22} />
            </span>
            <strong>{meta.title} is off</strong>
            <span>Its models are not offered to the agents. Switch it on to set it up.</span>
            <Button type="primary" onClick={() => toggle(selected, true)}>
              Switch on {meta.title}
            </Button>
          </div>
        ) : (
          <div className="cfg-detail-body">
            {users.length > 0 && (
              <div className="cfg-usedby">
                Used by {users.map((k) => AGENT_META[k].title.replace(' Agent', '')).join(' · ')}
              </div>
            )}

            {selected === 'local' && (
              <>
                <Block title="Ollama" description={localModels ? `${localModels.length} models installed. A model you pull appears in Agents by itself.` : p.localError ?? 'Reading Ollama…'}>
                  <Button icon={<RefreshCw size={15} />} onClick={() => void p.refreshLocal()} aria-label="Refresh the model list">
                    Refresh
                  </Button>
                </Block>
                <Block title="When switched on" description="Every agent and the microphone start here — each can be changed in Agents.">
                  <Defaults source="local" />
                </Block>
              </>
            )}

            {selected === 'kaggle' && (
              <>
                <Block title="Server" description="The address and key careflow_kaggle.ipynb prints. Keys stay on the bridge — never in this browser.">
                  <KaggleConnection {...p} />
                </Block>
                <Block title="When switched on" description="Every agent and the microphone start here — each can be changed in Agents.">
                  <Defaults source="kaggle" />
                </Block>
              </>
            )}

            {selected === 'openrouter' && (
              <>
                <Block title="API key" description="From openrouter.ai/keys. Kept by the bridge — never in this browser.">
                  {p.status?.has_openrouter_key && !draft.openrouterKey ? (
                    <div className="cfg-keyline">
                      <CheckCircle2 size={15} aria-hidden /> API key saved on the bridge
                      <Button type="link" size="small" onClick={() => update((d) => ({ ...d, openrouterKey: ' ' }))}>
                        Change
                      </Button>
                    </div>
                  ) : (
                    <Input.Password id="openrouter-key" size="large" value={draft.openrouterKey.trim()} onChange={(e) => update((d) => ({ ...d, openrouterKey: e.target.value }))} prefix={<KeyRound size={15} className="muted" />} placeholder="sk-or-…" aria-label="OpenRouter API key" />
                  )}
                </Block>
                <Block title="When switched on" description="Every agent starts on DeepSeek V4.1 Flash — each can pick any OpenRouter model in Agents. OpenRouter has no speech recognition: the microphone stays on This Computer or Kaggle.">
                  <Defaults source="openrouter" />
                </Block>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

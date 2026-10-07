import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useResponsive } from '@/hooks';
import { Alert, Button, Input, InputNumber, Popover, Radio, Select, Slider, Space, Tag, Tooltip, message } from 'antd';
import { Activity, AudioLines, Boxes, Bot, CheckCircle2, CircleAlert, Gauge, Loader2, Mic, RefreshCw, RotateCcw, Save, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useAppSelector } from '@/store';
import { PageHeader, SectionCard } from '@/components/common';
import { aiConfig, bridgeHttpUrl, effectiveConfig, getAIOverride, setAIOverride } from '@/services/ai/config';
import { SOURCE_LABELS, SPEECH_LABELS } from '@/services/ai/agentModels';
import { getSttConfig, saveSttConfig, type SttConfig, type SttSettings } from '@/services/ai/sttConfig';
import { getVoiceController } from '@/services/ai/voiceController';
import { MONITOR_PATH } from '@/services/ai/monitor/channel';
import { ModelsSection } from '@/components/config/ModelsSection';
import { AGENT_ICON, AgentsSection } from '@/components/config/AgentsSection';
import { AGENT_META, AGENT_ORDER, agentRuns, enabledSources, shortModel, type Change, type ConfigTab, type Draft, type Problem } from '@/components/config/configModel';
import { SOURCE_ICON } from '@/components/config/modelPickers';
import { useConfigDraft, type ApplyResult } from '@/components/config/useConfigDraft';
import '@/styles/config.css';

/**
 * Configuration, in three tabs:
 *
 *   Models     WHERE models can run and which ones — This Computer, Kaggle, OpenRouter (any of them on)
 *   Agents     WHICH of those models each agent uses — every agent on its own
 *   Advanced   performance, and this computer's speech engine
 *
 * The page holds a draft. A summary at the top says what runs now; a save bar rises from the foot as soon
 * as something changed — the one control that changes anything — and says what is left to fix and where.
 */
const TABS: readonly ConfigTab[] = ['models', 'agents', 'advanced'];

export default function ConfigurationPage() {
  const state = useConfigDraft();
  const { draft, saved, changes, problems, applying, discard, bridgeError } = state;
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as ConfigTab | null;
  const tab: ConfigTab = asked && TABS.includes(asked) ? asked : 'models';
  const setTab = useCallback((next: ConfigTab) => setParams((p) => ({ ...Object.fromEntries(p), tab: next }), { replace: true }), [setParams]);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const navigate = useNavigate();
  const monitoring = useAppSelector((s) => s.monitor.requests[0]?.status === 'running');
  const dirty = changes.length > 0;
  const canApply = dirty && !problems.length && !applying;

  const run = useCallback(async () => {
    setResult(null);
    const r = await state.apply();
    setResult(r);
    if (r.ok) message.success(r.text);
    else message.error(r.text);
  }, [state]);

  // Ctrl / ⌘ + Enter applies — from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canApply) {
        e.preventDefault();
        void run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canApply, run]);

  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = TABS.indexOf(tab);
    if (e.key === 'ArrowRight') setTab(TABS[(i + 1) % TABS.length]);
    if (e.key === 'ArrowLeft') setTab(TABS[(i + TABS.length - 1) % TABS.length]);
  };

  const tabInfo: Record<ConfigTab, { title: string; icon: ReactNode; sub: string }> = {
    models: { title: 'Models', icon: <Boxes size={18} />, sub: `${enabledSources(draft.models).length} of 3 providers on` },
    agents: { title: 'Agents', icon: <Bot size={18} />, sub: draft.multiAgent ? `Multi-agent · ${AGENT_ORDER.filter((k) => agentRuns(k, draft)).length} agents` : `Single-agent${draft.safety ? ' · Safety on' : ' mode'}` },
    advanced: { title: 'Advanced', icon: <SlidersHorizontal size={18} />, sub: 'Performance · speech engine' },
  };

  return (
    <div className="page cfg-page">
      <PageHeader
        title="Configuration"
        subtitle="Where the AI runs, and which model each agent thinks with. Nothing changes until you apply."
        actions={
          <Button
            className="cfg-monitor-btn"
            icon={<Activity size={15} />}
            href={MONITOR_PATH}
            title="Its own page (/agent-monitor). Ctrl + click opens it in a new tab, to watch the agents beside the app."
            onClick={(e) => {
              // A plain click stays in the app; Ctrl / ⌘ / middle click is the browser's: a new tab.
              if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(MONITOR_PATH);
            }}
          >
            Agent Monitoring
            {monitoring && <span className="cfg-live-dot" aria-label="agents working" />}
          </Button>
        }
      />
      {bridgeError && (
        <Alert className="cfg-bridge-alert" type="warning" showIcon message="The bridge is not reachable" description={`${bridgeError} Kaggle, OpenRouter and speech settings go through it; This Computer’s models still work.`} />
      )}

      <RunningNow saved={saved} />

      <div className="cfg-tabs" role="tablist" aria-label="Configuration" onKeyDown={onTabKey}>
        {TABS.map((t) => {
          const tabProblems = problems.filter((p) => p.tab === t).length;
          const tabChanges = changes.filter((c) => c.tab === t).length;
          return (
            <button key={t} type="button" role="tab" id={`cfg-tab-${t}`} aria-controls={`cfg-panel-${t}`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} data-tab={t} className={`cfg-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
              <span className="cfg-tab-icon" aria-hidden>
                {tabInfo[t].icon}
              </span>
              <span className="cfg-tab-text">
                <span className="cfg-tab-title">{tabInfo[t].title}</span>
                <span className="cfg-tab-sub">{tabInfo[t].sub}</span>
              </span>
              {tabProblems > 0 ? (
                <span className="cfg-tab-badge is-bad" title={`${tabProblems} to fix`}>
                  {tabProblems}
                </span>
              ) : tabChanges > 0 ? (
                <span className="cfg-tab-badge is-dot" title="Unsaved changes" />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="cfg-panel" role="tabpanel" id={`cfg-panel-${tab}`} aria-labelledby={`cfg-tab-${tab}`}>
        {tab === 'models' && <ModelsSection {...state} openAdvanced={() => setTab('advanced')} />}
        {tab === 'agents' && <AgentsSection {...state} />}
        {tab === 'advanced' && (
          <div className="cfg-advanced">
            <div className="cfg-card">
              <div className="cfg-card-title">
                <Gauge size={16} /> Performance
              </div>
              <p className="cfg-card-text">For every language model the agents use.</p>
              <div className="cfg-perf">
                <NumberSetting label="Context window (tokens)" hint="The least it may be — raised by itself to fit the instructions and tools." value={draft.perf.numCtx} min={4096} max={131072} step={1024} onChange={(v) => state.update((d) => ({ ...d, perf: { ...d.perf, numCtx: v } }))} />
                <NumberSetting label="GPU layers (This Computer)" hint="99 = the whole model on the GPU; 0 = CPU only." value={draft.perf.numGpu} min={0} max={999} onChange={(v) => state.update((d) => ({ ...d, perf: { ...d.perf, numGpu: v } }))} />
                <NumberSetting label="Timeout per request (s)" hint="The first request after a change loads the model." value={Math.round(draft.perf.timeoutMs / 1000)} min={10} max={900} onChange={(v) => state.update((d) => ({ ...d, perf: { ...d.perf, timeoutMs: v * 1000 } }))} />
                <NumberSetting label="Steps per request" hint="Most model calls one request (or task) may take." value={draft.perf.maxSteps} min={1} max={12} onChange={(v) => state.update((d) => ({ ...d, perf: { ...d.perf, maxSteps: v } }))} />
              </div>
            </div>
            <div id="cfg-speech-engine" className="config-grid">
              <SpeechModelSection />
            </div>
          </div>
        )}
      </div>

      {(dirty || applying) && <SaveBar changes={changes} problems={problems} applying={applying} canApply={canApply} result={result} onApply={() => void run()} onDiscard={() => { discard(); setResult(null); }} onGoTo={setTab} />}
    </div>
  );
}

/** What runs now, at a glance: the microphone, the mode, the providers, and every agent on its provider. */
function RunningNow({ saved }: { saved: Draft }) {
  const speech = SPEECH_LABELS[saved.models.speech];
  return (
    <div className="cfg-now" aria-label="Running now">
      <span className="cfg-now-label">
        <span className="cfg-live-dot" aria-hidden /> Running now
      </span>
      <span className="cfg-now-chips">
        <span className="cfg-now-chip">
          <Mic size={13} /> {speech.title} <span className="muted">· {speech.where}</span>
        </span>
        <span className="cfg-now-chip">{saved.multiAgent ? 'Multi-agent' : 'Single-agent'}</span>
        {enabledSources(saved.models).map((s) => (
          <span key={s} className="cfg-now-chip" data-source={s}>
            {SOURCE_ICON[s](13)} {SOURCE_LABELS[s]}
          </span>
        ))}
      </span>
      <span className="cfg-now-agents">
        {AGENT_ORDER.filter((k) => agentRuns(k, saved)).map((k) => (
          <Tooltip key={k} title={`${AGENT_META[k].title} — ${SOURCE_LABELS[saved.agents[k].source]} · ${saved.agents[k].model}`}>
            <span className="cfg-now-agent" data-agent={k} data-source={saved.agents[k].source}>
              {AGENT_ICON[k](14)}
              <span>{shortModel(saved.agents[k].model)}</span>
            </span>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}

const CHORD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘↵' : 'Ctrl ↵';
const TAB_TITLES: Record<ConfigTab, string> = { models: 'Models', agents: 'Agents', advanced: 'Advanced' };

/** Rises from the foot once something changed: what Apply would do, what is left to fix (and where), Apply. */
function SaveBar({ changes, problems, applying, canApply, result, onApply, onDiscard, onGoTo }: { changes: Change[]; problems: Problem[]; applying: boolean; canApply: boolean; result: ApplyResult | null; onApply: () => void; onDiscard: () => void; onGoTo: (t: ConfigTab) => void }) {
  // On a phone the bar floats just above the bottom navigation — outside the page, so nothing clips it.
  const { isMobile } = useResponsive();
  const list = (
    <ul className="cfg-save-list">
      {changes.map((c) => (
        <li key={c.key}>
          <span className="cfg-save-tab">{TAB_TITLES[c.tab]}</span> {c.text}
        </li>
      ))}
    </ul>
  );
  const fixes = (
    <ul className="cfg-save-list is-bad">
      {problems.map((p) => (
        <li key={p.text}>
          <button type="button" onClick={() => onGoTo(p.tab)}>
            <span className="cfg-save-tab">{TAB_TITLES[p.tab]}</span> {p.text}
          </button>
        </li>
      ))}
    </ul>
  );
  const bar = (
    <div className={`cfg-save${isMobile ? ' is-floating' : ''}`} data-bad={problems.length ? 'true' : 'false'} role="region" aria-label="Unsaved changes">
      <div className="cfg-save-info">
        <Popover content={list} title="What Apply will change" trigger="click" placement="topLeft">
          <button type="button" className="cfg-save-count">
            <span className="cfg-save-dot" aria-hidden />
            {changes.length} <span className="cfg-save-word">unsaved&nbsp;</span>change{changes.length === 1 ? '' : 's'}
          </button>
        </Popover>
        {problems.length > 0 ? (
          <Popover content={fixes} title="Before you apply" trigger="click" placement="topLeft">
            <button type="button" className="cfg-save-problems" onClick={() => onGoTo(problems[0].tab)}>
              <CircleAlert size={14} /> {problems.length === 1 ? problems[0].text : `${problems.length} things to fix`}
            </button>
          </Popover>
        ) : result && !result.ok ? (
          <span className="cfg-save-problems">
            <CircleAlert size={14} /> {result.text}
          </span>
        ) : (
          <span className="cfg-save-ready">
            <CheckCircle2 size={14} /> Ready to apply
          </span>
        )}
        {/* Every line, for screen readers and for tests; the popovers show them on click. */}
        <span className="sr-only">
          {changes.map((c) => c.text).join('. ')}. {problems.map((p) => p.text).join(' ')}
        </span>
      </div>
      <div className="cfg-save-actions">
        <Button className="cfg-save-discard" icon={<Undo2 size={15} />} onClick={onDiscard} disabled={applying} aria-label="Discard changes">
          Discard
        </Button>
        <Button type="primary" className="cfg-apply" icon={applying ? <Loader2 size={15} className="spin" /> : <Save size={15} />} onClick={onApply} disabled={!canApply}>
          {applying ? 'Applying…' : 'Apply'}
          {!applying && <kbd className="cfg-kbd">{CHORD}</kbd>}
        </Button>
      </div>
    </div>
  );
  return isMobile ? createPortal(bar, document.body) : bar;
}

function NumberSetting({ label, hint, value, min, max, step, onChange }: { label: string; hint: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div className="config-field">
      <label>{label}</label>
      <InputNumber size="large" value={value} min={min} max={max} step={step} onChange={(v) => typeof v === 'number' && onChange(v)} style={{ width: '100%' }} />
      <div className="config-hint">{hint}</div>
    </div>
  );
}

// ---------------------------------------------------------------- speech model

function SpeechModelSection() {
  const [wsUrl, setWsUrl] = useState(() => effectiveConfig().stt.wsUrl);
  const bridgeUrl = useMemo(() => bridgeHttpUrl(wsUrl), [wsUrl]);
  const [config, setConfig] = useState<SttConfig | null>(null);
  const [draft, setDraft] = useState<SttSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);
  const revision = useAppSelector((s) => s.ui.aiConfigRevision);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await getSttConfig(bridgeUrl);
      setConfig(c);
      setDraft(c.settings);
      setError(null);
    } catch (e) {
      setConfig(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bridgeUrl]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);
  // Changed elsewhere (e.g. by voice): reload what the bridge now runs.
  useEffect(() => {
    if (revision) void load();
  }, [revision, load]);

  const models = config?.models ?? [];
  const selectedModel = draft ? models.find((m) => m.repo === draft.repo && (draft.engine !== 'gguf' || m.gguf_file === draft.gguf_file)) : undefined;
  const dirty = !!config && !!draft && JSON.stringify(draft) !== JSON.stringify(config.settings);
  const urlChanged = wsUrl !== effectiveConfig().stt.wsUrl;

  const set = <K extends keyof SttSettings>(key: K, value: SttSettings[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const apply = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await saveSttConfig(bridgeUrl, draft);
      setConfig(next);
      setDraft(next.settings);
      setError(null);
      message.success(`Speech recognition now uses ${next.engine.engine}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setAIOverride({ ...getAIOverride(), stt: { wsUrl } });
    getVoiceController().reconfigure();
    loaded.current = true;
    await load();
  };

  return (
    <SectionCard title="Speech recognition" icon={<AudioLines size={16} />} description="The speech model that transcribes live while you speak — Omi Med STT or NVIDIA Parakeet. It runs in the Python bridge.">
      <div className="config-field">
        <label htmlFor="stt-url">Bridge address</label>
        <Space.Compact style={{ width: '100%' }}>
          <Input id="stt-url" value={wsUrl} onChange={(e) => setWsUrl(e.target.value.trim())} placeholder={aiConfig.stt.wsUrl} />
          <Button onClick={() => void connect()} loading={loading} icon={<RefreshCw size={14} />}>
            {urlChanged ? 'Connect' : 'Reload'}
          </Button>
        </Space.Compact>
      </div>

      {error && <Alert type="error" showIcon message={config ? 'The change was not applied' : 'The bridge is not reachable'} description={error} style={{ marginBottom: 12 }} />}

      {config && draft && (
        <>
          <div className="config-status">
            {config.engine.ready ? <CheckCircle2 size={15} color="#0f9d63" /> : <CircleAlert size={15} color="#e5484d" />}
            <span>{config.engine.ready ? 'Running:' : 'Not running:'}</span> <Tag color={config.engine.ready ? 'green' : 'red'}>{config.engine.engine}</Tag>
            {config.engine.error && <span className="muted">{config.engine.error}</span>}
          </div>

          {draft.engine === 'remote' && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="Speech recognition runs on the remote GPU"
              description={`${config.engine.engine}${config.engine.latency_ms !== undefined ? ` — ${config.engine.latency_ms} ms away` : ''}. Change it under "Where the AI runs" at the top of this page.`}
            />
          )}

          {draft.engine !== 'remote' && (
          <div className="config-field">
            <label>Model</label>
            <Select
              value={selectedModel?.id}
              onChange={(id: string) => {
                const m = models.find((x) => x.id === id)!;
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        repo: m.repo,
                        engine: m.engine,
                        gguf_file: m.gguf_file,
                        // Parakeet (ONNX) runs on the CPU or the GPU only, int8 unless chosen otherwise.
                        ...(m.engine === 'onnx' ? { backend: d.backend === 'vulkan' ? 'cpu' : d.backend, precision: d.precision ?? 'int8' } : {}),
                      }
                    : d,
                );
              }}
              options={models.filter((m) => m.engine !== 'remote').map((m) => ({
                value: m.id,
                disabled: !m.available,
                label: (
                  <span className="config-model-option">
                    <strong>{m.label}</strong>
                    <span className="config-model-tags">
                      {m.downloaded ? <Tag color="green">downloaded</Tag> : <Tag>{m.download_mb ? `download ~${m.download_mb} MB` : 'not downloaded'}</Tag>}
                      {!m.available && <Tag color="red">{m.reason}</Tag>}
                    </span>
                  </span>
                ),
              }))}
              style={{ width: '100%' }}
            />
            <div className="config-hint">Any other Omi Med STT build in the Hugging Face cache is listed here as well.</div>
            {selectedModel && (() => {
              const precision = draft.precision ?? 'int8';
              const onDisk = selectedModel.engine === 'onnx' ? (selectedModel.downloaded_precisions ?? []).includes(precision) : selectedModel.downloaded;
              const size = selectedModel.engine === 'onnx' ? selectedModel.download_mb_by_precision?.[precision] : selectedModel.download_mb;
              return onDisk ? null : <Alert type="info" showIcon style={{ marginTop: 8 }} message={`Applying downloads this model${size ? ` (~${size} MB)` : ''} first.`} />;
            })()}
          </div>
          )}

          {draft.engine === 'onnx' && (
            <div className="config-field">
              <label>Device and precision</label>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Radio.Group className="choice-cards is-row" value={draft.backend} onChange={(e) => set('backend', e.target.value)}>
                  {(config.onnx_backends ?? []).map((b) => (
                    <Radio key={b.id} value={b.id} disabled={!b.available}>
                      <strong>{b.id === 'cuda' ? 'GPU (CUDA)' : 'CPU'}</strong> {!b.available && <span className="muted">{b.reason}</span>}
                    </Radio>
                  ))}
                </Radio.Group>
                <Radio.Group className="choice-cards is-row" value={draft.precision ?? 'int8'} onChange={(e) => set('precision', e.target.value)}>
                  <Radio value="int8">
                    <strong>int8</strong> <span className="muted">~630 MB · fastest on the CPU</span>
                  </Radio>
                  <Radio value="fp32">
                    <strong>fp32</strong> <span className="muted">~2.4 GB · the one that really runs on a GPU</span>
                  </Radio>
                </Radio.Group>
              </Space>
              <div className="config-hint">
                {draft.backend === 'cuda' && (draft.precision ?? 'int8') === 'int8'
                  ? 'int8 on the GPU was measured slower than on the CPU (0.85 s vs 1.36 s a sentence): its quantized layers run on the CPU and data is copied back and forth.'
                  : draft.backend === 'cuda'
                    ? 'fp32 on the GPU needs ~2.8 GB of free graphics memory. On a 4 GB card the language model already uses most of it — applying checks and refuses rather than slowing both down.'
                    : 'Measured on your recordings: as accurate as Omi Med STT, about 40% faster on the CPU.'}
              </div>
            </div>
          )}

          {draft.engine === 'gguf' && (
            <div className="config-field">
              <label>Backend</label>
              <Radio.Group className="choice-cards" value={draft.backend} onChange={(e) => set('backend', e.target.value)}>
                <Space direction="vertical">
                  {config.backends.map((b) => (
                    <Radio key={b.id} value={b.id} disabled={!b.available}>
                      <strong>{b.id.toUpperCase()}</strong>{' '}
                      {b.installed ? <Tag color="green">installed</Tag> : b.available ? <Tag color="gold">not installed</Tag> : <Tag>unavailable</Tag>}
                      {b.reason && <span className="muted"> {b.reason}</span>}
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
              <div className="config-hint">On a 4 GB graphics card shared with the language model, CPU is usually the better choice.</div>
            </div>
          )}

          {config.refiners && (
            <div className="config-field">
              <label>Second recogniser for names and drugs</label>
              <Radio.Group className="choice-cards" value={draft.refine ?? ''} onChange={(e) => set('refine', e.target.value)}>
                <Space direction="vertical">
                  {config.refiners.map((r) => (
                    <Radio key={r.id || 'off'} value={r.id}>
                      <strong>{r.label}</strong> <span className="muted">{r.note}</span>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
              <div className="config-hint">
                Omi Med STT shows the words live. When a sentence ends, Whisper hears it again knowing this app's patients, drugs, diagnoses and providers; the assistant gets both versions and combines them.
                {config.refiner && !config.refiner.ready && <span style={{ color: 'var(--ant-color-error, #cf1322)' }}> Not running: {config.refiner.error}</span>}
              </div>
            </div>
          )}

          <div className="config-advanced-grid">
            {draft.engine === 'gguf' && (
              <NumberSetting label="CPU threads" hint="0 = automatic." value={draft.threads} min={0} max={64} onChange={(v) => set('threads', v)} />
            )}
            <div className="config-field">
              <label>Pause that ends a sentence: {draft.endpoint_ms} ms</label>
              <Slider min={300} max={3000} step={100} value={draft.endpoint_ms} onChange={(v: number) => set('endpoint_ms', v)} />
              <div className="config-hint">Shorter answers faster; longer cuts fewer sentences in half.</div>
            </div>
            <div className="config-field">
              <label>Live text refresh: every {draft.partial_ms} ms</label>
              <Slider min={250} max={2000} step={50} value={draft.partial_ms} onChange={(v: number) => set('partial_ms', v)} />
              <div className="config-hint">How often the words on screen update while you speak.</div>
            </div>
            <div className="config-field">
              <label>Record voice commands for troubleshooting</label>
              <Radio.Group
                aria-label="Record voice commands for troubleshooting"
                className="choice-bar is-sm"
                optionType="button"
                value={!!draft.record}
                onChange={(e) => set('record', e.target.value as boolean)}
                options={[
                  { value: false, label: 'Off' },
                  { value: true, label: 'On' },
                ]}
              />
              <div className="config-hint">
                Keeps each spoken command's audio, what was heard and what the assistant did, in python/recordings on this computer. Takes effect the next time the microphone is turned on. Leave it off normally.
              </div>
            </div>
          </div>

          {saving && <Alert type="info" showIcon icon={<Loader2 size={16} className="spin" />} message="Loading the speech model — the current one keeps working until the new one is ready…" style={{ marginTop: 12 }} />}

          <Space wrap className="config-actions">
            <Button type="primary" icon={<Save size={15} />} onClick={() => void apply()} loading={saving} disabled={!dirty}>
              Save and apply
            </Button>
            <Button icon={<RotateCcw size={15} />} onClick={() => setDraft(config.settings)} disabled={!dirty || saving}>
              Undo changes
            </Button>
          </Space>
        </>
      )}
    </SectionCard>
  );
}

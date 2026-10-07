/**
 * Choosing a model — the same controls wherever a model is picked: a provider's default in Models, and each
 * agent's own in Agents. Each source lists what it really has: the models this computer's Ollama holds
 * (those that cannot call tools are shown but cannot be picked), the Qwen models the Kaggle server serves,
 * and every OpenRouter model that calls tools.
 */
import type { ReactNode } from 'react';
import { Select, Tooltip, type SelectProps } from 'antd';
import { Cloud, Laptop, Loader2, Server, TriangleAlert } from 'lucide-react';
import type { ModelSource } from '@/services/ai/config';
import { KAGGLE_MODEL_INFO, KAGGLE_MODELS } from '@/services/ai/agentModels';
import { OPENROUTER_LLMS, type OpenRouterModel } from '@/services/ai/compute';
import type { ModelInfo } from '@/services/ai/modelCatalog';

export const SOURCE_ICON: Record<ModelSource, (size?: number) => ReactNode> = {
  local: (size = 16) => <Laptop size={size} />,
  kaggle: (size = 16) => <Server size={size} />,
  openrouter: (size = 16) => <Cloud size={size} />,
};

const gb = (bytes?: number) => (bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : null);
const money = (n: number) => (n === 0 ? 'free' : `$${n < 1 ? n.toFixed(2).replace(/0$/, '') : n.toFixed(n % 1 ? 2 : 0)}`);
const ctxText = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M ctx` : n ? `${Math.round(n / 1000)}K ctx` : '');

/** A dot and a few words: good, bad, in progress or nothing yet. */
export function Pill({ tone, children }: { tone: 'ok' | 'bad' | 'busy' | 'idle' | 'warn'; children: ReactNode }) {
  return (
    <span className={`cfg-pill is-${tone}`}>
      {tone === 'busy' ? <Loader2 size={12} className="spin" /> : <span className="cfg-dot" aria-hidden />}
      {children}
    </span>
  );
}

export interface PickerData {
  localModels: ModelInfo[] | null;
  kaggleServed: string[] | null;
  orModels: OpenRouterModel[] | null;
}

/** This computer's Ollama models, with what each says about itself. */
export function LocalModelSelect({ value, onChange, models, id, ariaLabel, disabled, toolFree }: { value: string; onChange: (v: string) => void; models: ModelInfo[] | null; id?: string; ariaLabel?: string; disabled?: boolean; toolFree?: boolean }) {
  const options = (models ?? []).map((m) => ({
    value: m.name,
    disabled: m.tools === false && !toolFree,
    label: (
      <span className="cfg-option">
        <span className="cfg-option-name">{m.name}</span>
        <span className="cfg-option-notes">
          {m.parameterSize && <span className="cfg-note">{m.parameterSize}</span>}
          {gb(m.sizeBytes) && <span className="cfg-note">{gb(m.sizeBytes)}</span>}
          {m.tools === true && <span className="cfg-note is-good">tool calling</span>}
          {m.tools === false && <span className="cfg-note is-bad">no tool calling</span>}
        </span>
      </span>
    ),
  }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, disabled: false, label: <span className="cfg-option-name">{value}</span> });
  return <Select id={id} aria-label={ariaLabel} size="large" showSearch className="cfg-select" classNames={{ popup: { root: 'cfg-select-pop' } }} value={value} onChange={onChange} options={options} optionLabelProp="value" notFoundContent="No models installed" disabled={disabled} />;
}

/**
 * The models the Kaggle notebook serves, as a dropdown: what each is, whether it calls tools (an agent on one
 * that cannot will not be able to act), and whether the server has it right now.
 */
export function KaggleModelPicker({ value, onChange, served, disabled, ariaLabel, toolFree }: { value: string; onChange: (v: string) => void; served: string[] | null; compact?: boolean; disabled?: boolean; ariaLabel?: string; toolFree?: boolean }) {
  const options = KAGGLE_MODELS.map((m) => {
    const info = KAGGLE_MODEL_INFO[m];
    const missing = !!served?.length && !served.includes(m);
    return {
      value: m,
      label: (
        <span className="cfg-option">
          <span className="cfg-option-name">{info.label}</span>
          <span className="cfg-option-notes">
            {info.tools ? <span className="cfg-note is-good">tool calling</span> : <span className="cfg-note is-bad">no tool calling</span>}
            <span className="cfg-note">{info.note.split(' · ')[0]}</span>
            {missing && <span className="cfg-note is-bad">not served now</span>}
          </span>
        </span>
      ),
      short: info.tools || toolFree ? (
        info.label
      ) : (
        <Tooltip title={`${info.label} calls no tools: an agent on it cannot carry out actions.`}>
          <span className="cfg-short-notools">
            <span className="cfg-short-name">{info.label}</span>
            <span className="cfg-short-flag">
              <TriangleAlert size={12} aria-hidden /> no tools
            </span>
          </span>
        </Tooltip>
      ),
    };
  });
  return (
    <Select
      size="large"
      className="cfg-select kaggle-model-select"
      classNames={{ popup: { root: 'cfg-select-pop' } }}
      value={value}
      onChange={onChange}
      options={options}
      optionLabelProp="short"
      disabled={disabled}
      aria-label={ariaLabel ?? 'Model on Kaggle'}
    />
  );
}

/** Every OpenRouter model that calls tools — CareFlow's picks first, then the rest, newest first; searchable. */
export function OpenRouterModelSelect({ value, onChange, models, id, ariaLabel, disabled }: { value: string; onChange: (v: string) => void; models: OpenRouterModel[] | null; id?: string; ariaLabel?: string; disabled?: boolean }) {
  const option = (m: OpenRouterModel) => ({
    value: m.id,
    search: `${m.name} ${m.id}`,
    label: (
      <span className="cfg-option">
        <span className="cfg-option-name">
          {m.name} <span className="cfg-option-id">{m.id}</span>
        </span>
        <span className="cfg-option-notes">
          <span className="cfg-note">
            {money(m.promptPerM)} in · {money(m.completionPerM)} out /M
          </span>
          {ctxText(m.context) && <span className="cfg-note">{ctxText(m.context)}</span>}
          {m.note && <span className="cfg-note is-pick">{m.note}</span>}
        </span>
      </span>
    ),
  });
  const options: SelectProps['options'] = models
    ? [
        { label: 'Recommended for CareFlow', options: models.filter((m) => m.note).map(option) },
        { label: `All models that call tools · ${models.filter((m) => !m.note).length}`, options: models.filter((m) => !m.note).map(option) },
      ]
    : OPENROUTER_LLMS.map((m) => ({ value: m.name, search: `${m.label} ${m.name}`, label: <span className="cfg-option-name">{m.label}</span> }));
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      size="large"
      showSearch
      className="cfg-select openrouter-model-select"
      classNames={{ popup: { root: 'cfg-select-pop' } }}
      value={value}
      onChange={onChange}
      options={options}
      optionLabelProp="value"
      filterOption={(input, opt) => String((opt as { search?: string } | undefined)?.search ?? '').toLowerCase().includes(input.toLowerCase())}
      loading={!models}
      listHeight={320}
      disabled={disabled}
    />
  );
}

/** The right picker for a source. */
/** `toolFree`: the agent needs no tools (the Summary Agent) — a model that calls none is fine for it, and not flagged. */
export function ModelPicker({ source, value, onChange, data, ariaLabel, disabled, toolFree }: { source: ModelSource; value: string; onChange: (v: string) => void; data: PickerData; ariaLabel?: string; disabled?: boolean; toolFree?: boolean }) {
  if (source === 'local') return <LocalModelSelect value={value} onChange={onChange} models={data.localModels} ariaLabel={ariaLabel} disabled={disabled} toolFree={toolFree} />;
  if (source === 'kaggle') return <KaggleModelPicker value={value} onChange={onChange} served={data.kaggleServed} disabled={disabled} ariaLabel={ariaLabel} toolFree={toolFree} />;
  return <OpenRouterModelSelect value={value} onChange={onChange} models={data.orModels} ariaLabel={ariaLabel} disabled={disabled} />;
}

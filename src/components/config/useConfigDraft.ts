/**
 * The Configuration page's state: what runs now, the draft being put together, the live facts the draft is
 * checked against (the models Ollama has, what the Kaggle server serves, OpenRouter's models), and Apply.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store';
import { uiActions } from '@/store/slices/uiSlice';
import { effectiveConfig, getAIOverride, setAIOverride, type AgentKey, type AgentModel, type AIConfig } from '@/services/ai/config';
import { computeModeOf, getAgentModels, getModelsConfig, llmConfigFor, sourceOfLlm, speechNeedsKaggle } from '@/services/ai/agentModels';
import { checkKaggle, getCompute, listOpenRouterModels, remoteLlmOf, saveModelSetup, type ComputeStatus, type KaggleHealth, type OpenRouterModel } from '@/services/ai/compute';
import { listModels, testModel, unloadOllamaModel, type ModelInfo, type ModelTestResult } from '@/services/ai/modelCatalog';
import { getVoiceController } from '@/services/ai/voiceController';
import { AGENT_ORDER, agentRuns, changesBetween, enabledSources, problemsOf, sameModel, type Draft } from './configModel';

const REFRESH_MS = 15000;

/** What is saved now, as a draft. */
function savedDraft(status: ComputeStatus | null): Draft {
  const llm = effectiveConfig().llm;
  return {
    models: getModelsConfig(),
    agents: getAgentModels(),
    multiAgent: !!llm.multiAgent,
    parallelReads: llm.parallelReads !== false,
    planSteps: llm.planSteps !== false,
    safety: llm.safety !== false,
    planning: llm.planning !== false,
    perf: { numCtx: llm.numCtx, numGpu: llm.numGpu, timeoutMs: llm.timeoutMs, maxSteps: llm.maxSteps },
    kaggleUrl: status?.remote_url ?? '',
    kaggleKey: '',
    openrouterKey: '',
  };
}

export type ApplyResult = { ok: boolean; text: string };

export function useConfigDraft() {
  const dispatch = useAppDispatch();
  const revision = useAppSelector((s) => s.ui.aiConfigRevision);

  // ---- the bridge
  const [status, setStatus] = useState<ComputeStatus | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const loadStatus = useCallback(async () => {
    try {
      const s = await getCompute();
      setStatus(s);
      setBridgeError(null);
      return s;
    } catch (e) {
      setBridgeError((e as Error).message);
      return null;
    }
  }, []);

  // ---- saved vs draft
  const [saved, setSaved] = useState<Draft>(() => savedDraft(null));
  const [draft, setDraft] = useState<Draft>(() => savedDraft(null));
  const resetFrom = useCallback((s: ComputeStatus | null) => {
    const now = savedDraft(s);
    setSaved(now);
    setDraft(now);
  }, []);
  useEffect(() => {
    void loadStatus().then(resetFrom);
  }, [loadStatus, resetFrom, revision]);

  const update = useCallback((change: (d: Draft) => Draft) => setDraft((d) => change(d)), []);

  // ---- This Computer: the models Ollama has, live (a model pulled in a terminal shows up by itself)
  const [localModels, setLocalModels] = useState<ModelInfo[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const localUrl = draft.models.local.apiUrl;
  const localOn = draft.models.local.enabled;
  const refreshLocal = useCallback(async () => {
    try {
      setLocalModels(await listModels('ollama', localUrl));
      setLocalError(null);
    } catch (e) {
      setLocalModels(null);
      setLocalError((e as Error).message);
    }
  }, [localUrl]);
  useEffect(() => {
    if (!localOn) return;
    const first = setTimeout(() => void refreshLocal(), 200);
    const onFocus = () => void refreshLocal();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => document.visibilityState === 'visible' && void refreshLocal(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [localOn, refreshLocal]);

  // ---- Kaggle: checked on its own, before anything is switched
  const [kaggleHealth, setKaggleHealth] = useState<KaggleHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const needsKaggle = draft.models.kaggle.enabled || speechNeedsKaggle(draft.models.speech);
  const checkNow = useCallback(async (url: string, key: string) => {
    if (!url.trim()) return setKaggleHealth(null);
    setChecking(true);
    setKaggleHealth(await checkKaggle(url.trim(), key));
    setChecking(false);
  }, []);
  const lastChecked = useRef('');
  useEffect(() => {
    if (!needsKaggle || !status || !draft.kaggleUrl.trim()) return;
    const token = `${draft.kaggleUrl}|${draft.kaggleKey}`;
    if (token === lastChecked.current) return;
    const t = setTimeout(() => {
      lastChecked.current = token;
      void checkNow(draft.kaggleUrl, draft.kaggleKey);
    }, 600);
    return () => clearTimeout(t);
  }, [needsKaggle, status, draft.kaggleUrl, draft.kaggleKey, checkNow]);
  const kaggleServed = remoteLlmOf(kaggleHealth ?? status?.remote)?.models ?? null;

  // ---- OpenRouter: every model that calls tools, read once it is wanted
  const [orModels, setOrModels] = useState<OpenRouterModel[] | null>(null);
  const [orError, setOrError] = useState<string | null>(null);
  const orOn = draft.models.openrouter.enabled;
  useEffect(() => {
    if (!orOn || orModels) return;
    listOpenRouterModels()
      .then((list) => {
        setOrModels(list);
        setOrError(null);
      })
      .catch((e: Error) => setOrError(e.message));
  }, [orOn, orModels]);

  // ---- what Apply would do
  const changes = useMemo(() => changesBetween(saved, draft), [saved, draft]);
  const problems = useMemo(() => problemsOf(draft, { hasKaggleKey: !!status?.has_key, hasOpenRouterKey: !!status?.has_openrouter_key }), [draft, status]);

  /** One agent's model, tried for real: it must answer and call a tool. Only sources the bridge already has on. */
  const testAgent = useCallback(
    (model: AgentModel, toolFree?: boolean): Promise<ModelTestResult> => testModel(llmConfigFor(model, draft.models, { ...effectiveConfig().llm, ...draft.perf }), { tools: !toolFree }),
    [draft.models, draft.perf],
  );

  const [applying, setApplying] = useState(false);
  const apply = useCallback(async (): Promise<ApplyResult> => {
    setApplying(true);
    try {
      const base = effectiveConfig().llm;
      const master = draft.agents.master;
      const toggles = { ...draft.perf, multiAgent: draft.multiAgent, parallelReads: draft.parallelReads, planSteps: draft.planSteps, safety: draft.safety, planning: draft.planning };
      // A runtime set outside this page (environment, voice) is kept while the master's model is untouched.
      const keepCustom = sourceOfLlm(base) === null && sameModel(master, saved.agents.master);
      const mainLlm: AIConfig['llm'] = keepCustom ? { ...base, ...toggles } : { ...llmConfigFor(master, draft.models, base), ...toggles };

      // 1. The bridge: providers, speech, keys — checked there before anything moves.
      const providers = enabledSources(draft.models);
      const speech = speechNeedsKaggle(draft.models.speech) ? 'remote' : 'local';
      const engine = draft.models.speech === 'kaggle-omi' ? 'omi' : 'whisper';
      const bridgeSide =
        !status ||
        JSON.stringify([...(status.providers ?? [])].sort()) !== JSON.stringify([...providers].sort()) ||
        (status.speech ?? 'local') !== speech ||
        (speech === 'remote' && status.remote_engine !== engine) ||
        (status.remote_url ?? '') !== draft.kaggleUrl.trim() ||
        !!draft.kaggleKey.trim() ||
        !!draft.openrouterKey.trim() ||
        status.mode !== computeModeOf(master.source) ||
        (draft.models.openrouter.enabled && status.openrouter_model !== draft.models.openrouter.model);
      if (bridgeSide) {
        const next = await saveModelSetup({
          mode: keepCustom ? (status?.mode ?? 'local') : computeModeOf(master.source),
          providers,
          speech,
          remote_url: draft.kaggleUrl.trim(),
          remote_key: draft.kaggleKey.trim(),
          remote_engine: engine,
          openrouter_key: draft.openrouterKey.trim(),
          openrouter_model: draft.models.openrouter.model,
        });
        setStatus(next);
      }

      // 2. A small GPU holds one local model: free the old one when no agent runs on it any more.
      const running = AGENT_ORDER.filter((k) => agentRuns(k, draft)).map((k) => draft.agents[k]);
      const localModelsInUse = new Set(running.filter((a) => a.source === 'local').map((a) => a.model));
      if (base.provider === 'ollama' && !localModelsInUse.has(base.model)) await unloadOllamaModel(base.apiUrl, base.model).catch(() => undefined);

      // 3. The assistant: the master's model is the main one; every specialist keeps its own.
      const agents = Object.fromEntries(Object.entries(draft.agents).filter(([k]) => k !== 'master')) as Partial<Record<AgentKey, AgentModel>>;
      setAIOverride({ ...getAIOverride(), llm: mainLlm, models: draft.models, agents });
      const controller = getVoiceController();
      controller.reconfigure();
      const started = Date.now();
      const problem = await controller.warmUp();
      dispatch(uiActions.aiConfigChanged());
      return problem
        ? { ok: false, text: `Saved, but the Master Agent's model could not be loaded: ${problem}` }
        : { ok: true, text: `Applied — the agents are ready (${Math.max(1, Math.round((Date.now() - started) / 1000))} s).` };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    } finally {
      setApplying(false);
    }
  }, [draft, saved, status, dispatch]);

  const discard = useCallback(() => setDraft(saved), [saved]);

  return {
    status,
    bridgeError,
    saved,
    draft,
    update,
    changes,
    problems,
    apply,
    applying,
    discard,
    localModels,
    localError,
    refreshLocal,
    kaggleHealth,
    kaggleServed,
    checking,
    checkKaggle: () => checkNow(draft.kaggleUrl, draft.kaggleKey),
    orModels,
    orError,
    testAgent,
  };
}

export type ConfigDraftState = ReturnType<typeof useConfigDraft>;

/**
 * Voice controller — the microphone and the assistant, wired together:
 *
 *   microphone ─► Omi Med STT (live partials, final per utterance)
 *              ─► agent: Qwen decides and calls tools ─► app
 *
 * It owns the microphone's lifecycle and the assistant panel's state
 * (voiceSlice), and hands every finished utterance — or anything typed into
 * the assistant — to the agent. It does not interpret what was said.
 */
import type { AppStore, RootState } from '@/store';
import { voiceActions, type PendingSlot } from '@/store/slices/voiceSlice';
import { monitorActions } from '@/store/slices/monitorSlice';
import { navigationActions } from '@/store/slices/navigationSlice';
import { uiActions } from '@/store/slices/uiSlice';
import { deletePatient, setCurrentPatient, setLastSearch, patientSelectors } from '@/store/slices/patientSlice';
import { providerSelectors } from '@/store/slices/providerSlice';
import { inboxActions } from '@/store/slices/inboxSlice';
import { recordSlices } from '@/store/slices/recordSlices';
import { selectCurrentProvider } from '@/hooks/useProviderData';
import type { AgentName, AgentStep, AIContext, DebugTrace, ExtractionResult, PendingConfirmation, ToolResult } from '@/types/ai';
import type { EntityKind, RecordKind } from '@/types/records';
import { NavigationRegistry } from '@/registry/navigationRegistry';
import { PageRegistry } from '@/registry/pageRegistry';
import { FormRegistry } from '@/registry/formRegistry';
import { FieldRegistry } from '@/registry/fieldRegistry';
import { InboxVoiceRegistry } from '@/services/inbox/inboxVoice';
import { buildPatientNarrative } from '@/services/records/patientNarrative';
import { buildProviderWorkload } from '@/services/provider/providerWorkload';
import { recordLabel, type AnyRecord } from '@/services/records/recordMapping';
import dayjs from 'dayjs';
import { logout } from '@/store/slices/authSlice';
import { ListRegistry } from '@/registry/listRegistry';
import { AiSummaryRegistry } from '@/registry/aiSummaryRegistry';
import { CARE_PLAN_FORM_ID, CarePlanRegistry } from '@/registry/carePlanRegistry';
import { bridgeHttpUrl, effectiveConfig, getAIOverride, plansLongRequests, setAIOverride, type AIConfig } from './config';
import { listModels, unloadOllamaModel } from './modelCatalog';
import { getSttConfig, postDiagnosticTrace, saveSttConfig } from './sttConfig';
import { createChatLLM, ModelUnavailableError, type ChatLLM } from './providers/llm';
import { createSTT, type ListeningSession, type MicrophoneRecognizer } from './providers/stt';
import { Agent, type AgentOutcome } from './agent/agent';
import { MultiAgentOrchestrator, type AgentLlms, type MultiAgentHooks } from './agents/master';
import { PlanningAgent } from './agents/planning';
import { RequirementGate } from './agents/requirementGate';
import { detectOperation } from './safety/operations';
import { AGENT_NAMES, AGENT_TITLES } from './agents/taskGraph';
import { modelLabel, resolveAgentLlms } from './agentModels';
import { detectTarget, type SummaryTarget } from './summary/summaryTarget';
import { collectFacts, type SummarySource } from './summary/summaryFacts';
import { writeSummary } from './summary/summaryWriter';
import { AppRuntime, type RuntimeDeps, type SummaryOutcome } from './agent/runtime';
import { buildTools } from './agent/tools';
import { isAssistantSpeaking, setSpeakReplies, speak, stopSpeaking } from './speech';
import { MonitorRecorder } from './monitor/recorder';
import { SafetyAgent } from './safety/safetyAgent';
import { checkReply } from './safety/replyCheck';
import { SafetyReviewer } from './safety/reviewer';
import { agentModelInfo, speechInfo } from './monitor/models';

/** Settling a draft the provider left for something else: save it (or confirm what waits), discard it, or keep it. */
const SAVE_DRAFT = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|save( it| that| the \w+)?( first)?|go ahead|do it|delete( them| it)?( first)?|file it)\b/i;
const DISCARD_DRAFT = /^\s*(no|nope|discard|drop|cancel|don'?t( save)?|close it|throw it away|forget it)\b/i;
const KEEP_DRAFT = /^\s*(keep|leave it|not now|later|wait|never ?mind)\b/i;

/** What answers a confirmation: yes, no, save, cancel — or a change to what waits ("make it twice daily"). */
const ANSWER = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|save( it)?|go ahead|do it|no|nope|cancel|don'?t|stop|change|make it|set|use)\b/i;
/** Going somewhere else, or asking for something else — misheard and misspelled words too ("sleect"). */
const MOVES_ON = /\b(go ?to|goto|navigate|open|take me|switch to|s(e|l)?le+c?t|selct|slect|choose|pick|find|search|look up|summari[sz]e|summary|overview|show me|log ?out|sign ?out)\b/i;

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function patientRecords(state: RootState, kind: RecordKind): AnyRecord[] {
  const patientId = state.patients.currentPatientId;
  if (!patientId) return [];
  return recordSlices[kind].selectors.selectAll(state).filter((r) => r.patientId === patientId) as AnyRecord[];
}

/**
 * Providers swapped in (tests). `planSteps`: split long requests into steps — off for a scripted model unless
 * asked for. `multiAgent`: the multi-agent mode — for a scripted model only when a test asks for it.
 */
type ProviderOverrides = { stt?: MicrophoneRecognizer; llm?: ChatLLM; planSteps?: boolean; multiAgent?: boolean; parallelReads?: boolean; safety?: boolean; planning?: boolean; /** The Safety Agent's model reviews on the given model (live runs). */ reviewer?: boolean; /** Live runs: some agents on another model than `llm` (the Summary Agent on MedGemma). */ agentLlms?: Partial<Record<AgentName, ChatLLM>> };

/** A scripted model answers only what its script says, so it plans only when a test asks for it. */
const planning = (config: AIConfig, overrides?: ProviderOverrides) => overrides?.planSteps ?? (overrides?.llm ? false : plansLongRequests(config.llm));

/** Whether requests go to the master agent and its specialists rather than the single assistant. */
const multiAgentMode = (config: AIConfig, overrides?: ProviderOverrides) => overrides?.multiAgent ?? (overrides?.llm ? false : !!config.llm.multiAgent);

export class VoiceController {
  private llm: ChatLLM;
  private stt: MicrophoneRecognizer;
  readonly runtime: AppRuntime;
  private readonly deps: RuntimeDeps;
  /** The single assistant. In multi-agent mode it still extracts notes for the AI Summary (not a spoken request). */
  private agent: Agent;
  /** Multi-agent mode: the master agent and its specialists, over the same tools and runtime. */
  private orchestrator: MultiAgentOrchestrator | null = null;
  /** Single-agent mode: the Planning Agent before the assistant — nothing runs until a request is complete. */
  private gate: RequirementGate | null = null;
  /** The specialists' own models (Configuration → Agents), beside the main one — released on reconfigure. */
  private agentLlms: ChatLLM[] = [];
  private session: ListeningSession | null = null;
  /**
   * Which microphone session is current. A session that was stopped or replaced may still deliver a
   * late final, error or end; only the current one may act on the controller.
   */
  private sessionGen = 0;
  private abort: AbortController | null = null;
  private busy = false;
  /** User intent: the microphone stays on until the user turns it off (or pauses long enough). */
  private micActive = false;
  /** Utterances are handled strictly one after another. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped by "stop everything": utterances queued before it are dropped, not run. */
  private stopGeneration = 0;
  /**
   * The provider's words for the request in progress — every utterance of it, the answers to its questions
   * included. The Safety Agent traces every value an agent sends to the application to these words.
   */
  private requestWords: string[] = [];
  /** The provider's words of the last few requests before this one (what "it" or "him" may point back to). */
  private recentWords: string[] = [];
  /** The last reply asked the provider something: what they say next belongs to the same request. */
  private awaitingAnswer = false;
  /**
   * A new request the provider made while a draft (a form or care plan, a deletion, a filing) waited for their
   * yes: held — never applied to that draft — until they say whether to save or discard what waits.
   */
  private heldRequest: { said: string; alsoHeard?: string } | null = null;
  /** The Safety Agent, between every agent and its tools (null: switched off). */
  private safety: SafetyAgent | null = null;
  /** An unfinished fragment the model asked to hold until the user continues. */
  private held: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The utterance being heard began while the assistant was speaking — it is an echo, not a command. */
  private echo = false;
  /** The bridge is recording utterances (Configuration → voice diagnostics): send it what happened to each. */
  private recording = false;
  static readonly HOLD_MS = 6000;
  /** A pause this long turns the microphone off (and finishes a dictated note). */
  static SILENCE_MS = 10000;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A finished utterance waits this long for the speaker to continue before it goes to the model,
   * so a breath between sentences (or a comma in a long instruction) does not split the request.
   * 0 hands every utterance over at once.
   */
  static TURN_GRACE_MS = 1200;
  /** Once speech resumes, the turn is held at most this long without new words (noise, not speech). */
  static TURN_STALL_MS = 5000;
  /** Utterances of the turn being spoken, not yet handed to the model. */
  private turn: { parts: string[]; alts: Array<string | undefined>; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Dictation into a text box (the AI Summary): speech becomes text, never commands. */
  private dictation: { onText: (text: string) => void; onInterim?: (text: string) => void } | null = null;
  /** A clinical note being dictated to the assistant, collected until the user pauses. */
  private note: string[] | null = null;
  /** Agent Monitoring: what the agents do, recorded as an audit trail. It only observes. */
  private readonly monitor = new MonitorRecorder(
    (events) => this.store.dispatch(monitorActions.record(events)),
    (agent) => (agent === 'safety' ? undefined : ((this.orchestrator?.agentModelNames as Partial<Record<string, string>> | undefined)?.[agent] ?? this.llm.name)),
  );

  constructor(private readonly store: AppStore, overrides?: ProviderOverrides) {
    const config = effectiveConfig();
    this.llm = overrides?.llm ?? createChatLLM(config.llm);
    this.stt = overrides?.stt ?? createSTT(config);
    this.deps = this.buildDeps();
    this.runtime = new AppRuntime(this.deps);
    this.agent = this.buildAgents(config, overrides);
    this.publishProviders();
    // The provider saving or closing a form the assistant prepared, with the form's own buttons.
    FormRegistry.onSettled((event) => this.onFormSettled(event));

    let signedIn = !!store.getState().auth?.token;
    let lastPatient = store.getState().patients?.currentPatientId ?? null;
    store.subscribe(() => {
      const patient = this.store.getState().patients?.currentPatientId ?? null;
      if (patient && patient !== lastPatient) this.recentPatients = [patient, ...this.recentPatients.filter((id) => id !== patient)].slice(0, 10);
      lastPatient = patient;
      // Signing out ends voice control at once: nothing about the last patient stays on screen.
      const now = !!this.store.getState().auth?.token;
      const signedOut = signedIn && !now;
      signedIn = now;
      if (signedOut) this.shutdown();
    });
  }

  /**
   * Load the model and prime its prompt cache, so the first request is not the slow one.
   * Called once the application shell is up (not on import, and not from tests' fakes).
   */
  async warmUp(): Promise<string | null> {
    const { dispatch } = this.store;
    // Already in memory (e.g. after a page refresh): the warm-up only primes the prompt cache.
    const resident = (await this.llm.isLoaded?.()) ?? false;
    dispatch(voiceActions.setModelStatus({ status: resident ? 'warming' : 'loading' }));
    const problem = await (this.orchestrator ?? this.agent).warmUp();
    dispatch(voiceActions.setModelStatus(problem ? { status: 'error', error: problem } : { status: 'ready' }));
    return problem;
  }

  /** Sign-out: microphone off, pending work dropped, conversation cleared — silently. */
  shutdown() {
    this.abort?.abort(new DOMException('Cancelled: signed out', 'AbortError'));
    this.micActive = false;
    this.clearHeld();
    this.dropTurn();
    this.clearSilenceTimer();
    this.note = null;
    this.dictation = null;
    this.releaseSession()?.cancel();
    this.agent.resetConversation();
    this.orchestrator?.resetConversation();
    this.gate?.drop();
    this.requestWords = [];
    this.recentWords = [];
    this.awaitingAnswer = false;
    const { dispatch } = this.store;
    dispatch(voiceActions.setTaskGraph(null));
    dispatch(voiceActions.setMicActive(false));
    dispatch(voiceActions.resetVoice());
    dispatch(voiceActions.clearHistory());
    dispatch(monitorActions.reset());
    dispatch(voiceActions.setPanelOpen(false));
    dispatch(voiceActions.setHelpOpen(false));
  }

  /**
   * Re-create the providers after the configuration changed (or swap them in, e.g. in tests).
   * A running microphone is turned off first: it belongs to the old speech connection.
   */
  reconfigure(overrides?: ProviderOverrides) {
    const config = effectiveConfig();
    if (this.micActive) this.stopListening();
    this.llm.dispose?.();
    for (const llm of this.agentLlms) llm.dispose?.();
    this.agentLlms = [];
    this.llmByKey.clear();
    this.llm = overrides?.llm ?? createChatLLM(config.llm);
    this.stt = overrides?.stt ?? createSTT(config);
    // A new assistant starts with nothing open: no request held, no answer awaited.
    this.requestWords = [];
    this.awaitingAnswer = false;
    this.agent = this.buildAgents(config, overrides);
    this.publishProviders();
  }

  /**
   * The single assistant, and — in multi-agent mode — the master and its specialists. Both get the same
   * tool objects and the same runtime: only how a request is orchestrated differs.
   */
  private buildAgents(config: AIConfig, overrides?: ProviderOverrides): Agent {
    const tools = buildTools();
    const agent = new Agent(this.llm, this.runtime, () => this.buildContext(), config.llm.maxSteps, planning(config, overrides));
    agent.setTools(tools);
    this.orchestrator = null;
    if (multiAgentMode(config, overrides)) {
      // A scripted model (tests) answers for every agent; otherwise each agent gets the model it was given.
      const own = overrides?.agentLlms;
      const llms: AgentLlms = overrides?.llm ? (own ? (agent) => (agent !== 'master' && agent !== 'planning' ? own[agent] : undefined) ?? this.llm : this.llm) : this.perAgentLlms();
      this.orchestrator = new MultiAgentOrchestrator(llms, this.runtime, () => this.buildContext(), {
        maxSteps: config.llm.maxSteps,
        parallelReads: overrides?.parallelReads ?? config.llm.parallelReads !== false,
        // A scripted model (tests) plans only when a test asks for it: its script answers every agent in turn.
        planning: overrides?.planning ?? (overrides?.llm ? false : config.llm.planning !== false),
      });
      this.orchestrator.setTools(tools);
    }
    // Single-agent mode gathers requirements too: the same Planning Agent (on the assistant's model) before it
    // runs. A scripted model (tests) only when a test asks for it: its script answers every call in turn.
    const gathers = overrides?.planning ?? (overrides?.llm ? false : config.llm.planning !== false);
    this.gate = !this.orchestrator && gathers ? new RequirementGate(new PlanningAgent(this.llm, this.runtime, () => this.buildContext(), config.llm.maxSteps, () => this.safety)) : null;
    this.store.dispatch(voiceActions.setTaskGraph(null));
    // The Safety Agent sits between every agent and its tools: the single assistant, the master, the specialists.
    this.safety = (overrides?.safety ?? config.llm.safety !== false) ? this.buildSafety() : null;
    // Its model (Configuration → Agents) reviews risky calls, in every mode. A scripted model (tests) has no
    // reviewer: its script answers the agents in turn.
    const reviewerLlm = this.safety && !overrides?.llm ? resolveAgentLlms().safety : null;
    this.safety?.setReviewer(reviewerLlm ? new SafetyReviewer(this.llmFor(reviewerLlm)) : this.safety && overrides?.llm && overrides.reviewer ? new SafetyReviewer(overrides.llm) : null);
    agent.setSafety(this.safety);
    this.orchestrator?.setSafety(this.safety);
    this.observe(() => {
      const names = this.orchestrator?.agentModelNames ?? { master: this.llm.name };
      const configs = overrides?.llm ? null : this.orchestrator ? resolveAgentLlms() : { master: config.llm };
      const models = agentModelInfo(names, configs);
      if (this.safety) models.safety = reviewerLlm ? { ...agentModelInfo({ safety: this.safety.reviewerModel ?? '' }, { safety: reviewerLlm }).safety!, model: `Rules + ${reviewerLlm.model}` } : { model: 'Rules — no model', provider: 'This app' };
      this.monitor.configured(this.orchestrator ? 'multi' : 'single', models, speechInfo(this.stt.providerName));
    });
    return agent;
  }

  /**
   * The Safety Agent, reading the application: the provider's words for the request in progress, who is
   * selected, the names on record, and what a create form or the care plan holds now.
   */
  private buildSafety(): SafetyAgent {
    const { getState } = this.store;
    return new SafetyAgent({
      utterances: () => this.requestWords,
      recent: () => this.recentWords,
      slots: () => {
        const all = recordSlices.appointment.selectors.selectAll(getState()) as Array<{ date?: string; startTime?: string }>;
        return { dates: all.map((a) => a.date ?? '').filter(Boolean), times: all.map((a) => a.startTime ?? '').filter(Boolean) };
      },
      providerName: () => selectCurrentProvider(getState())?.fullName ?? null,
      providers: () => providerSelectors.selectAll(getState()).map((p) => p.fullName),
      selectedPatient: () => {
        const s = getState();
        const p = s.patients.currentPatientId ? patientSelectors.selectById(s, s.patients.currentPatientId) : undefined;
        return p ? { id: p.id, name: p.fullName } : null;
      },
      patients: () => patientSelectors.selectAll(getState()).map((p) => ({ id: p.id, fullName: p.fullName, mrn: p.mrn })),
      known: (kind) => this.deps.knownNames?.(kind) ?? [],
      recordLabel: (kind, id) => {
        const row = (recordSlices[kind].selectors.selectAll(getState()) as AnyRecord[]).find((r) => (r as { id?: string }).id === id);
        return row ? recordLabel(kind, row) : undefined;
      },
      openFormId: () => (CarePlanRegistry.isOpen() ? null : (FormRegistry.active()?.formId ?? null)),
      inPlace: (what) => CarePlanRegistry.isOpen() || !!FormRegistry.active()?.isOpen() || NavigationRegistry.pathname().startsWith(what === 'patient' ? '/patients' : '/summary'),
      staged: () => {
        if (this.runtime.isEditing()) return []; // a saved record being changed holds what was saved before
        const plan = CarePlanRegistry.get();
        if (plan?.isOpen()) return plan.entries().map((e) => ({ kind: e.kind, values: e.values }));
        const form = FormRegistry.active();
        if (!form?.isOpen()) return [];
        return (form.entries?.getAll() ?? [form.getValues()]).map((values) => ({ kind: form.formId, values }));
      },
      discardStaged: () => this.runtime.discardStaged(),
      findPatient: (raw) => this.runtime.findPatient(raw),
      reviewed: (call, outcome) => this.observe(() => this.monitor.safetyReview(call.name, outcome)),
    });
  }

  /** Monitoring never gets in the way of a request: a problem recording it is only logged. */
  private observe(record: () => void) {
    try {
      record();
    } catch (e) {
      console.warn('Agent monitoring could not record an event:', e);
    }
  }

  /**
   * Every agent's model, from Configuration → Agents: the master runs on the main model (this.llm); a
   * specialist on its own, one adapter per distinct model — agents on the same model share it.
   */
  private perAgentLlms(): AgentLlms {
    const configs = resolveAgentLlms();
    for (const name of [...AGENT_NAMES, 'planning' as const]) this.llmFor(configs[name]);
    return (agent) => this.llmFor(configs[agent]);
  }

  /** One adapter per distinct model: the main one for the master's, a shared one for every other. */
  private readonly llmByKey = new Map<string, ChatLLM>();
  private llmFor(config: AIConfig['llm']): ChatLLM {
    const keyOf = (c: AIConfig['llm']) => `${c.provider}|${c.apiUrl}|${c.model}`;
    const key = keyOf(config);
    if (key === keyOf(effectiveConfig().llm)) return this.llm;
    let llm = this.llmByKey.get(key);
    if (!llm) {
      llm = createChatLLM(config);
      this.llmByKey.set(key, llm);
      this.agentLlms.push(llm);
    }
    return llm;
  }

  /** The model each agent thinks with (multi-agent mode), or null in single-agent mode. */
  get agentModelNames() {
    return this.orchestrator?.agentModelNames ?? null;
  }

  /** Multi-agent mode is on. */
  get isMultiAgent() {
    return !!this.orchestrator;
  }

  /** The model runtime in use (e.g. "ollama:qwen3.5:4b"). */
  get modelName() {
    return this.llm.name;
  }

  /** The tools the model can call — also what the help sheet lists. */
  get tools() {
    return (this.orchestrator ?? this.agent).toolList;
  }

  private publishProviders() {
    this.store.dispatch(voiceActions.setProviders({ stt: this.stt.providerName, llm: this.llm.name }));
    this.store.dispatch(voiceActions.setMicSupported(this.stt.isSupported()));
  }

  // ------------------------------------------------------------- microphone

  get isMicActive() {
    return this.micActive;
  }

  /** Turn the microphone ON. It stays on across utterances and replies until turned off. */
  startListening() {
    const { dispatch } = this.store;
    if (this.micActive && this.session) return;
    this.micActive = true;
    dispatch(voiceActions.setMicActive(true));
    dispatch(voiceActions.setPanelOpen(true));
    dispatch(voiceActions.setResponse(null));
    if (!this.busy) dispatch(voiceActions.setStatus('listening'));
    this.openSession();
    this.armSilenceTimer();
  }

  private openSession() {
    const { dispatch } = this.store;
    const gen = ++this.sessionGen;
    const live = () => gen === this.sessionGen;
    this.session = this.stt.start({
      onSpeechStart: () => {
        if (!live() || !this.micActive) return;
        // The second recogniser listens for the names that matter now (the page may have changed).
        this.session?.setVocabulary?.(this.buildVocabulary());
        // Speech that begins while the assistant is talking is its own voice from the loudspeaker.
        this.echo = isAssistantSpeaking();
        this.armSilenceTimer();
        // The speaker continued: the turn waits for the rest.
        if (!this.echo && this.turn) this.armTurn(VoiceController.TURN_STALL_MS);
      },
      onInterim: (text) => {
        if (!live() || !this.micActive || this.echo) return;
        const shown = text ? [this.held?.text, ...(this.turn?.parts ?? []), text].filter(Boolean).join(' ') : text;
        dispatch(voiceActions.setInterimTranscript(shown));
        this.dictation?.onInterim?.(text);
        if (text) this.armSilenceTimer();
        if (text && this.turn) this.armTurn(VoiceController.TURN_STALL_MS);
      },
      onTranscribing: () => {
        if (!live() || !this.micActive) return;
        this.armSilenceTimer();
        if (!this.busy && !this.dictation) dispatch(voiceActions.setStatus('transcribing'));
      },
      onFinal: (text, alt) => {
        if (!live() || !this.micActive) return;
        this.armSilenceTimer();
        if (this.echo) {
          this.echo = false;
          dispatch(voiceActions.setInterimTranscript(''));
          this.diagnose({ kind: 'ignored_echo', transcript: text });
          return;
        }
        this.collectUtterance(text, alt);
      },
      onError: (error, fatal) => {
        if (!live() || !this.micActive) return;
        dispatch(voiceActions.setError(error.message));
        if (!fatal) return;
        dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: '', response: error.message, status: 'error', timestamp: Date.now() }));
        this.micActive = false;
        this.releaseSession();
        dispatch(voiceActions.setMicActive(false));
      },
      onUnclear: () => {
        if (!live() || !this.micActive || this.echo) return;
        // Better to ask again than to act on a guess.
        const message = "I couldn't hear that clearly — please say it again, a little closer to the microphone.";
        dispatch(voiceActions.setInterimTranscript(''));
        dispatch(voiceActions.setResponse(message));
        this.diagnose({ kind: 'unclear' });
        speak(message);
      },
      onReady: ({ recording }) => {
        if (live()) this.recording = recording;
      },
      onEnd: () => {
        // A stopped or replaced session ending must not touch the one that is running now.
        if (!live()) return;
        this.releaseSession();
        this.flushTurn();
        // The session only ends on its own after a fatal error; if the user still wants the mic, reopen it.
        if (this.micActive) setTimeout(() => this.micActive && !this.session && this.openSession(), 300);
      },
    });
  }

  /**
   * The names the second recogniser should expect, from the app's own data: the providers, the
   * drugs and diagnoses on record, and the patients that matter now — the selected one, the ones on
   * screen, then the rest while they fit. Whisper reads only ~220 tokens of prompt, so it is kept
   * short; a name left out is still matched by spelling when the assistant looks it up.
   */
  private buildVocabulary(): string {
    const state = this.store.getState();
    const deps = this.deps;
    // Plain names only ("Hyperlipidemia", not "Hyperlipidemia, unspecified"), each once.
    const plain = (names: string[], maxWords: number) => {
      const seen = new Set<string>();
      return names.filter((n) => {
        const key = n.toLowerCase();
        if (/[,(]/.test(n) || n.split(/\s+/).length > maxWords || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const fit = (names: string[], budget: number) => {
      const out: string[] = [];
      let used = 0;
      for (const n of names) {
        if (used + n.length + 2 > budget) break;
        out.push(n);
        used += n.length + 2;
      }
      return out;
    };
    // The patients most likely to be named: selected, recently worked on, searched for, seen today.
    const name = (id: string) => patientSelectors.selectById(state, id)?.fullName;
    const selected = name(state.patients.currentPatientId ?? '');
    const recent = this.recentPatients.map(name);
    const search = deps.getPatientSearch().trim();
    const onScreen = search ? deps.findPatients(search).map((p) => p.fullName) : [];
    const today = dayjs().format('YYYY-MM-DD');
    const seenToday = recordSlices.appointment.selectors.selectAll(state).filter((a) => a.date === today).map((a) => a.patientName);
    const everyone = patientSelectors.selectAll(state).map((p) => p.fullName);
    const patients = fit([...new Set([selected, ...recent, ...onScreen, ...seenToday, ...everyone].filter((n): n is string => !!n))], 320);
    const drugs = fit(plain(deps.knownNames?.('medication') ?? [], 3), 200);
    const conditions = fit(plain(deps.knownNames?.('diagnosis') ?? [], 4), 240);
    const providers = fit(providerSelectors.selectAll(state).map((p) => p.fullName.replace(/^Dr\.?\s+/, '')), 120);
    // Whisper keeps the END of a long prompt, so the most important names go last: the selected patient.
    return [
      providers.length ? `Providers: ${providers.join(', ')}.` : '',
      conditions.length ? `Diagnoses: ${conditions.join(', ')}.` : '',
      drugs.length ? `Medications: ${drugs.join(', ')}.` : '',
      patients.length ? `Patients: ${[...patients].reverse().join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** Patients selected lately, newest first — likely to be named again. */
  private recentPatients: string[] = [];

  /** Detach the current session: nothing it reports from now on reaches the controller. */
  private releaseSession(): ListeningSession | null {
    const session = this.session;
    this.session = null;
    this.sessionGen++;
    return session;
  }

  /** Start capturing speech as plain text (the AI Summary box). Returns a stop function. */
  startDictation(handlers: { onText: (text: string) => void; onInterim?: (text: string) => void }): () => void {
    this.dictation = handlers;
    const { dispatch } = this.store;
    dispatch(voiceActions.setError(null));
    dispatch(voiceActions.setStatus('listening'));
    this.micActive = true;
    dispatch(voiceActions.setMicActive(true));
    if (!this.session) this.openSession();
    return () => this.stopDictation();
  }

  stopDictation() {
    if (!this.dictation) return;
    this.dictation = null;
    this.micActive = false;
    const { dispatch } = this.store;
    dispatch(voiceActions.setMicActive(false));
    dispatch(voiceActions.setInterimTranscript(''));
    dispatch(voiceActions.setStatus('idle'));
    this.releaseSession()?.stop();
  }

  get isDictating() {
    return this.dictation !== null;
  }

  /**
   * A finished utterance. Commands are collected into a turn and handed over only once the speaker
   * has really stopped (TURN_GRACE_MS with no new speech); dictation and notes take it at once.
   */
  private collectUtterance(text: string, alt?: string) {
    const clean = text.trim();
    if (this.dictation || this.note || VoiceController.TURN_GRACE_MS <= 0) {
      this.flushTurn();
      return this.acceptUtterance(clean, alt);
    }
    if (!clean && !this.turn) return;
    this.turn ??= { parts: [], alts: [], timer: null };
    if (clean) {
      this.turn.parts.push(clean);
      this.turn.alts.push(alt);
    }
    this.store.dispatch(voiceActions.setInterimTranscript([this.held?.text, ...this.turn.parts].filter(Boolean).join(' ') + ' …'));
    this.armTurn(VoiceController.TURN_GRACE_MS);
  }

  private armTurn(ms: number) {
    if (!this.turn) return;
    if (this.turn.timer) clearTimeout(this.turn.timer);
    this.turn.timer = setTimeout(() => this.flushTurn(), ms);
  }

  /** Hand the collected turn to the model now. */
  private flushTurn() {
    const turn = this.dropTurn();
    if (!turn?.parts.length) return;
    // The second recogniser's version of the whole turn, where it heard a part; Omi's words elsewhere.
    const alt = turn.alts.some(Boolean) ? turn.parts.map((p, i) => turn.alts[i] ?? p).join(' ') : undefined;
    this.acceptUtterance(turn.parts.join(' '), alt);
  }

  private dropTurn() {
    const turn = this.turn;
    if (turn?.timer) clearTimeout(turn.timer);
    this.turn = null;
    return turn;
  }

  private acceptUtterance(text: string, alt?: string) {
    const { dispatch } = this.store;
    const clean = text.trim();
    dispatch(voiceActions.setInterimTranscript(''));
    if (!clean) return;
    if (this.dictation) return this.dictation.onText(clean);
    if (this.note) {
      this.note.push(clean);
      dispatch(voiceActions.setTranscript(this.note.join(' ')));
      return;
    }
    void this.handleTranscript(clean, { alt });
  }

  private armSilenceTimer() {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => this.onSilence(), VoiceController.SILENCE_MS);
  }

  private clearSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /** Nobody spoke for a while: finish a dictated note, or turn the microphone off. */
  private onSilence() {
    this.silenceTimer = null;
    if (!this.micActive || this.dictation) return;
    if (this.note) return this.finishNote();
    // Reading a record takes longer than a pause. In the Inbox and during patient work (the Patients
    // page, the patient form, a patient question or confirmation) the mic stays on until turned off.
    const state = this.store.getState();
    const page = state.navigation?.currentPageId ? PageRegistry.get(state.navigation.currentPageId) : undefined;
    const patientWork =
      state.navigation?.currentPageId === 'patients' ||
      FormRegistry.active()?.formId === 'patient' ||
      state.voice.pendingSlot?.formId === 'patient' ||
      state.voice.pendingConfirmation?.formId === 'patient';
    if (this.busy || page?.module === 'inbox' || patientWork) return this.armSilenceTimer();
    this.stopListening();
  }

  /** "Mic off": the user pressed it, asked for it, or paused long enough. */
  stopListening() {
    const { dispatch } = this.store;
    if (this.note) return this.finishNote();
    this.clearSilenceTimer();
    this.micActive = false;
    this.flushTurn(); // what was just said still goes to the assistant
    const held = this.takeHeld();
    if (held) void this.handleTranscript(held, { fromHold: true }); // don't lose what was said right before Mic Off
    dispatch(voiceActions.setMicActive(false));
    dispatch(voiceActions.setInterimTranscript(''));
    this.releaseSession()?.stop();
    if (!this.busy && ['listening', 'transcribing'].includes(this.store.getState().voice.status)) dispatch(voiceActions.setStatus('idle'));
  }

  /** Explicit Cancel: abort what the assistant is doing AND turn the microphone off. */
  cancel() {
    this.abort?.abort(new DOMException('Cancelled with the Cancel button', 'AbortError'));
    this.micActive = false;
    this.clearHeld();
    this.dropTurn();
    this.clearSilenceTimer();
    this.note = null;
    this.releaseSession()?.cancel();
    const { dispatch } = this.store;
    dispatch(voiceActions.setMicActive(false));
    dispatch(voiceActions.setInterimTranscript(''));
    dispatch(voiceActions.setStatus('cancelled'));
    dispatch(voiceActions.setCurrentAction(null));
    dispatch(voiceActions.setResponse('Cancelled.'));
    setTimeout(() => {
      if (this.store.getState().voice.status === 'cancelled') dispatch(voiceActions.setStatus('idle'));
    }, 1200);
  }

  toggleListening() {
    if (this.micActive) this.stopListening();
    else this.startListening();
  }

  // ------------------------------------------------------------- clinical note

  /** The model decided the user is dictating a note: collect it until they pause, then extract. */
  private beginNote(first?: string) {
    const { dispatch } = this.store;
    this.note = first ? [first] : [];
    dispatch(voiceActions.setTranscript(first ?? ''));
    dispatch(voiceActions.setStatus('listening'));
    dispatch(voiceActions.setCurrentAction('Taking a clinical note — keep talking, pause when you are done…'));
    if (!this.micActive) this.startListening();
    this.armSilenceTimer();
  }

  private finishNote() {
    const parts = this.note;
    this.note = null;
    this.clearSilenceTimer();
    this.store.dispatch(voiceActions.setCurrentAction(null));
    const text = (parts ?? []).join(' ').replace(/\s+/g, ' ').trim();
    if (this.micActive) this.stopListening();
    if (text) this.handoffNote(text);
  }

  private handoffNote(text: string) {
    const { dispatch } = this.store;
    dispatch(voiceActions.setSummaryHandoff({ id: uid('note'), text }));
    NavigationRegistry.navigate(PageRegistry.get('summary-ai')!.path);
  }

  /** AI Summary: extract a note into items for review. */
  extractNote(text: string): Promise<ExtractionResult> {
    return this.agent.extractNote(text, { onStep: (step) => this.recordStep(step) });
  }

  // --------------------------------------------------------------- pipeline

  private takeHeld(): string | null {
    const held = this.held?.text ?? null;
    this.clearHeld();
    return held;
  }

  private clearHeld() {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
  }

  /**
   * Hand an utterance (spoken or typed) to the agent. Utterances are queued and handled one at a
   * time, so speech captured while the assistant is working is never lost.
   */
  handleTranscript(text: string, options: { fromHold?: boolean; alt?: string } = {}): Promise<AgentOutcome | null> {
    if (!text.trim()) return Promise.resolve(null);
    const held = options.fromHold ? null : this.takeHeld();
    const said = held ? `${held} ${text.trim()}` : text.trim();
    const alsoHeard = options.alt?.trim() ? (held ? `${held} ${options.alt.trim()}` : options.alt.trim()) : undefined;
    const generation = this.stopGeneration;
    const next = () => (generation === this.stopGeneration ? this.process(said, alsoHeard) : Promise.resolve(null));
    const run = this.chain.then(next, next);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Stop everything (Agent Monitoring → Stop & clear): the request in progress is cancelled — every agent's
   * model call aborted — what was queued behind it is dropped, a task waiting on the provider is dropped with
   * its question or confirmation (nothing is saved), the microphone and the voice go quiet, and the monitor
   * starts afresh with every agent idle. Resolves once all of it is done.
   */
  async stopAll(): Promise<void> {
    this.stopGeneration += 1;
    this.abort?.abort(new DOMException('Stopped from Agent Monitoring', 'AbortError'));
    this.micActive = false;
    this.clearHeld();
    this.dropTurn();
    this.clearSilenceTimer();
    this.note = null;
    this.releaseSession()?.cancel();
    stopSpeaking();
    // The cancelled request records its own end first; only then is the trail cleared.
    await this.chain.catch(() => undefined);
    this.orchestrator?.resetConversation();
    this.agent.resetConversation();
    this.gate?.drop();
    this.requestWords = [];
    this.recentWords = [];
    this.awaitingAnswer = false;
    const { dispatch } = this.store;
    const voice = this.store.getState().voice;
    if (voice.pendingConfirmation || voice.pendingSlot) this.runtime.cancel();
    dispatch(voiceActions.setPendingConfirmation(null));
    dispatch(voiceActions.setPendingSlot(null));
    dispatch(voiceActions.setTaskGraph(null));
    dispatch(voiceActions.setPlan(null));
    dispatch(voiceActions.setMicActive(false));
    dispatch(voiceActions.setInterimTranscript(''));
    dispatch(voiceActions.setCurrentAction(null));
    dispatch(voiceActions.setStatus('idle'));
    dispatch(voiceActions.setResponse('Stopped — every agent is idle.'));
    dispatch(monitorActions.reset());
  }

  /** With voice diagnostics on, the bridge keeps this next to the utterance's audio. */
  private diagnose(entry: Record<string, unknown>) {
    if (this.recording) postDiagnosticTrace(bridgeHttpUrl(effectiveConfig().stt.wsUrl), entry);
  }

  /** The finished turn's trace, for voice diagnostics. */
  private diagnoseTurn() {
    const trace = this.store.getState().voice.trace;
    if (trace) this.diagnose({ kind: 'turn', ...trace, ms: (trace.finishedAt ?? Date.now()) - trace.startedAt });
  }

  private recordStep(step: AgentStep) {
    this.store.dispatch(voiceActions.upsertTraceStep(step));
  }

  /**
   * Run an utterance through the assistant — the single agent, or the master and its specialists — and
   * present the outcome. `continuation`: no utterance; the multi-agent graph carries on after the provider
   * settled its waiting confirmation on screen.
   */
  private async process(said: string, alsoHeard?: string, continuation?: { confirmed: boolean; message?: string }, lead?: string): Promise<AgentOutcome | null> {
    const { dispatch } = this.store;
    const runner = this.orchestrator ?? this.agent;
    this.busy = true;
    this.abort = new AbortController();
    const provider = this.orchestrator ? `${runner.modelName} · multi-agent` : runner.modelName;
    const trace: DebugTrace = { transcript: said, provider, context: runner.contextBlock(said, undefined, alsoHeard), steps: [], fieldsModified: [], startedAt: Date.now() };

    dispatch(voiceActions.setPanelOpen(true));
    dispatch(voiceActions.setError(null));
    dispatch(voiceActions.setTranscript(said));
    dispatch(voiceActions.setStatus('processing'));
    dispatch(voiceActions.setResponse(null));
    dispatch(voiceActions.setPlan(null));
    dispatch(voiceActions.setTrace(trace));
    // A draft waits for its yes, and the provider asks for something else: their new request is held and they are
    // asked — save or discard what waits — so nothing they say next is ever applied to the wrong record.
    if (!continuation) {
      const handled = await this.holdForDraft(said, alsoHeard);
      if (handled !== undefined) return handled;
    }
    // The same request said again while its unsaved draft waits ("Add Metformin … to Chloe Bell" again): a
    // correction — what waited is closed unsaved, and the provider is told.
    let replaced: string | null = null;
    if (!continuation && this.isNewRequest(said)) {
      const before = this.store.getState().voice;
      replaced = before.pendingConfirmation?.formTitle ?? (this.formOpen() ? 'form' : null) ?? 'request';
      this.runtime.discardStaged();
      this.orchestrator?.dropOpenRequest();
      this.gate?.drop();
      this.awaitingAnswer = false;
    }
    // The provider's words for this request: an answer to what is waiting adds to them; anything else starts anew.
    const voiceNow = this.store.getState().voice;
    const continuing = !replaced && (!!continuation || this.awaitingAnswer || !!this.orchestrator?.holdsRequest || !!this.gate?.holding || !!voiceNow.pendingConfirmation || !!voiceNow.pendingSlot);
    const words = continuation ? [] : [said, alsoHeard].filter((w): w is string => !!w);
    if (!continuing && this.requestWords.length) this.recentWords = [...this.recentWords, ...this.requestWords].slice(-6);
    this.requestWords = continuing ? [...this.requestWords, ...words] : words;
    this.observe(() => this.monitor.beginRequest(continuation ? (continuation.confirmed ? '(confirmed on screen)' : '(cancelled on screen)') : said, this.orchestrator ? 'multi' : 'single'));

    const hooks: MultiAgentHooks = {
      onStep: (step) => {
        this.recordStep(step);
        this.observe(() => this.monitor.step(step));
        if (step.type === 'tool' && !step.finishedAt) dispatch(voiceActions.setStatus('executing'));
      },
      onProgress: (text) => dispatch(voiceActions.setCurrentAction(text)),
      onPlan: (steps) => dispatch(voiceActions.setPlan(steps)),
      onPlanning: (report) => this.observe(() => this.monitor.planning(report)),
      onFreshRequest: () => {
        if (this.requestWords.length > words.length) this.recentWords = [...this.recentWords, ...this.requestWords.slice(0, -words.length || undefined)].slice(-6);
        this.requestWords = [...words];
      },
      onGraph: (graph) => {
        this.observe(() => this.monitor.graph(graph));
        dispatch(voiceActions.setTaskGraph(graph));
        dispatch(voiceActions.setTraceGraph(graph ?? undefined));
      },
    };
    let outcome: AgentOutcome;
    try {
      if (continuation && this.orchestrator) {
        const next = await this.orchestrator.continueAfterScreen(continuation.confirmed, hooks, this.abort.signal);
        if (!next) {
          this.observe(() => this.monitor.endRequest({ reply: continuation.message ?? 'Nothing was waiting behind it.' }));
          this.busy = false;
          dispatch(voiceActions.setTrace(null));
          // What was saved (or closed) is still what the assistant says — nothing else followed it.
          if (continuation.message) dispatch(voiceActions.setResponse(continuation.message));
          dispatch(voiceActions.setStatus(this.micActive ? 'listening' : 'completed'));
          return null;
        }
        outcome = next;
      } else if (this.orchestrator) {
        outcome = await this.orchestrator.run(said, hooks, this.abort.signal, alsoHeard);
      } else {
        outcome = await this.runSingle(said, alsoHeard, hooks, this.abort.signal);
      }
      if (replaced) outcome = { ...outcome, reply: `The earlier unsaved ${replaced.toLowerCase()} was closed without saving. ${outcome.reply}`.trim() };
      if (lead) outcome = { ...outcome, reply: `${lead} ${outcome.reply}`.trim() };
    } catch (e) {
      this.busy = false;
      const cancelled = (e as Error).name === 'AbortError' || this.abort?.signal.aborted;
      const message = cancelled ? 'Cancelled.' : friendlyError(e);
      this.observe(() => this.monitor.endRequest({ error: cancelled ? undefined : message, cancelled }));
      dispatch(voiceActions.setCurrentAction(null));
      dispatch(voiceActions.finalizeTrace({ error: cancelled ? undefined : message }));
      this.diagnoseTurn();
      if (!cancelled) {
        dispatch(voiceActions.setError(message));
        dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: said, response: message, status: 'error', timestamp: Date.now() }));
      }
      if (this.micActive) this.armSilenceTimer();
      return null;
    }
    this.busy = false;
    this.awaitingAnswer = outcome.awaitingUser;
    // The Safety Agent, before anything is shown or said: the reply holds only what was said and done.
    if (!outcome.deferred) outcome = { ...outcome, reply: this.checkedReply(outcome.reply) };
    this.observe(() => this.monitor.endRequest({ reply: outcome.reply, awaiting: outcome.awaitingUser, deferred: outcome.deferred }));

    if (outcome.deferred) {
      // Unfinished sentence: keep it and join it with whatever the user says next.
      this.held = { text: said, timer: setTimeout(() => this.clearHeld(), VoiceController.HOLD_MS) };
      // Status first: returning to 'listening' clears the interim line, which shows the held words.
      dispatch(voiceActions.setStatus(this.micActive ? 'listening' : 'idle'));
      dispatch(voiceActions.setInterimTranscript(`${said} …`));
      dispatch(voiceActions.finalizeTrace({ reply: '(waiting for the rest of the sentence)' }));
      this.diagnoseTurn();
      return outcome;
    }

    const voice = this.store.getState().voice;
    const status = voice.pendingConfirmation ? 'confirmation' : 'ok';
    dispatch(voiceActions.setResponse(outcome.reply));
    dispatch(voiceActions.setCurrentAction(this.note ? 'Taking a clinical note — keep talking, pause when you are done…' : null));
    dispatch(voiceActions.setStatus(status === 'confirmation' ? 'confirmation_required' : this.note ? 'listening' : 'completed'));
    dispatch(voiceActions.finalizeTrace({ reply: outcome.reply, fieldsModified: outcome.fieldsModified }));
    this.diagnoseTurn();
    dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: said, response: outcome.reply, status, timestamp: Date.now() }));
    if (outcome.speak || outcome.awaitingUser) speak(outcome.reply);

    if (status === 'ok' && !this.note) {
      setTimeout(() => {
        if (this.store.getState().voice.status === 'completed') dispatch(voiceActions.setStatus(this.micActive ? 'listening' : 'idle'));
      }, 2500);
    }
    if (this.micActive) this.armSilenceTimer();
    return outcome;
  }

  /**
   * The single assistant: requirements first (the gate) when the request is an operation on records and nothing
   * on screen is waiting for this answer — then the assistant, on the whole request.
   */
  private async runSingle(said: string, alsoHeard: string | undefined, hooks: MultiAgentHooks, signal: AbortSignal): Promise<AgentOutcome> {
    const voice = this.store.getState().voice;
    // An answer to the form or confirmation on screen ("twice daily", "yes", "change the dose to 1000 mg") is the
    // assistant's — the gate is for new requests.
    const answeringScreen = !this.gate?.holding && (!!voice.pendingConfirmation || !!voice.pendingSlot || this.formOpen());
    if (!this.gate || answeringScreen) return this.agent.run(said, hooks, signal, alsoHeard);
    const gated = await this.gate.check(said, alsoHeard, hooks, signal);
    if (gated.kind === 'ask') return gated.outcome;
    if (gated.kind === 'pass') return this.agent.run(said, hooks, signal, alsoHeard);
    return this.agent.run(gated.said, hooks, signal, alsoHeard, gated.requirements);
  }

  /**
   * A new request, not an answer to what waits: it adds, deletes, changes or selects, and names a patient — other
   * than the one whose unsaved records wait, or with nothing of it waiting to add to.
   */
  private isNewRequest(said: string): boolean {
    const state = this.store.getState();
    const voice = state.voice;
    const waiting = !!voice.pendingConfirmation || !!voice.pendingSlot || this.formOpen();
    if (!waiting) return false;
    // A confirmation is waiting and the provider goes somewhere else ("go to patients and sleect tom baker",
    // "open the inbox", "summarize …"): that is no answer to "save this?" — a new request, never handed to the
    // task that waits (it once searched the medications list for it).
    if ((voice.pendingConfirmation || (voice.pendingSlot && voice.pendingSlot.field !== 'patient')) && !ANSWER.test(said) && MOVES_ON.test(said)) return true;
    const { operation } = detectOperation(said);
    if (!['add', 'delete_one', 'delete_all', 'select_patient', 'create_patient', 'update'].includes(operation)) return false;
    const text = said.toLowerCase();
    const named = patientSelectors.selectAll(state).filter((p) => text.includes(p.fullName.toLowerCase()));
    if (!named.length) return false;
    // "Also add hypertension for Tom Baker" while Tom Baker's care plan waits: it joins it.
    const current = state.patients.currentPatientId;
    const joins = operation === 'add' && named.every((p) => p.id === current) && this.formOpen() && !voice.pendingConfirmation?.formTitle?.toLowerCase().includes('delete');
    return !joins || this.repeats(said);
  }

  /** A form or the care plan is open for the provider (unsaved). */
  private formOpen(): boolean {
    return CarePlanRegistry.isOpen() || !!FormRegistry.active()?.isOpen();
  }

  /** The same kind of record added again for the same patient while the first is unsaved: a new version of it. */
  private repeats(said: string): boolean {
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);
    const b = [...words(said)];
    return b.length > 0 && this.requestWords.some((u) => {
      const a = words(u);
      return b.filter((w) => a.has(w)).length / b.length >= 0.6;
    });
  }

  /** A button or the command palette runs an action directly — same code path as the tools. */
  async runAction(action: (runtime: AppRuntime) => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
    const { dispatch } = this.store;
    const result = await action(this.runtime);
    if (result.awaitUser || !result.ok) {
      dispatch(voiceActions.setPanelOpen(true));
      dispatch(voiceActions.setResponse(result.message));
      if (this.store.getState().voice.pendingConfirmation) dispatch(voiceActions.setStatus('confirmation_required'));
    }
    return result;
  }

  /**
   * The provider saved (or closed) the form the assistant prepared with the form's own buttons — "Update",
   * "Save", "Cancel" — instead of saying yes: the confirmation and question it left are settled, the assistant
   * stops waiting, and in multi-agent mode the waiting task finishes (or is cancelled) and what came after runs.
   */
  private onFormSettled({ formId, saved }: { formId: string; saved: boolean }) {
    if (this.runtime.isSettling()) return; // the assistant's own yes / no: it reports that itself
    const { dispatch } = this.store;
    const voice = this.store.getState().voice;
    const waitedOn = (voice.pendingConfirmation?.kind === 'form' && voice.pendingConfirmation.formId === formId) || (!!voice.pendingSlot && (voice.pendingSlot.formId === formId || formId === CARE_PLAN_FORM_ID));
    const taskWaits = !!this.orchestrator?.activeGraph?.tasks.some((t) => t.status === 'WAITING_FOR_USER');
    if (!waitedOn && !(taskWaits && voice.status === 'confirmation_required')) return;
    const title = voice.pendingConfirmation?.formTitle ?? (formId === CARE_PLAN_FORM_ID ? 'Care plan' : 'Form');
    const message = saved ? `${title} saved.` : `${title} closed — nothing was saved.`;
    dispatch(voiceActions.setPendingConfirmation(null));
    dispatch(voiceActions.setPendingSlot(null));
    dispatch(navigationActions.setOpenForm(null));
    this.awaitingAnswer = false;
    dispatch(voiceActions.setResponse(message));
    dispatch(voiceActions.setStatus(this.micActive ? 'listening' : 'completed'));
    dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: saved ? '(saved on screen)' : '(closed on screen)', response: message, status: 'ok', timestamp: Date.now() }));
    const held = this.heldRequest;
    if (held) {
      // What the provider asked for meanwhile runs now — the draft is settled.
      this.heldRequest = null;
      this.orchestrator?.settleWaiting(saved, this.graphHooks());
      const run = this.chain.then(() => this.process(held.said, held.alsoHeard, undefined, message));
      this.chain = run.catch(() => undefined);
      return;
    }
    if (taskWaits) {
      const run = this.chain.then(() => this.process(saved ? '(saved on screen)' : '(closed on screen)', undefined, { confirmed: saved, message }));
      this.chain = run.catch(() => undefined);
    }
  }

  /** The task graph, as the panels show it. */
  private graphHooks(): MultiAgentHooks {
    const { dispatch } = this.store;
    return {
      onGraph: (graph) => {
        this.observe(() => this.monitor.graph(graph));
        dispatch(voiceActions.setTaskGraph(graph));
      },
    };
  }

  /** What waits for the provider's yes (or an answer) on screen: a form, the care plan, a deletion, a filing. */
  private draftWaiting(): boolean {
    const voice = this.store.getState().voice;
    return !!voice.pendingConfirmation || !!voice.pendingSlot;
  }

  /** The draft in the provider's words: "the new task for Tom Baker", "deleting all 9 medications for Luke King". */
  private draftName(): string {
    const voice = this.store.getState().voice;
    const pending = voice.pendingConfirmation;
    const patient = pending?.summary.find((s) => s.label === 'Patient')?.value?.replace(/\s*\(.*\)\s*$/, '') ?? this.buildContext().currentPatientName;
    if (pending && pending.kind !== 'form') return pending.description.replace(/[.?!]\s*$/, '');
    const title = (pending?.formTitle ?? FieldRegistry.getForm(voice.pendingSlot?.formId ?? '')?.title ?? 'form').replace(/^(add|new|edit)\s+/i, '').toLowerCase();
    return `the ${title} ${pending?.formId && FormRegistry.get(pending.formId)?.isOpen() && this.runtime.isEditing() ? 'change' : 'record'} for ${patient ?? 'the patient'}`.replace(/ record for/, ' for');
  }

  /** The one question: what to do with the draft before the held request runs. */
  private draftQuestion(said: string): string {
    const voice = this.store.getState().voice;
    const what = this.draftName();
    const next = `Then I'll go on with “${said.trim().replace(/[.?!]+$/, '')}”.`;
    if (voice.pendingSlot && !voice.pendingConfirmation) {
      return `${what.charAt(0).toUpperCase()}${what.slice(1)} isn't finished — it still needs the ${voice.pendingSlot.label.toLowerCase()}. Should I discard it, or keep it open? ${next}`;
    }
    if (voice.pendingConfirmation?.kind === 'delete') return `${what} is waiting for your yes. Should I delete first, or cancel it? ${next}`;
    if (voice.pendingConfirmation?.kind === 'inbox_file') return `${what} is waiting for your yes. Should I do it first, or cancel it? ${next}`;
    return `${what.charAt(0).toUpperCase()}${what.slice(1)} isn't saved yet. Should I save it first, or discard it? ${next}`;
  }

  /**
   * Hold a new request while a draft waits, or settle the draft the provider was asked about and run what they
   * asked for. Undefined: nothing of this applies — the utterance goes on as usual (an answer to the draft
   * itself, "make it twice daily", keeps the held request held).
   */
  private async holdForDraft(said: string, alsoHeard?: string): Promise<AgentOutcome | null | undefined> {
    const held = this.heldRequest;
    if (held && !this.draftWaiting()) this.heldRequest = null; // settled meanwhile
    if (this.heldRequest) {
      const voice = this.store.getState().voice;
      const incomplete = !!voice.pendingSlot && !voice.pendingConfirmation;
      const save = SAVE_DRAFT.test(said) && !incomplete;
      const discard = DISCARD_DRAFT.test(said) || (incomplete && /^\s*(yes|yeah|ok(ay)?|sure|discard)\b/i.test(said));
      if (save || discard) {
        const what = this.draftName();
        const result = save ? await this.runtime.confirm() : (this.runtime.discardStaged(), { ok: true, message: '' });
        if (!result.ok) return this.finishHere(said, `${result.message} ${this.draftQuestion(this.heldRequest.said)}`, true);
        const next = this.heldRequest;
        this.heldRequest = null;
        this.orchestrator?.settleWaiting(save, this.graphHooks());
        this.gate?.drop();
        this.awaitingAnswer = false;
        const lead = save ? result.message : `${what.charAt(0).toUpperCase()}${what.slice(1)} was discarded — nothing was saved.`;
        this.busy = false;
        return this.process(next.said, next.alsoHeard, undefined, lead);
      }
      if (KEEP_DRAFT.test(said) || (incomplete && /^\s*(no|nope)\b/i.test(said))) {
        this.heldRequest = null;
        const reask = voice.pendingSlot?.question ? ` ${voice.pendingSlot.question}` : ' Say “save it” when you are ready.';
        return this.finishHere(said, `Okay — ${this.draftName()} stays open, and I won't do “${held!.said.trim()}”.${reask}`, true);
      }
      if (this.isNewRequest(said) && !this.repeats(said)) {
        this.heldRequest = { said, alsoHeard }; // the newer request replaces the one held
        return this.finishHere(said, this.draftQuestion(said), true);
      }
      return undefined;
    }
    if (this.draftWaiting() && this.isNewRequest(said) && !this.repeats(said)) {
      this.heldRequest = { said, alsoHeard };
      return this.finishHere(said, this.draftQuestion(said), true);
    }
    return undefined;
  }

  /**
   * The Safety Agent's check of a reply, before the provider sees or hears it — always, in every mode: no "saved"
   * for what still waits, no other patient than the one whose record waits, no dose nobody gave.
   */
  private checkedReply(reply: string): string {
    const s = this.store.getState();
    const voice = s.voice;
    const steps = voice.trace?.steps ?? [];
    const facts = JSON.stringify([
      steps.flatMap((st) => (st.type === 'tool' ? [st.call.arguments, st.result?.message, st.result?.data] : [])),
      voice.pendingConfirmation?.summary,
      s.ui.summary?.facts,
      s.ui.summary?.text,
    ]);
    const saved = steps.some((st) => st.type === 'tool' && st.result?.ok && ['confirm_pending_action', 'save_open_form', 'inbox_add_comment'].includes(st.call.name) && !st.result.awaitUser);
    const pending = voice.pendingConfirmation
      ? {
          kind: voice.pendingConfirmation.kind,
          title: voice.pendingConfirmation.formTitle,
          patient: voice.pendingConfirmation.summary.find((x) => x.label === 'Patient')?.value?.replace(/\s*\(.*\)\s*$/, '') ?? null,
        }
      : null;
    const verdict = checkReply(reply, { said: [...this.requestWords], facts, pending, saved, patients: patientSelectors.selectAll(s).map((p) => p.fullName) });
    this.observe(() => this.monitor.replyChecked(verdict.findings));
    return verdict.reply;
  }

  /** A reply the assistant gives itself — no model asked: shown, spoken, kept in the history and the trace. */
  private finishHere(said: string, text: string, awaiting: boolean): AgentOutcome {
    const { dispatch } = this.store;
    this.busy = false;
    this.observe(() => this.monitor.beginRequest(said, this.orchestrator ? 'multi' : 'single'));
    const reply = this.checkedReply(text);
    this.observe(() => this.monitor.endRequest({ reply, awaiting }));
    dispatch(voiceActions.setResponse(reply));
    dispatch(voiceActions.setCurrentAction(null));
    dispatch(voiceActions.setStatus(this.store.getState().voice.pendingConfirmation ? 'confirmation_required' : this.micActive ? 'listening' : 'completed'));
    dispatch(voiceActions.finalizeTrace({ reply }));
    dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: said, response: reply, status: awaiting ? 'confirmation' : 'ok', timestamp: Date.now() }));
    speak(reply);
    if (this.micActive) this.armSilenceTimer();
    return { reply, speak: true, awaitingUser: awaiting, deferred: false, fieldsModified: [] };
  }

  /** The Confirm / Cancel buttons of a pending confirmation. */
  async resolvePending(confirm: boolean) {
    const result = await this.runAction((runtime) => (confirm ? runtime.confirm() : runtime.cancel()));
    const { dispatch } = this.store;
    dispatch(voiceActions.setResponse(result.message));
    dispatch(voiceActions.setStatus(result.ok ? 'completed' : 'error'));
    dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: confirm ? '(confirmed)' : '(cancelled)', response: result.message, status: result.ok ? 'ok' : 'error', timestamp: Date.now() }));
    // Multi-agent mode: a task was waiting on exactly this — what was planned after it carries on now.
    if (result.ok && this.orchestrator?.activeGraph?.tasks.some((t) => t.status === 'WAITING_FOR_USER')) {
      const run = this.chain.then(() => this.process(confirm ? '(confirmed on screen)' : '(cancelled on screen)', undefined, { confirmed: confirm, message: result.message }));
      this.chain = run.catch(() => undefined);
    }
    return result;
  }

  // ---------------------------------------------------------------- context

  buildContext(): AIContext {
    const state = this.store.getState();
    const page = state.navigation.currentPageId ? PageRegistry.get(state.navigation.currentPageId) : undefined;
    const patient = state.patients.currentPatientId ? patientSelectors.selectById(state, state.patients.currentPatientId) : undefined;
    const form = FormRegistry.active();
    const pending = state.voice.pendingConfirmation;
    const inbox = page?.module === 'inbox' ? InboxVoiceRegistry.get()?.snapshot() : undefined;
    const search = state.navigation.currentPageId === 'patients' ? this.patientSearch() : '';
    const now = dayjs();
    return {
      today: now.format('YYYY-MM-DD (dddd)'),
      nextDays: Array.from({ length: 7 }, (_, i) => now.add(i + 1, 'day').format('ddd YYYY-MM-DD')).join(', '),
      laterDates: [
        ...[1, 2, 3, 4].map((n) => `${n} week${n > 1 ? 's' : ''} ${now.add(n, 'week').format('YYYY-MM-DD')}`),
        ...[1, 2, 3, 6].map((n) => `${n} month${n > 1 ? 's' : ''} ${now.add(n, 'month').format('YYYY-MM-DD')}`),
        `1 year ${now.add(1, 'year').format('YYYY-MM-DD')}`,
      ].join(', '),
      now: now.format('HH:mm'),
      providerName: selectCurrentProvider(state)?.fullName ?? null,
      currentPageId: page?.id ?? null,
      currentPageTitle: page?.title ?? null,
      currentPatientId: state.patients.currentPatientId,
      currentPatientName: patient?.fullName ?? null,
      openForm: form ? { id: form.formId, values: form.getValues(), entries: form.entries?.count() ?? 1 } : null,
      pendingQuestion: state.voice.pendingSlot ? { formId: state.voice.pendingSlot.formId, field: state.voice.pendingSlot.field, question: state.voice.pendingSlot.question } : null,
      pendingConfirmation: pending ? { kind: pending.kind, description: `${pending.description}: ${pending.summary.slice(0, 3).map((s) => `${s.label} ${s.value}`).join(', ')}` } : null,
      inbox: inbox ? { view: inbox.view, items: inbox.items.length, openItem: inbox.openItem?.subject ?? null, query: inbox.query } : null,
      patientSearch: search ? { query: search, results: this.findPatients(search).length } : null,
      list: this.listContext(),
      extracted: this.extractedContext(),
      carePlan: this.carePlanContext(),
    };
  }

  private listContext(): AIContext['list'] {
    const list = ListRegistry.active();
    if (!list) return null;
    const s = list.state();
    return {
      name: list.name,
      shown: s.shown,
      total: s.total,
      page: s.page,
      pageCount: s.pageCount,
      search: s.search,
      filters: s.filters,
      filterable: list.filters.map((f) => `${f.label} (${f.options.join('|')})`).join(', '),
    };
  }

  private carePlanContext(): string | null {
    const plan = CarePlanRegistry.get();
    if (!plan?.isOpen()) return null;
    const counts = new Map<string, number>();
    plan.entries().forEach((e) => counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1));
    return [...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(', ') || 'empty';
  }

  private extractedContext(): string | null {
    const items = AiSummaryRegistry.get()?.items() ?? [];
    if (!items.length) return null;
    const counts = new Map<string, number>();
    items.forEach((i) => counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1));
    return [...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(', ');
  }

  /**
   * Switch the language model once the current request is over — never in the middle of one,
   * which would reload the old model for its reply. Requests arriving meanwhile wait in the queue.
   */
  private scheduleModelSwitch(llm: AIConfig['llm']) {
    const previous = effectiveConfig().llm;
    setAIOverride({ ...getAIOverride(), llm });
    const { dispatch } = this.store;
    const run = this.chain.then(async () => {
      this.busy = true;
      dispatch(voiceActions.setStatus('processing'));
      dispatch(voiceActions.setCurrentAction(`Loading ${llm.model}…`));
      // A small GPU cannot hold two models: free the old one first.
      if (previous.provider === 'ollama' && (previous.model !== llm.model || previous.apiUrl !== llm.apiUrl)) await unloadOllamaModel(previous.apiUrl, previous.model);
      const micWasOn = this.micActive;
      this.reconfigure();
      const problem = await this.warmUp();
      this.busy = false;
      dispatch(uiActions.aiConfigChanged());
      dispatch(voiceActions.setCurrentAction(null));
      const reply = problem ? `${llm.model} could not be loaded: ${problem}` : `${llm.model} is ready.`;
      dispatch(voiceActions.setResponse(reply));
      dispatch(voiceActions.setStatus(problem ? 'error' : 'completed'));
      dispatch(voiceActions.pushHistory({ id: uid('turn'), transcript: '', response: reply, status: problem ? 'error' : 'ok', timestamp: Date.now() }));
      speak(reply);
      if (micWasOn) this.startListening();
    });
    this.chain = run.catch(() => undefined);
  }

  /** On the patient list the search box is mirrored in the URL (?q=), including what was typed by hand. */
  private patientSearch(): string {
    const s = this.store.getState();
    if (s.navigation.currentPageId === 'patients' && typeof window !== 'undefined') return new URLSearchParams(window.location.search).get('q') ?? '';
    return s.patients.lastSearch;
  }

  /** The same match the patient table applies to its search box, in the same order. */
  private findPatients(query: string) {
    const q = query.trim().toLowerCase();
    const all = patientSelectors.selectAll(this.store.getState());
    if (!q) return all;
    return all.filter((p) => [p.fullName, p.mrn, p.phone, p.email, p.primaryProviderName].some((v) => String(v ?? '').toLowerCase().includes(q)));
  }

  private buildDeps(): RuntimeDeps {
    const { dispatch, getState } = this.store;
    const currentPatient = () => {
      const s = getState();
      return s.patients.currentPatientId ? patientSelectors.selectById(s, s.patients.currentPatientId) : undefined;
    };
    return {
      getState: () => {
        const s = getState();
        return {
          currentPageId: s.navigation.currentPageId,
          currentPatientId: s.patients.currentPatientId,
          currentPatientName: currentPatient()?.fullName ?? null,
          openFormId: FormRegistry.active()?.formId ?? s.navigation.openFormId,
          pendingConfirmation: s.voice.pendingConfirmation,
          pendingSlot: s.voice.pendingSlot,
          patientPanelOpen: s.ui.patientPanelOpen,
        };
      },
      navigate: (path: string) => NavigationRegistry.navigate(path),
      back: () => NavigationRegistry.back(),
      setCurrentPatient: (id: string | null) => dispatch(setCurrentPatient(id)),
      setOpenForm: (formId: string | null) => dispatch(navigationActions.setOpenForm(formId)),
      setPendingConfirmation: (p: PendingConfirmation | null) => dispatch(voiceActions.setPendingConfirmation(p)),
      setPendingSlot: (s: PendingSlot | null) => dispatch(voiceActions.setPendingSlot(s)),
      setPatientSearch: (q: string) => dispatch(setLastSearch(q)),
      setPatientPanel: (open: boolean) => dispatch(uiActions.setPatientPanelOpen(open)),
      setDashboardPanel: (open: boolean) => dispatch(uiActions.setDashboardPanelOpen(open)),
      getPatient: () => currentPatient(),
      allPatients: () => patientSelectors.selectAll(getState()),
      findPatients: (q: string) => this.findPatients(q),
      getPatientSearch: () => this.patientSearch(),
      getRecords: (kind: RecordKind) => patientRecords(getState(), kind),
      knownNames: (kind: RecordKind) => {
        // Most used first. "Hyperlipidemia, unspecified" is also known as "Hyperlipidemia".
        const counts = new Map<string, number>();
        const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
        for (const row of recordSlices[kind].selectors.selectAll(getState()) as AnyRecord[]) {
          const label = recordLabel(kind, row)?.trim();
          if (!label) continue;
          add(label);
          // "Essential (primary) hypertension" → "Essential hypertension", "Migraine, unspecified" → "Migraine",
          // "Type 2 diabetes mellitus without complications" → "Type 2 diabetes mellitus".
          const short = label.replace(/\s*\([^)]*\)/g, '').split(',')[0].replace(/\s+without\s.*$/i, '').trim();
          if (short && short !== label) add(short);
        }
        return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([name]) => name);
      },
      deleteEntity: async (kind: EntityKind, id: string) => {
        if (kind === 'patient') await dispatch(deletePatient(id)).unwrap();
        else await dispatch(recordSlices[kind].remove(id)).unwrap();
      },
      describePatient: () => {
        const s = getState();
        const patient = currentPatient();
        if (!patient) return 'No patient is selected.';
        return buildPatientNarrative({
          patient,
          medications: patientRecords(s, 'medication') as never,
          diagnoses: patientRecords(s, 'diagnosis') as never,
          tasks: patientRecords(s, 'task') as never,
          recalls: patientRecords(s, 'recall') as never,
          appointments: patientRecords(s, 'appointment') as never,
        }).text;
      },
      getWorkload: () => {
        const s = getState();
        const provider = selectCurrentProvider(s);
        if (!provider) return null;
        return buildProviderWorkload({
          provider,
          patients: patientSelectors.selectAll(s),
          appointments: recordSlices.appointment.selectors.selectAll(s),
          tasks: recordSlices.task.selectors.selectAll(s),
          recalls: recordSlices.recall.selectors.selectAll(s),
          inbox: s.inbox.items,
          reviewedInboxIds: s.inbox.reviewedIds,
        });
      },
      providerNames: () => providerSelectors.selectAll(getState()).map((p) => p.fullName),
      inboxItems: () => getState().inbox.items,
      providerAppointments: () => {
        const s = getState();
        const provider = selectCurrentProvider(s);
        return provider ? recordSlices.appointment.selectors.selectAll(s).filter((a) => a.providerId === provider.id) : [];
      },
      addInboxComments: (itemIds: string[], text: string) =>
        dispatch(inboxActions.addComments({ itemIds, text, author: selectCurrentProvider(getState())?.fullName ?? 'You' })),
      stopListening: () => this.stopListening(),
      aiSettings: () => {
        const config = effectiveConfig();
        return { llm: config.llm, bridgeUrl: bridgeHttpUrl(config.stt.wsUrl) };
      },
      listModels: (provider, apiUrl) => listModels(provider, apiUrl),
      switchLanguageModel: (llm) => this.scheduleModelSwitch(llm),
      getSpeechConfig: () => getSttConfig(bridgeHttpUrl(effectiveConfig().stt.wsUrl)),
      saveSpeechConfig: async (settings) => {
        const saved = await saveSttConfig(bridgeHttpUrl(effectiveConfig().stt.wsUrl), settings);
        dispatch(uiActions.aiConfigChanged());
        return saved;
      },
      signOut: () => void dispatch(logout()),
      setSpokenReplies: (on: boolean) => {
        setSpeakReplies(on);
        dispatch(uiActions.aiConfigChanged());
      },
      setSidebarCollapsed: (collapsed: boolean) => dispatch(uiActions.setSidebarCollapsed(collapsed)),
      openHelp: () => dispatch(voiceActions.setHelpOpen(true)),
      takeNote: (text?: string) => {
        if (text) this.handoffNote(text);
        else this.beginNote();
      },
      summarize: (request) => this.summarize(request),
    };
  }

  /**
   * The page a summary is of, as it shows those records: the Inbox on the category with the same filters, the
   * patient's chart tab (the patient selected), My Appointments, the Dashboard, Patients, Configuration.
   * Nothing moves while a form or a question is waiting on the provider (what they are doing stays on screen).
   */
  private async openSummaryPage(target: SummaryTarget) {
    const s = this.store.getState();
    if (s.voice.pendingConfirmation || s.voice.pendingSlot || FormRegistry.active()?.isOpen() || CarePlanRegistry.isOpen()) return;
    const until = async (probe: () => boolean, ms = 4000) => {
      for (const start = Date.now(); Date.now() - start < ms && !probe(); ) await new Promise((r) => setTimeout(r, 40));
    };
    const go = async (path: string) => {
      if (`${NavigationRegistry.pathname()}${window.location.search}` === path || NavigationRegistry.pathname() === path) return;
      NavigationRegistry.navigate(path);
      await until(() => NavigationRegistry.pathname() === path.split('?')[0]);
    };
    switch (target.kind) {
      case 'inbox': {
        await go(`/inbox/${target.category}${target.patientId ? `?patient=${encodeURIComponent(target.patientId)}` : ''}`);
        await until(() => !!InboxVoiceRegistry.get());
        InboxVoiceRegistry.get()?.setPatientScope(target.patientId ?? null);
        InboxVoiceRegistry.get()?.showOnly({
          status: target.status === 'normal' ? 'Normal' : target.status === 'abnormal' ? 'Abnormal' : undefined,
          filed: target.file,
          attention: target.attention,
        });
        break;
      }
      case 'patient': {
        const id = target.patientId ?? s.patients.currentPatientId;
        if (!id) return;
        if (id !== s.patients.currentPatientId) this.store.dispatch(setCurrentPatient(id));
        await go(target.records ? PageRegistry.recordTab(target.records).path : PageRegistry.get('summary')!.path);
        break;
      }
      case 'dashboard':
        await go(PageRegistry.get('dashboard')!.path);
        break;
      case 'schedule':
        await go(PageRegistry.get('my-appointments')!.path);
        break;
      case 'patients':
        await go(PageRegistry.get('patients')!.path);
        break;
      case 'configuration':
        await go(PageRegistry.get('configuration')!.path);
        break;
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  /** What a summary is gathered from: the store, as it is now. */
  private summarySource(): SummarySource {
    const s = this.store.getState();
    const provider = selectCurrentProvider(s);
    return {
      patients: patientSelectors.selectAll(s),
      selectedPatientId: s.patients.currentPatientId,
      records: (kind, patientId) => recordSlices[kind].selectors.selectAll(s).filter((r) => r.patientId === patientId),
      workload: () => this.deps.getWorkload(),
      inbox: s.inbox.items,
      filedIds: s.inbox.reviewedIds,
      providerAppointments: () => (provider ? recordSlices.appointment.selectors.selectAll(s).filter((a) => a.providerId === provider.id) : []),
      configuration: () => {
        const names: Partial<Record<string, string>> = this.orchestrator?.agentModelNames ?? { master: this.llm.name };
        return [
          `Mode: ${this.orchestrator ? 'multi-agent' : 'single-agent'}`,
          ...Object.entries(names).map(([agent, name]) => `${agent === 'master' ? 'Master Agent' : (AGENT_TITLES[agent as AgentName] ?? agent)}: ${modelLabel(name ?? '')}`),
          `Safety Agent: ${this.safety ? (this.safety.reviewerModel ? `rules + ${modelLabel(this.safety.reviewerModel)}` : 'rules') : 'off'}`,
          `Speech recognition: ${this.stt.providerName}`,
        ];
      },
    };
  }

  /**
   * A summary of what `text` asks about: the data gathered from the store, the Summary panel opened on it at
   * once, the text written by the Summary Agent's model (in single-agent mode the assistant's) — or from the
   * data alone when no model answers.
   */
  private async summarize({ text, said, llm, signal }: { text: string; said?: string; llm?: ChatLLM | null; signal?: AbortSignal }): Promise<SummaryOutcome> {
    const source = this.summarySource();
    const s = this.store.getState();
    const target = detectTarget([text, said], { pageId: s.navigation.currentPageId, selectedPatientId: s.patients.currentPatientId, patients: source.patients });
    const facts = collectFacts(target, source);
    // The provider sees what is summarized: its page first (the Inbox with those records, the patient's
    // Medications tab, My Appointments …), then the summary beside it.
    await this.openSummaryPage(target);
    const id = uid('summary');
    const request = text.trim().replace(/^./, (c) => c.toUpperCase());
    this.store.dispatch(uiActions.showSummary({ id, request, facts, status: 'writing', at: Date.now() }));
    const model = llm === undefined ? this.llm : llm;
    const written = await writeSummary(model, request, facts, signal);
    // The Safety Agent on the summary's text: only what the data holds (else it is written from the data).
    const rejected = written.note?.startsWith("The model's text was not used");
    const removed = (written.removed ?? []).map((quote) => ({ issue: 'summary-urgency', quote }));
    this.observe(() => this.monitor.replyChecked(rejected ? [{ issue: 'summary', quote: written.note ?? '' }, ...removed] : removed, 'summary'));
    const label = written.source === 'model' && model ? modelLabel(model.name) : undefined;
    this.store.dispatch(uiActions.summaryWritten({ id, text: written.text, source: written.source, model: label, note: written.note }));
    return {
      title: facts.title,
      scope: facts.scope,
      text: written.text,
      source: written.source,
      empty: facts.empty,
      model: model && written.request ? { name: model.name, request: written.request, answer: written.answer, ms: written.ms, note: written.note } : undefined,
    };
  }
}

function friendlyError(e: unknown): string {
  if (e instanceof ModelUnavailableError) return `The assistant's model is not reachable (${e.message}). Start Ollama with qwen3.5:4b (or the bridge) and try again.`;
  return (e as Error)?.message || 'Something went wrong while handling that.';
}

let instance: VoiceController | null = null;
export function initVoiceController(store: AppStore) {
  if (!instance) instance = new VoiceController(store);
  return instance;
}
export function getVoiceController(): VoiceController {
  if (!instance) throw new Error('VoiceController not initialized');
  return instance;
}

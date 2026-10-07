import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AgentStep, DebugTrace, PendingConfirmation, PlanStep, TaskGraphSnapshot } from '@/types/ai';

export type VoiceStatus =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'processing'
  | 'executing'
  | 'confirmation_required'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface VoiceTurn {
  id: string;
  transcript: string;
  response: string;
  status: 'ok' | 'error' | 'cancelled' | 'confirmation';
  timestamp: number;
}

export interface PendingSlot {
  formId: string;
  field: string;
  label: string;
  question: string;
}

interface VoiceState {
  enabled: boolean;
  panelOpen: boolean;
  status: VoiceStatus;
  transcript: string;
  interimTranscript: string;
  currentAction: string | null;
  response: string | null;
  requiresConfirmation: boolean;
  pendingConfirmation: PendingConfirmation | null;
  pendingSlot: PendingSlot | null;
  error: string | null;
  history: VoiceTurn[];
  trace: DebugTrace | null;
  traceHistory: DebugTrace[];
  sttProvider: string;
  llmProvider: string;
  micSupported: boolean;
  /** User-controlled microphone switch. True from the moment the user turns the mic on until they turn it off. */
  micActive: boolean;
  lastCommandAt: number | null;
  /** A dictated clinical paragraph the voice assistant hands to the AI Summary tab for extraction. */
  summaryHandoff: { id: string; text: string } | null;
  /** The voice command reference ("what can I say?"). */
  helpOpen: boolean;
  /**
   * The language model: loading into memory, warming (already in memory — priming its prompt cache,
   * normally a second), ready, or failed to load. The first request waits for either.
   */
  model: { status: 'unknown' | 'loading' | 'warming' | 'ready' | 'error'; since: number | null; error: string | null };
  /** When the request now in progress started — the panel shows how long it has taken. */
  busySince: number | null;
  /** The steps of the latest request, when it was long enough to be carried out in steps (progress only). */
  plan: PlanStep[] | null;
  /**
   * Multi-agent mode: the task graph of the latest request — the one authoritative record of its tasks.
   * It outlives the turn while a task waits on the provider.
   */
  taskGraph: TaskGraphSnapshot | null;
}

const initialState: VoiceState = {
  enabled: true,
  panelOpen: false,
  status: 'idle',
  transcript: '',
  interimTranscript: '',
  currentAction: null,
  response: null,
  requiresConfirmation: false,
  pendingConfirmation: null,
  pendingSlot: null,
  error: null,
  history: [],
  trace: null,
  traceHistory: [],
  sttProvider: '',
  llmProvider: '',
  micSupported: true,
  micActive: false,
  lastCommandAt: null,
  summaryHandoff: null,
  helpOpen: false,
  model: { status: 'unknown', since: null, error: null },
  busySince: null,
  plan: null,
  taskGraph: null,
};

const voiceSlice = createSlice({
  name: 'voice',
  initialState,
  reducers: {
    setPanelOpen(state, action: PayloadAction<boolean>) {
      state.panelOpen = action.payload;
    },
    setStatus(state, action: PayloadAction<VoiceStatus>) {
      const working = action.payload === 'processing' || action.payload === 'executing';
      if (working && !state.busySince) state.busySince = Date.now();
      if (!working) state.busySince = null;
      state.status = action.payload;
      if (action.payload === 'listening') {
        state.error = null;
        state.interimTranscript = '';
      }
    },
    setInterimTranscript(state, action: PayloadAction<string>) {
      state.interimTranscript = action.payload;
    },
    setTranscript(state, action: PayloadAction<string>) {
      state.transcript = action.payload;
      state.interimTranscript = '';
    },
    setCurrentAction(state, action: PayloadAction<string | null>) {
      state.currentAction = action.payload;
    },
    setPlan(state, action: PayloadAction<PlanStep[] | null>) {
      state.plan = action.payload;
    },
    setTaskGraph(state, action: PayloadAction<TaskGraphSnapshot | null>) {
      state.taskGraph = action.payload;
    },
    /** The task graph of the request being traced (the debug panel shows it as a tree). */
    setTraceGraph(state, action: PayloadAction<TaskGraphSnapshot | undefined>) {
      if (state.trace) state.trace.graph = action.payload;
    },
    setResponse(state, action: PayloadAction<string | null>) {
      state.response = action.payload;
    },
    setPendingConfirmation(state, action: PayloadAction<PendingConfirmation | null>) {
      state.pendingConfirmation = action.payload;
      state.requiresConfirmation = action.payload !== null;
      if (action.payload) state.status = 'confirmation_required';
    },
    setPendingSlot(state, action: PayloadAction<PendingSlot | null>) {
      state.pendingSlot = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
      if (action.payload) state.status = 'error';
    },
    pushHistory(state, action: PayloadAction<VoiceTurn>) {
      state.history = [action.payload, ...state.history].slice(0, 30);
      state.lastCommandAt = action.payload.timestamp;
    },
    setTrace(state, action: PayloadAction<DebugTrace | null>) {
      state.trace = action.payload;
    },
    upsertTraceStep(state, action: PayloadAction<AgentStep>) {
      if (!state.trace) return;
      const idx = state.trace.steps.findIndex((s) => s.id === action.payload.id);
      if (idx === -1) state.trace.steps.push(action.payload);
      else state.trace.steps[idx] = action.payload;
    },
    finalizeTrace(state, action: PayloadAction<Partial<DebugTrace> | undefined>) {
      if (!state.trace) return;
      state.trace = { ...state.trace, ...(action.payload ?? {}), finishedAt: Date.now() };
      state.traceHistory = [state.trace, ...state.traceHistory].slice(0, 20);
    },
    setProviders(state, action: PayloadAction<{ stt: string; llm: string }>) {
      state.sttProvider = action.payload.stt;
      state.llmProvider = action.payload.llm;
    },
    setMicSupported(state, action: PayloadAction<boolean>) {
      state.micSupported = action.payload;
    },
    setMicActive(state, action: PayloadAction<boolean>) {
      state.micActive = action.payload;
      if (!action.payload) state.interimTranscript = '';
    },
    setSummaryHandoff(state, action: PayloadAction<{ id: string; text: string } | null>) {
      state.summaryHandoff = action.payload;
    },
    setModelStatus(state, action: PayloadAction<{ status: VoiceState['model']['status']; error?: string | null }>) {
      state.model = { status: action.payload.status, since: Date.now(), error: action.payload.error ?? null };
    },
    setHelpOpen(state, action: PayloadAction<boolean>) {
      state.helpOpen = action.payload;
    },
    setEnabled(state, action: PayloadAction<boolean>) {
      state.enabled = action.payload;
    },
    resetVoice(state) {
      state.status = 'idle';
      state.transcript = '';
      state.interimTranscript = '';
      state.currentAction = null;
      state.plan = null;
      state.taskGraph = null;
      state.response = null;
      state.requiresConfirmation = false;
      state.pendingConfirmation = null;
      state.pendingSlot = null;
      state.error = null;
    },
    clearHistory(state) {
      state.history = [];
      state.traceHistory = [];
      state.trace = null;
    },
  },
});

export const voiceActions = voiceSlice.actions;
export default voiceSlice.reducer;

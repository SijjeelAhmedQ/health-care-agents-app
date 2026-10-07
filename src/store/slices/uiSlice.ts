import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SummaryFacts } from '@/services/ai/summary/summaryFacts';
import { logout } from './authSlice';

/** A summary the Summary Agent wrote (or is writing), as the Summary panel shows it. */
export interface SummaryView {
  id: string;
  /** What the provider asked for. */
  request: string;
  facts: SummaryFacts;
  status: 'writing' | 'ready';
  text?: string;
  /** 'model': written by the Summary Agent's model; 'rules': from the data alone. */
  source?: 'model' | 'rules';
  /** The model it was written with, e.g. "MedGemma 4B". */
  model?: string;
  note?: string;
  at: number;
}

interface UiState {
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  commandPaletteOpen: boolean;
  debugPanelOpen: boolean;
  globalSearchQuery: string;
  notificationsOpen: boolean;
  /** The selected patient's summary, docked to the right of the screen. */
  patientPanelOpen: boolean;
  /** The provider's dashboard summary, docked to the right of the Dashboard page. */
  dashboardPanelOpen: boolean;
  /** The Summary panel (any page): the latest summary the Summary Agent wrote. */
  summaryPanelOpen: boolean;
  summary: SummaryView | null;
  /** Bumped whenever the AI configuration changes (e.g. by the assistant), so open views reload it. */
  aiConfigRevision: number;
  /** Generic overlay registry state: id -> open */
  overlays: Record<string, boolean>;
}

const initialState: UiState = {
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  commandPaletteOpen: false,
  debugPanelOpen: false,
  globalSearchQuery: '',
  notificationsOpen: false,
  patientPanelOpen: false,
  dashboardPanelOpen: false,
  summaryPanelOpen: false,
  summary: null,
  aiConfigRevision: 0,
  overlays: {},
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = action.payload;
    },
    setMobileSidebarOpen(state, action: PayloadAction<boolean>) {
      state.mobileSidebarOpen = action.payload;
    },
    setCommandPaletteOpen(state, action: PayloadAction<boolean>) {
      state.commandPaletteOpen = action.payload;
    },
    setDebugPanelOpen(state, action: PayloadAction<boolean>) {
      state.debugPanelOpen = action.payload;
    },
    setGlobalSearchQuery(state, action: PayloadAction<string>) {
      state.globalSearchQuery = action.payload;
    },
    setNotificationsOpen(state, action: PayloadAction<boolean>) {
      state.notificationsOpen = action.payload;
    },
    setPatientPanelOpen(state, action: PayloadAction<boolean>) {
      state.patientPanelOpen = action.payload;
      if (action.payload) {
        state.dashboardPanelOpen = false;
        state.summaryPanelOpen = false;
      }
    },
    setDashboardPanelOpen(state, action: PayloadAction<boolean>) {
      state.dashboardPanelOpen = action.payload;
      if (action.payload) {
        state.patientPanelOpen = false;
        state.summaryPanelOpen = false;
      }
    },
    /** A new summary: the panel opens on it (its figures at once, the text as soon as it is written). */
    showSummary(state, action: PayloadAction<SummaryView>) {
      state.summary = action.payload;
      state.summaryPanelOpen = true;
      state.patientPanelOpen = false;
      state.dashboardPanelOpen = false;
    },
    /** The text of the summary on show (a newer summary is never overwritten by an older one's text). */
    summaryWritten(state, action: PayloadAction<Pick<SummaryView, 'id' | 'text' | 'source' | 'model' | 'note'>>) {
      if (state.summary?.id !== action.payload.id) return;
      Object.assign(state.summary, action.payload, { status: 'ready' });
    },
    setSummaryPanelOpen(state, action: PayloadAction<boolean>) {
      state.summaryPanelOpen = action.payload && !!state.summary;
      if (state.summaryPanelOpen) {
        state.patientPanelOpen = false;
        state.dashboardPanelOpen = false;
      }
    },
    aiConfigChanged(state) {
      state.aiConfigRevision += 1;
    },
    setOverlay(state, action: PayloadAction<{ id: string; open: boolean }>) {
      state.overlays[action.payload.id] = action.payload.open;
    },
    closeAllOverlays(state) {
      state.overlays = {};
    },
  },
  // A summary holds patients' names: it goes with the session.
  extraReducers: (builder) => {
    const forget = (state: UiState) => {
      state.summary = null;
      state.summaryPanelOpen = false;
    };
    builder.addCase(logout.pending, forget).addCase(logout.fulfilled, forget);
  },
});

export const uiActions = uiSlice.actions;
export default uiSlice.reducer;

import { Suspense, useEffect } from 'react';
import { Layout, Skeleton } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/store';
import { uiActions } from '@/store/slices/uiSlice';
import { voiceActions } from '@/store/slices/voiceSlice';
import { fetchPatients } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import { fetchInbox } from '@/store/slices/inboxSlice';
import { appointmentsSlice, diagnosesSlice, medicationsSlice, recallsSlice, tasksSlice } from '@/store/slices/recordSlices';
import { NavigationRegistry } from '@/registry/navigationRegistry';
import { PageRegistry } from '@/registry/pageRegistry';
import { usePageTracking, useResponsive } from '@/hooks';
import { getVoiceController } from '@/services/ai/voiceController';
import { aiConfig } from '@/services/ai/config';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { SelectedPatientBanner } from '@/components/patient/SelectedPatientBanner';
import { PatientSummaryPanel } from '@/components/patient/PatientSummaryPanel';
import { DashboardSummaryPanel } from '@/components/dashboard/DashboardSummaryPanel';
import { SummaryDock } from '@/components/summary/SummaryDock';
import { VoiceAssistant } from '@/components/voice/VoiceAssistant';
import { VoiceConfirmDialog } from '@/components/voice/VoiceConfirmDialog';
import { AssistantHelp } from '@/components/voice/AssistantHelp';
import { CommandPalette } from '@/components/command-palette/CommandPalette';
import { MultiPatientLauncher } from '@/components/forms/MultiPatientLauncher';
import { DebugPanel } from '@/components/debug/DebugPanel';

function PageFallback() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page…</span>
      <Skeleton active paragraph={{ rows: 1 }} style={{ maxWidth: 400 }} />
      <div className="metric-grid" style={{ marginTop: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="metric-card">
            <Skeleton active paragraph={{ rows: 1 }} />
          </div>
        ))}
      </div>
      <Skeleton active paragraph={{ rows: 8 }} />
    </div>
  );
}

export function AppLayout() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile, isTablet } = useResponsive();
  const collapsed = useAppSelector((s) => s.ui.sidebarCollapsed);
  const hasPatient = useAppSelector((s) => !!s.patients.currentPatientId);
  // The patient summary panel docks to the right; it belongs to the selected
  // patient, so it is only on screen while there is one.
  const patientPanelOpen = useAppSelector((s) => s.ui.patientPanelOpen) && hasPatient;
  // The provider's dashboard summary belongs to the Dashboard page and docks beside it.
  const dashboardPanelOpen = useAppSelector((s) => s.ui.dashboardPanelOpen) && PageRegistry.matchPath(location.pathname)?.id === 'dashboard';
  // The Summary Agent's summary docks on any page — the latest one asked for.
  const summaryPanelOpen = useAppSelector((s) => s.ui.summaryPanelOpen && !!s.ui.summary);
  const rightDock = summaryPanelOpen ? 'summary' : dashboardPanelOpen ? 'dashboard' : patientPanelOpen ? 'patient' : null;
  const helpOpen = useAppSelector((s) => s.voice.helpOpen);
  usePageTracking();

  // Install imperative navigation for the assistant's tools.
  useEffect(() => {
    NavigationRegistry.install((to, options) => (typeof to === 'number' ? navigate(to) : navigate(to, options)));
  }, [navigate]);

  // Bootstrap every dataset once — the banner and dashboard need all of them.
  useEffect(() => {
    dispatch(fetchPatients());
    dispatch(fetchProviders());
    dispatch(medicationsSlice.fetchAll());
    dispatch(diagnosesSlice.fetchAll());
    dispatch(tasksSlice.fetchAll());
    dispatch(recallsSlice.fetchAll());
    dispatch(appointmentsSlice.fetchAll());
    dispatch(fetchInbox());
  }, [dispatch]);

  // Load the assistant's model in the background so the first request is not the slow one.
  useEffect(() => {
    if (aiConfig.enableVoice) void getVoiceController().warmUp();
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch(uiActions.setCommandPaletteOpen(true));
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        getVoiceController().toggleListening();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd' && aiConfig.enableDebugPanel) {
        e.preventDefault();
        dispatch(uiActions.setDebugPanelOpen(true));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !typing) {
        e.preventDefault();
        dispatch(uiActions.toggleSidebar());
      } else if (e.key === 'Escape') {
        dispatch(voiceActions.setPanelOpen(false));
        dispatch(uiActions.setPatientPanelOpen(false));
        dispatch(uiActions.setDashboardPanelOpen(false));
        dispatch(uiActions.setSummaryPanelOpen(false));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  // The mobile menu only exists on small screens — never leave it "open" behind a desktop layout.
  useEffect(() => {
    if (!isMobile) dispatch(uiActions.setMobileSidebarOpen(false));
  }, [isMobile, dispatch]);

  // On a tablet the full sidebar costs a third of the width, so start collapsed there.
  useEffect(() => {
    if (isTablet) dispatch(uiActions.setSidebarCollapsed(true));
  }, [isTablet, dispatch]);

  // The banner belongs to the patient workflow — it is shown on the patient
  // pages whenever a patient is selected, so the active context is never in
  // doubt. The Dashboard is the provider's own view and the Inbox spans every
  // patient and names each item's own patient, so a banner for the selected
  // patient above either would invite a wrong-patient mistake. The selection
  // stays visible in the header and sidebar.
  const page = PageRegistry.matchPath(location.pathname);
  const showBanner = hasPatient && (page?.module === 'patient' || page?.module === 'summary');

  return (
    // The shell is exactly one viewport tall: the header, sidebar and mobile nav
    // stay put, and only #main-content (or a region inside a workspace page) scrolls.
    <Layout className={`app-shell${rightDock ? ' has-right-dock' : ''}`}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      {!isMobile && <Sidebar collapsed={collapsed} onCollapse={(c) => dispatch(uiActions.setSidebarCollapsed(c))} />}
      <Layout className="app-main">
        <Header isMobile={isMobile} />
        <Layout.Content id="main-content" className="app-content" tabIndex={-1}>
          {showBanner && <SelectedPatientBanner />}
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </Layout.Content>
      </Layout>
      {rightDock === 'summary' && <SummaryDock />}
      {rightDock === 'dashboard' && <DashboardSummaryPanel />}
      {rightDock === 'patient' && <PatientSummaryPanel />}
      {isMobile && <MobileNav />}
      {aiConfig.enableVoice && <VoiceAssistant />}
      <VoiceConfirmDialog />
      <AssistantHelp open={helpOpen} onClose={() => dispatch(voiceActions.setHelpOpen(false))} />
      <CommandPalette />
      <MultiPatientLauncher />
      {aiConfig.enableDebugPanel && <DebugPanel />}
    </Layout>
  );
}

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Popconfirm, Tooltip, message } from 'antd';
import { Activity, AlertTriangle, ArrowLeftRight, Bot, Download, Handshake, LayoutGrid, ListChecks, Network, OctagonX, Pause, Play, ScrollText, Workflow, Wrench } from 'lucide-react';
import { store, useAppSelector } from '@/store';
import { monitorActions, type MonitorState } from '@/store/slices/monitorSlice';
import { summarize } from '@/services/ai/monitor/views';
import { followMonitor, requestStopAll, STARTED_AS_MONITOR, type FollowStatus } from '@/services/ai/monitor/channel';
import { getVoiceController } from '@/services/ai/voiceController';
import { MonitorContext, fmtDuration, useNow, type MonitorTab, type MonitorView } from '@/components/monitor/parts';
import { AgentsTab, ErrorsTab, HandshakesTab, LogsTab, OverviewTab, SummaryCards, TasksTab, ToolCallsTab } from '@/components/monitor/MonitorTabs';
import { NetworkView } from '@/components/monitor/NetworkView';
import { TaskTraceDrawer } from '@/components/monitor/TaskTrace';
import '@/styles/monitor.css';

/**
 * Agent Monitoring (/agent-monitor — Configuration → Agent Monitoring opens it in its own window, beside
 * the app): the whole multi-agent system as it runs — which agent
 * is working on what, which agent handed what to whom, every handshake, tool call and model call, what failed
 * and what was retried or reassigned, and how each request ended. It updates live as the agents work.
 *
 *   Overview · Agents · Tasks · Handshakes · Tool Calls · Logs · Errors · Workflow
 *
 * Everything here is read from the monitor's audit trail (services/ai/monitor): this page only shows.
 */
const TABS: ReadonlyArray<{ id: MonitorTab; title: string; icon: ReactNode }> = [
  { id: 'overview', title: 'Overview', icon: <LayoutGrid size={15} /> },
  { id: 'agents', title: 'Agents', icon: <Bot size={15} /> },
  { id: 'tasks', title: 'Tasks', icon: <ListChecks size={15} /> },
  { id: 'handshakes', title: 'Handshakes', icon: <Handshake size={15} /> },
  { id: 'tools', title: 'Tool Calls', icon: <Wrench size={15} /> },
  { id: 'logs', title: 'Logs', icon: <ScrollText size={15} /> },
  { id: 'errors', title: 'Errors', icon: <AlertTriangle size={15} /> },
  { id: 'workflow', title: 'Workflow', icon: <Network size={15} /> },
];

/** In its own window, the trail comes from the app window; in the app's window, it is this window's own. */
function useFollow(): FollowStatus | 'local' {
  const [status, setStatus] = useState<FollowStatus | 'local'>(STARTED_AS_MONITOR ? 'connecting' : 'local');
  useEffect(() => (STARTED_AS_MONITOR ? followMonitor(store, setStatus) : undefined), []);
  return status;
}

/** Back to the app: the window that opened this one, or the app in this window. */
function useBackToApp() {
  const navigate = useNavigate();
  return () => {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) opener.focus();
    else navigate('/configuration?tab=agents');
  };
}

export default function AgentMonitoringPage() {
  const live = useAppSelector((s) => s.monitor);
  const link = useFollow();
  const backToApp = useBackToApp();
  useEffect(() => {
    const before = document.title;
    document.title = 'Agent Monitoring — CareFlow';
    return () => {
      document.title = before;
    };
  }, []);
  // Paused: the screen holds still on what it showed, while the trail keeps recording underneath.
  const [frozen, setFrozen] = useState<MonitorState | null>(null);
  const [stopping, setStopping] = useState(false);
  /** Stop & clear: every agent stopped and idle, nothing waiting on the provider, the monitor empty. */
  const stopAll = async () => {
    setStopping(true);
    setFrozen(null);
    try {
      if (STARTED_AS_MONITOR) {
        // This tab only watches: the tab that runs the agents stops them (and clears this one as it does).
        requestStopAll();
        store.dispatch(monitorActions.reset());
      } else await getVoiceController().stopAll();
      message.success('Stopped — every agent is idle and the monitor is clear.');
    } finally {
      setStopping(false);
    }
  };
  const m = frozen ?? live;
  const running = m.requests[0]?.status === 'running' || m.toolCalls.some((c) => c.status === 'running');
  const now = useNow(running && !frozen);
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as MonitorTab | null;
  const tab: MonitorTab = asked && TABS.some((t) => t.id === asked) ? asked : 'overview';
  const goTo = useCallback((next: MonitorTab) => setParams((p) => ({ ...Object.fromEntries(p), tab: next }), { replace: true }), [setParams]);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const view: MonitorView = useMemo(() => ({ m, now, openTask: setOpenTask, goTo }), [m, now, goTo]);
  const s = summarize(m);
  const latest = m.requests[0];

  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    if (e.key === 'ArrowRight') goTo(TABS[(i + 1) % TABS.length].id);
    if (e.key === 'ArrowLeft') goTo(TABS[(i + TABS.length - 1) % TABS.length].id);
  };

  const exportTrail = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), mode: m.mode, models: m.models, speech: m.speech, requests: m.requests, events: m.events }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-audit-trail-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const count: Partial<Record<MonitorTab, number>> = { tasks: s.runningTasks, handshakes: s.failedHandshakes, tools: s.runningTools, errors: s.errors };

  return (
    <MonitorContext.Provider value={view}>
      <div className="mon-page mon-standalone">
        <header className="mon-header">
          <div className="mon-header-title">
            <span className="mon-header-icon" aria-hidden>
              <Workflow size={20} />
            </span>
            <div>
              <h1>Agent Monitoring</h1>
              <p>Every agent, task, handshake, tool call and error of the assistant — live.</p>
            </div>
          </div>
          <div className="mon-actions">
            {link !== 'local' && (
              <Tooltip title={link === 'live' ? 'Following the agents of the CareFlow window' : 'Open CareFlow in another window and sign in: its agents show here'}>
                <span className="mon-link" data-state={link} role="status">
                  <ArrowLeftRight size={13} /> {link === 'live' ? 'Connected to CareFlow' : link === 'connecting' ? 'Connecting…' : 'No CareFlow window'}
                </span>
              </Tooltip>
            )}
            <span className="mon-live" data-state={frozen ? 'paused' : running ? 'busy' : 'live'} role="status" aria-live="polite">
              <span className="mon-live-dot" aria-hidden />
              {frozen ? 'Paused' : running && latest ? `Working · ${fmtDuration(now - latest.startedAt)}` : 'Live'}
            </span>
            <Tooltip title={frozen ? 'Show what happened since, and follow live again' : 'Hold the screen still to read it — recording carries on'}>
              <Button icon={frozen ? <Play size={15} /> : <Pause size={15} />} onClick={() => setFrozen(frozen ? null : live)}>
                {frozen ? 'Resume' : 'Pause'}
              </Button>
            </Tooltip>
            <Tooltip title="Download the complete audit trail (JSON)">
              <Button icon={<Download size={15} />} onClick={exportTrail} disabled={!m.events.length}>
                Export
              </Button>
            </Tooltip>
            <Popconfirm
              title="Stop every agent and clear?"
              description={
                <span className="mon-stop-text">
                  The request in progress is cancelled, a question or confirmation waiting for you is dropped (nothing is saved), every agent goes idle, and this monitor is cleared.
                </span>
              }
              okText="Stop & clear"
              okButtonProps={{ danger: true }}
              cancelText="Keep running"
              onConfirm={stopAll}
            >
              <Button danger icon={<OctagonX size={15} />} loading={stopping} className="mon-stop">
                Stop & clear
              </Button>
            </Popconfirm>
            <Button onClick={backToApp}>Back to CareFlow</Button>
          </div>
        </header>

        {link === 'no-app' && !m.events.length && (
          <div className="mon-now is-quiet" role="status">
            No CareFlow window is sending activity yet. Keep CareFlow open in another window (signed in) and talk to the assistant — this page follows it live.
          </div>
        )}

        {latest?.status === 'running' && (
          <div className="mon-now" role="status">
            <Activity size={15} /> <strong>Now:</strong> <span className="mon-ellipsis">“{latest.said}”</span>
          </div>
        )}

        <SummaryCards />

        <div className="mon-tabs" role="tablist" aria-label="Agent monitoring" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`mon-tab-${t.id}`}
              aria-controls={`mon-panel-${t.id}`}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={`mon-tab${tab === t.id ? ' is-on' : ''}`}
              data-tab={t.id}
              onClick={() => goTo(t.id)}
            >
              {t.icon}
              <span>{t.title}</span>
              {!!count[t.id] && <span className={`mon-tab-count${t.id === 'errors' || t.id === 'handshakes' ? ' is-bad' : ''}`}>{count[t.id]}</span>}
            </button>
          ))}
        </div>

        <div className="mon-panel" role="tabpanel" id={`mon-panel-${tab}`} aria-labelledby={`mon-tab-${tab}`}>
          {tab === 'overview' && <OverviewTab />}
          {tab === 'agents' && <AgentsTab />}
          {tab === 'tasks' && <TasksTab />}
          {tab === 'handshakes' && <HandshakesTab />}
          {tab === 'tools' && <ToolCallsTab />}
          {tab === 'logs' && <LogsTab />}
          {tab === 'errors' && <ErrorsTab />}
          {tab === 'workflow' && <NetworkView />}
        </div>

        <TaskTraceDrawer taskKey={openTask} onClose={() => setOpenTask(null)} />
      </div>
    </MonitorContext.Provider>
  );
}

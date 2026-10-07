/**
 * The small pieces every tab of Agent Monitoring shares: times and durations as people read them, an
 * agent with its icon, the status pills, and the context that opens a task's execution trace.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Tooltip } from 'antd';
import { CircleCheck, CircleDashed, CircleX, Clock3, Loader2, ShieldCheck, UserRound } from 'lucide-react';
import dayjs from 'dayjs';
import type { MonitorState } from '@/store/slices/monitorSlice';
import type { AgentRunStatus, MonitorHandshake, MonitorLevel, MonitorParty, MonitorToolCall } from '@/types/monitor';
import type { TaskStatus } from '@/types/ai';
import { AGENT_ICON } from '@/components/config/AgentsSection';
import { partyTitle } from '@/services/ai/monitor/views';

// ------------------------------------------------------------------------------------------ context

export interface MonitorView {
  m: MonitorState;
  now: number;
  /** Open a task's execution trace. */
  openTask: (key: string) => void;
  /** Switch tab (the summary cards and links use it). */
  goTo: (tab: MonitorTab) => void;
}

export type MonitorTab = 'overview' | 'agents' | 'tasks' | 'handshakes' | 'tools' | 'logs' | 'errors' | 'workflow';

export const MonitorContext = createContext<MonitorView | null>(null);

export function useMonitorView(): MonitorView {
  const view = useContext(MonitorContext);
  if (!view) throw new Error('useMonitorView outside Agent Monitoring');
  return view;
}

/** The clock, ticking while something is running (live durations); still otherwise. */
export function useNow(ticking: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [ticking, every]);
  return now;
}

// ------------------------------------------------------------------------------------------ formats

export const fmtTime = (at?: number) => (at ? dayjs(at).format('HH:mm:ss') : '—');
export const fmtDateTime = (at?: number) => (at ? dayjs(at).format('YYYY-MM-DD HH:mm:ss') : '—');

export function fmtDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m < 60 ? `${m}m ${String(s).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A JSON value, pretty, for the detail panes. */
export function pretty(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A tool call's arguments in one short line: `patient: James Ahmed · medications: [1]`. */
export function argsLine(args: Record<string, unknown>, max = 120): string {
  const text = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : Array.isArray(v) ? `[${v.length}]` : typeof v === 'object' && v ? '{…}' : String(v)}`)
    .join(' · ');
  return text.length > max ? `${text.slice(0, max)}…` : text || '—';
}

// ------------------------------------------------------------------------------------------ pieces

export function PartyIcon({ party, size = 15 }: { party: MonitorParty; size?: number }) {
  return <>{party === 'provider' ? <UserRound size={size} /> : party === 'safety' ? <ShieldCheck size={size} /> : AGENT_ICON[party](size)}</>;
}

/** An agent (or the provider), with its icon. */
export function AgentLabel({ party, compact }: { party: MonitorParty; compact?: boolean }) {
  return (
    <span className="mon-agent" data-party={party}>
      <span className="mon-agent-icon" aria-hidden>
        <PartyIcon party={party} size={compact ? 13 : 14} />
      </span>
      <span className="mon-agent-name">{compact ? partyTitle(party).replace(/ Agent$/, '') : partyTitle(party)}</span>
    </span>
  );
}

const AGENT_STATUS: Record<AgentRunStatus, { label: string; icon: ReactNode }> = {
  running: { label: 'Running', icon: <span className="mon-dot is-live" /> },
  waiting: { label: 'Waiting', icon: <Clock3 size={12} /> },
  completed: { label: 'Completed', icon: <CircleCheck size={12} /> },
  failed: { label: 'Failed', icon: <CircleX size={12} /> },
  idle: { label: 'Idle', icon: <span className="mon-dot" /> },
};

export function AgentStatusPill({ status }: { status: AgentRunStatus }) {
  const s = AGENT_STATUS[status];
  return (
    <span className="mon-pill" data-status={status}>
      {s.icon} {s.label}
    </span>
  );
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: 'Pending',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_USER: 'Waiting for provider',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const TASK_TONE: Record<TaskStatus, string> = {
  PENDING: 'idle',
  ASSIGNED: 'idle',
  IN_PROGRESS: 'running',
  WAITING_FOR_USER: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className="mon-pill" data-status={TASK_TONE[status]}>
      {status === 'IN_PROGRESS' ? <Loader2 size={12} className="spin" /> : status === 'COMPLETED' ? <CircleCheck size={12} /> : status === 'FAILED' ? <CircleX size={12} /> : status === 'WAITING_FOR_USER' ? <Clock3 size={12} /> : <CircleDashed size={12} />}
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}

export function HandshakePill({ status }: { status: MonitorHandshake['status'] }) {
  const map = { pending: ['running', 'Pending'], accepted: ['completed', 'Success'], rejected: ['failed', 'Failed'], cancelled: ['cancelled', 'Cancelled'] } as const;
  const [tone, label] = map[status];
  return (
    <span className="mon-pill" data-status={tone}>
      {status === 'pending' ? <Loader2 size={12} className="spin" /> : status === 'accepted' ? <CircleCheck size={12} /> : status === 'rejected' ? <CircleX size={12} /> : <CircleDashed size={12} />}
      {label}
    </span>
  );
}

export function ToolStatusPill({ call, now }: { call: MonitorToolCall; now: number }) {
  if (call.status === 'running') {
    const ms = now - call.startedAt;
    const stuck = ms >= 30_000;
    const slow = ms >= 10_000;
    return (
      <span className="mon-pill" data-status={stuck ? 'failed' : slow ? 'waiting' : 'running'}>
        <Loader2 size={12} className="spin" /> {stuck ? 'Stuck?' : slow ? 'Slow' : 'Running'}
      </span>
    );
  }
  const map = { ok: ['completed', 'Success'], waiting: ['waiting', 'Needs provider'], failed: ['failed', 'Failed'] } as const;
  const [tone, label] = map[call.status];
  return (
    <span className="mon-pill" data-status={tone}>
      {call.status === 'ok' ? <CircleCheck size={12} /> : call.status === 'failed' ? <CircleX size={12} /> : <Clock3 size={12} />}
      {label}
    </span>
  );
}

const LEVEL_TONE: Record<MonitorLevel, string> = { ok: 'completed', info: 'idle', running: 'running', warning: 'waiting', error: 'failed' };
const LEVEL_LABEL: Record<MonitorLevel, string> = { ok: 'Success', info: 'Info', running: 'Started', warning: 'Warning', error: 'Error' };

export function LevelPill({ level }: { level: MonitorLevel }) {
  return (
    <span className="mon-pill is-sm" data-status={LEVEL_TONE[level]}>
      {LEVEL_LABEL[level]}
    </span>
  );
}

export const LEVEL_OPTIONS = (Object.keys(LEVEL_LABEL) as MonitorLevel[]).map((l) => ({ value: l, label: LEVEL_LABEL[l] }));

/** A task's label that opens its execution trace. */
export function TaskLink({ taskKey, label }: { taskKey?: string; label?: string }) {
  const { openTask, m } = useMonitorView();
  if (!taskKey || !label) return <span className="muted">—</span>;
  const task = m.tasks[taskKey];
  return (
    <Tooltip title={task ? task.instruction : 'This task is no longer kept'}>
      <button
        type="button"
        className="mon-task-link"
        disabled={!task}
        onClick={(e) => {
          e.stopPropagation();
          openTask(taskKey);
        }}
      >
        {label}
      </button>
    </Tooltip>
  );
}

/** An empty section, in words. */
export function Nothing({ children }: { children: ReactNode }) {
  return <div className="mon-nothing">{children}</div>;
}

/** A card of the monitoring screen. */
export function MonCard({ title, icon, extra, children, className, id }: { title: ReactNode; icon?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`mon-card${className ? ` ${className}` : ''}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      <header className="mon-card-head">
        <h2 className="mon-card-title">
          {icon}
          {title}
        </h2>
        {extra && <div className="mon-card-extra">{extra}</div>}
      </header>
      {children}
    </section>
  );
}

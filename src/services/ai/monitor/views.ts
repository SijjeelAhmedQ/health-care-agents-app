/**
 * What the monitoring screen reads off the monitor state: the counters, why a task is not done, whether an
 * error was retried or the task reassigned, the edges of the agent network, a task's execution trace.
 * Pure functions of the state (and the clock), so they are tested without rendering anything.
 */
import type { MonitorState } from '@/store/slices/monitorSlice';
import type { MonitorAgentKey, MonitorEvent, MonitorEventType, MonitorHandshake, MonitorParty, MonitorTask, MonitorToolCall } from '@/types/monitor';
import { PARTY_TITLES } from './recorder';

/** A tool call running this long is slow; this long, probably stuck (tools have no timeout of their own). */
export const TOOL_SLOW_MS = 10_000;
export const TOOL_STUCK_MS = 30_000;

export const EVENT_LABELS: Record<MonitorEventType, string> = {
  'agents.configured': 'Agents configured',
  'agent.started': 'Agent started',
  'agent.stopped': 'Agent stopped',
  'request.started': 'Request received',
  'request.finished': 'Request finished',
  'request.failed': 'Request failed',
  'task.created': 'Task created',
  'task.assigned': 'Task assigned',
  'task.accepted': 'Task accepted',
  'task.waiting': 'Waiting for provider',
  'task.resumed': 'Task resumed',
  'task.completed': 'Task completed',
  'task.failed': 'Task failed',
  'task.retry': 'Retry',
  'task.requeued': 'Task requeued',
  'task.reassigned': 'Task reassigned',
  'task.cancelled': 'Task cancelled',
  'handshake.initiated': 'Handshake initiated',
  'handshake.accepted': 'Handshake accepted',
  'handshake.rejected': 'Handshake rejected',
  'handshake.cancelled': 'Handshake cancelled',
  'tool.called': 'Tool call',
  'tool.completed': 'Tool completed',
  'tool.failed': 'Tool failed',
  'model.request': 'Model request',
  'model.response': 'Model response',
  'planning.started': 'Planning',
  'planning.question': 'Requirement asked',
  'planning.ready': 'Requirements complete',
  'planning.dropped': 'Requirements dropped',
  'safety.corrected': 'Safety: corrected',
  'safety.blocked': 'Safety: asked instead',
  'safety.reviewed': 'Safety: reviewed',
  error: 'Error',
};

/** The groups the log filter offers. */
export const EVENT_GROUPS: Record<string, MonitorEventType[]> = {
  Requests: ['request.started', 'request.finished', 'request.failed'],
  Agents: ['agents.configured', 'agent.started', 'agent.stopped'],
  Tasks: ['task.created', 'task.assigned', 'task.accepted', 'task.waiting', 'task.resumed', 'task.completed', 'task.failed', 'task.retry', 'task.requeued', 'task.reassigned', 'task.cancelled'],
  Handshakes: ['handshake.initiated', 'handshake.accepted', 'handshake.rejected', 'handshake.cancelled'],
  'Tool calls': ['tool.called', 'tool.completed', 'tool.failed'],
  Models: ['model.request', 'model.response'],
  'Planning & safety': ['planning.started', 'planning.question', 'planning.ready', 'planning.dropped', 'safety.corrected', 'safety.blocked', 'safety.reviewed'],
  Errors: ['error'],
};

export const partyTitle = (p: MonitorParty) => PARTY_TITLES[p] ?? p;

const ACTIVE_TASK = new Set(['ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER']);

export function tasksOf(state: MonitorState): MonitorTask[] {
  return state.taskOrder.map((k) => state.tasks[k]).filter(Boolean);
}

export interface MonitorSummary {
  activeAgents: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  handshakes: number;
  failedHandshakes: number;
  toolCalls: number;
  runningTools: number;
  errors: number;
}

export function summarize(state: MonitorState): MonitorSummary {
  const tasks = tasksOf(state);
  return {
    activeAgents: Object.values(state.agents).filter((a) => a.status === 'running' || a.status === 'waiting').length,
    runningTasks: tasks.filter((t) => ACTIVE_TASK.has(t.status)).length,
    completedTasks: tasks.filter((t) => t.status === 'COMPLETED').length,
    failedTasks: tasks.filter((t) => t.status === 'FAILED').length,
    handshakes: state.handshakes.length,
    failedHandshakes: state.handshakes.filter((h) => h.status === 'rejected').length,
    toolCalls: state.toolCalls.length,
    runningTools: state.toolCalls.filter((c) => c.status === 'running').length,
    errors: state.events.filter((e) => e.type === 'error').length,
  };
}

// ------------------------------------------------------------------------------------- task issues

export type IssueCategory = 'Failed' | 'Cancelled' | 'Timed out' | 'Blocked' | 'Waiting for another agent' | 'Waiting for tool response' | 'Waiting for provider' | 'Incomplete';

export interface TaskIssue {
  category: IssueCategory;
  reason: string;
  action: string;
}

const TIMEOUT = /time(d)?\s*out|timeout|took too long/i;

/** Why a task is not (yet) done — or null when it completed, or is simply running. */
export function taskIssue(task: MonitorTask, state: MonitorState, now = Date.now()): TaskIssue | null {
  const calls = state.toolCalls.filter((c) => c.taskKey === task.key);
  const running = calls.find((c) => c.status === 'running');
  const request = task.requestId ? state.requests.find((r) => r.id === task.requestId) : undefined;
  const deps = task.dependsOn.map((k) => state.tasks[k]).filter(Boolean);
  const action = actionFor(task);
  switch (task.status) {
    case 'COMPLETED':
      return null;
    case 'FAILED': {
      const timedOut = TIMEOUT.test(task.error ?? '') || calls.some((c) => TIMEOUT.test(c.error ?? ''));
      return { category: timedOut ? 'Timed out' : 'Failed', reason: task.error ?? 'It failed.', action: action || 'Reported to the provider' };
    }
    case 'CANCELLED': {
      const blocker = deps.find((d) => d.status === 'FAILED' || d.status === 'CANCELLED');
      if (blocker) return { category: 'Blocked', reason: task.error ?? `Task ${blocker.label} did not complete.`, action: `Needs task ${blocker.label} (${blocker.status === 'FAILED' ? 'failed' : 'cancelled'})` };
      return { category: 'Cancelled', reason: task.error ?? 'Cancelled.', action: action || '—' };
    }
    case 'WAITING_FOR_USER':
      return { category: 'Waiting for provider', reason: task.waitingFor ?? 'A question or a confirmation is open.', action: 'Answer or confirm in the assistant panel' };
    case 'IN_PROGRESS':
      if (running) {
        const ms = now - running.startedAt;
        if (ms >= TOOL_STUCK_MS) return { category: 'Timed out', reason: `${running.tool}() has not answered for ${Math.round(ms / 1000)} s.`, action: 'Cancel the request in the assistant panel, then try again' };
        return { category: 'Waiting for tool response', reason: `${running.tool}() is running.`, action: '—' };
      }
      return null;
    case 'ASSIGNED':
    case 'PENDING': {
      const blocker = deps.find((d) => d.status === 'FAILED' || d.status === 'CANCELLED');
      if (blocker) return { category: 'Blocked', reason: `Task ${blocker.label} ${blocker.status === 'FAILED' ? 'failed' : 'was cancelled'}.`, action: `Needs task ${blocker.label}` };
      const open = deps.filter((d) => d.status !== 'COMPLETED');
      if (open.length) return { category: 'Waiting for another agent', reason: `Waits for ${open.map((d) => `task ${d.label} (${partyTitle(d.agent)})`).join(', ')}.`, action: action || 'Runs as soon as those complete' };
      if (request && request.finishedAt) return { category: 'Incomplete', reason: 'The request ended before this task ran.', action: action || '—' };
      return null;
    }
  }
}

function actionFor(task: MonitorTask): string {
  const parts: string[] = [];
  if (task.reassignments.length) parts.push(`Reassigned → ${task.reassignments.map((r) => partyTitle(r.to)).join(' → ')}`);
  if (task.retryCount) parts.push(`Retried ${task.retryCount}×`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------------------------------ errors

export interface ErrorRow {
  event: MonitorEvent;
  retry: string;
  reassignment: string;
}

/** Every error, newest first, with what happened after it: retried? recovered? reassigned? */
export function errorRows(state: MonitorState): ErrorRow[] {
  const rows: ErrorRow[] = [];
  for (const e of state.events) {
    if (e.type !== 'error') continue;
    const task = e.taskKey ? state.tasks[e.taskKey] : undefined;
    rows.push({ event: e, retry: retryStatus(e, state, task), reassignment: task?.reassignments.length ? `Reassigned → ${task.reassignments.map((r) => partyTitle(r.to)).join(' → ')}` : '—' });
  }
  return rows.reverse();
}

function retryStatus(e: MonitorEvent, state: MonitorState, task?: MonitorTask): string {
  if (e.errorKind === 'tool') {
    const later = state.toolCalls.filter((c) => c.tool === e.tool && c.agent === e.agent && c.taskKey === e.taskKey && c.requestId === e.requestId && c.attempt > (e.attempt ?? 1));
    if (!later.length) return 'Not retried';
    const ok = later.find((c) => c.status === 'ok' || c.status === 'waiting');
    if (ok) return `Recovered on retry #${ok.attempt - 1}`;
    if (later.some((c) => c.status === 'running')) return `Retry #${later[later.length - 1].attempt - 1} running`;
    return `Retried ${later.length}× — failed`;
  }
  if (e.errorKind === 'task' && task) {
    const attempt = e.attempt ?? 1;
    if (task.retryCount >= attempt) {
      if (task.status === 'COMPLETED') return `Recovered on retry #${attempt}`;
      if (task.status === 'FAILED') return `Retry #${attempt} failed`;
      return `Retry #${attempt} ${task.status === 'CANCELLED' ? 'cancelled' : 'in progress'}`;
    }
    return task.status === 'FAILED' ? 'No retries left' : 'Not retried';
  }
  if (e.errorKind === 'model') return 'Not retried (the request stops)';
  return '—';
}

// ---------------------------------------------------------------------------------------- network

export interface NetworkEdge {
  from: MonitorParty;
  to: MonitorParty;
  kinds: Set<MonitorHandshake['kind']>;
  total: number;
  accepted: number;
  rejected: number;
  cancelled: number;
  pending: number;
  /** Work is passing over it now. */
  active: boolean;
  last: number;
}

/** Who talked to whom, with how it went — for one request, or every request. */
export function networkEdges(state: MonitorState, requestId?: string): NetworkEdge[] {
  const edges = new Map<string, NetworkEdge>();
  const live = state.requests.find((r) => r.status === 'running')?.id;
  for (const h of state.handshakes) {
    if (requestId && h.requestId !== requestId) continue;
    const key = `${h.from}>${h.to}`;
    const edge = edges.get(key) ?? { from: h.from, to: h.to, kinds: new Set(), total: 0, accepted: 0, rejected: 0, cancelled: 0, pending: 0, active: false, last: 0 };
    edge.kinds.add(h.kind);
    edge.total += 1;
    edge[h.status] += 1;
    edge.last = Math.max(edge.last, h.completedAt ?? h.initiatedAt);
    const task = h.taskKey ? state.tasks[h.taskKey] : undefined;
    if (h.requestId === live && (h.status === 'pending' || (h.kind !== 'handoff' && task && (task.status === 'IN_PROGRESS' || task.status === 'ASSIGNED') && task.agent === h.to) || (h.kind === 'request' && h.status === 'accepted'))) edge.active = true;
    edges.set(key, edge);
  }
  return [...edges.values()];
}

// ------------------------------------------------------------------------------------------ traces

/** Every event of one task, in the order it happened. */
export function taskTrace(state: MonitorState, taskKey: string): MonitorEvent[] {
  return state.events.filter((e) => e.taskKey === taskKey && e.type !== 'error');
}

/** The communication timeline: who passed what to whom, in order (one request, or the latest ones). */
const TIMELINE: ReadonlySet<MonitorEventType> = new Set([
  'request.started',
  'task.created',
  'task.assigned',
  'task.accepted',
  'task.resumed',
  'task.waiting',
  'task.completed',
  'task.failed',
  'task.retry',
  'task.reassigned',
  'task.cancelled',
  'handshake.accepted',
  'handshake.rejected',
  'handshake.cancelled',
  'tool.called',
  'tool.completed',
  'tool.failed',
  'request.finished',
  'request.failed',
]);

export function timeline(state: MonitorState, requestId?: string, limit = 200): MonitorEvent[] {
  const events = state.events.filter((e) => TIMELINE.has(e.type) && (!requestId || e.requestId === requestId));
  return events.slice(-limit);
}

/** Running tool calls, longest-running first. */
export function runningTools(state: MonitorState): MonitorToolCall[] {
  return state.toolCalls.filter((c) => c.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
}

/** How long something has been going, or took. */
export function elapsed(start?: number, end?: number, now = Date.now()): number | undefined {
  if (!start) return undefined;
  return (end ?? now) - start;
}

/** A task's dependency depth (0: needs nothing) — the column it sits in on the workflow view. */
export function taskDepth(task: MonitorTask, state: MonitorState, seen = new Set<string>()): number {
  if (seen.has(task.key)) return 0;
  seen.add(task.key);
  const deps = task.dependsOn.map((k) => state.tasks[k]).filter(Boolean);
  return deps.length ? 1 + Math.max(...deps.map((d) => taskDepth(d, state, seen))) : 0;
}

export const isAgent = (p: MonitorParty): p is MonitorAgentKey => p !== 'provider';

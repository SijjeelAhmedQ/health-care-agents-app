/**
 * Agent monitoring state: the audit trail (events), and what the monitoring screen shows, projected from it.
 *
 * Events come from the recorder (services/ai/monitor/recorder.ts) and are only ever appended: each one is
 * applied to the projections — agents, tasks, handshakes, tool and model calls, requests — as it arrives,
 * so the screen updates the moment something happens. The oldest entries are dropped past a cap, and
 * signing out clears everything (the trail holds patients' names).
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { AGENT_NAMES } from '@/services/ai/agents/taskGraph';
import type { AgentModelInfo, MonitorAgentKey, MonitorAgentState, MonitorEvent, MonitorHandshake, MonitorModelCall, MonitorRequest, MonitorTask, MonitorToolCall } from '@/types/monitor';

export const MONITOR_AGENTS: readonly MonitorAgentKey[] = ['master', 'planning', 'safety', ...AGENT_NAMES];

export const MONITOR_LIMITS = { events: 5000, tasks: 500, handshakes: 1500, toolCalls: 1500, modelCalls: 1500, requests: 200 } as const;

export interface MonitorState {
  events: MonitorEvent[];
  agents: Record<MonitorAgentKey, MonitorAgentState>;
  tasks: Record<string, MonitorTask>;
  /** Task keys, oldest first. */
  taskOrder: string[];
  handshakes: MonitorHandshake[];
  toolCalls: MonitorToolCall[];
  modelCalls: MonitorModelCall[];
  /** Newest first. */
  requests: MonitorRequest[];
  mode: 'single' | 'multi';
  models: Partial<Record<MonitorAgentKey, AgentModelInfo>>;
  speech: AgentModelInfo | null;
  configuredAt: number | null;
  /** Entries dropped past the caps — the trail says it is not complete. */
  dropped: number;
}

const agentState = (key: MonitorAgentKey): MonitorAgentState => ({ key, status: 'idle', counts: { tasks: 0, completed: 0, failed: 0, toolCalls: 0, modelCalls: 0 } });

const initialState = (): MonitorState => ({
  events: [],
  agents: Object.fromEntries(MONITOR_AGENTS.map((k) => [k, agentState(k)])) as Record<MonitorAgentKey, MonitorAgentState>,
  tasks: {},
  taskOrder: [],
  handshakes: [],
  toolCalls: [],
  modelCalls: [],
  requests: [],
  mode: 'single',
  models: {},
  speech: null,
  configuredAt: null,
  dropped: 0,
});

/** Keep at most `max` entries, dropping from the front (the oldest). */
function cap<T>(list: T[], max: number): number {
  const over = list.length - max;
  if (over > 0) list.splice(0, over);
  return Math.max(0, over);
}

function setAgent(state: MonitorState, key: MonitorAgentKey | undefined, status: MonitorAgentState['status'], at: number, patch: Partial<MonitorAgentState> = {}) {
  if (!key) return;
  const agent = (state.agents[key] ??= agentState(key));
  if (agent.status !== status) agent.since = at;
  agent.status = status;
  Object.assign(agent, patch);
}

/** Apply one event to the projections. */
function apply(state: MonitorState, e: MonitorEvent) {
  const task = e.taskKey ? state.tasks[e.taskKey] : undefined;
  const agent = e.agent ? (state.agents[e.agent] ??= agentState(e.agent)) : undefined;
  const request = e.requestId ? state.requests.find((r) => r.id === e.requestId) : undefined;
  switch (e.type) {
    case 'agents.configured':
      state.mode = e.mode ?? state.mode;
      state.models = e.models ?? {};
      state.speech = e.speech ?? null;
      state.configuredAt = e.at;
      return;
    case 'request.started':
      state.requests.unshift({ id: e.requestId!, said: e.request ?? '', mode: e.mode ?? state.mode, startedAt: e.at, status: 'running' });
      if (state.requests.length > MONITOR_LIMITS.requests) state.requests.length = MONITOR_LIMITS.requests;
      // A new request: agents not holding a task that waits on the provider are free again.
      for (const a of Object.values(state.agents)) if (a.status !== 'waiting') setAgent(state, a.key, 'idle', e.at, { activity: undefined });
      setAgent(state, 'master', 'running', e.at, { activity: `Understanding: “${e.request ?? ''}”`, taskKey: undefined });
      return;
    case 'request.finished':
    case 'request.failed': {
      if (request) {
        request.finishedAt = e.at;
        request.reply = e.response;
        request.error = e.type === 'request.failed' ? e.error : undefined;
        request.status = e.type === 'request.failed' ? (e.reason === 'cancelled' ? 'cancelled' : 'failed') : e.reason === 'waiting' || e.reason === 'deferred' ? 'waiting' : 'completed';
      }
      const failed = e.type === 'request.failed' && e.reason !== 'cancelled';
      setAgent(state, 'master', failed ? 'failed' : 'completed', e.at, { activity: failed ? e.error : e.type === 'request.failed' ? 'Cancelled' : 'Request handled', lastError: failed ? e.error : state.agents.master.lastError });
      for (const a of Object.values(state.agents)) if (a.key !== 'master' && a.status === 'running') setAgent(state, a.key, 'idle', e.at, { activity: undefined });
      return;
    }
    case 'agent.started':
      if (agent && agent.status !== 'running' && agent.status !== 'waiting') setAgent(state, agent.key, 'running', e.at);
      return;
    case 'model.request':
      state.modelCalls.push({ id: e.callId!, requestId: e.requestId, agent: e.agent!, taskKey: e.taskKey, model: e.model, status: 'running', startedAt: e.at, toolCalls: [] });
      if (agent) {
        agent.counts.modelCalls += 1;
        if (agent.status !== 'running') setAgent(state, agent.key, 'running', e.at);
        agent.activity = `Thinking${e.model ? ` (${e.model})` : ''}…`;
      }
      state.dropped += cap(state.modelCalls, MONITOR_LIMITS.modelCalls);
      return;
    case 'model.response': {
      const call = state.modelCalls.find((c) => c.id === e.callId);
      if (call) Object.assign(call, { status: e.error ? 'failed' : 'ok', finishedAt: e.at, toolCalls: (e.args?.toolCalls as string[] | undefined) ?? [], content: e.response, error: e.error });
      if (agent && e.error) agent.lastError = e.error;
      return;
    }
    case 'tool.called':
      state.toolCalls.push({ id: e.callId!, requestId: e.requestId, agent: e.agent!, taskKey: e.taskKey, taskLabel: e.taskLabel, tool: e.tool!, args: e.args ?? {}, status: 'running', startedAt: e.at, attempt: e.attempt ?? 1 });
      if (agent) {
        agent.counts.toolCalls += 1;
        agent.activity = `Calling ${e.tool}()`;
      }
      state.dropped += cap(state.toolCalls, MONITOR_LIMITS.toolCalls);
      return;
    case 'tool.completed':
    case 'tool.failed': {
      const call = state.toolCalls.find((c) => c.id === e.callId);
      if (call) Object.assign(call, { status: e.type === 'tool.failed' ? 'failed' : e.reason === 'awaitUser' ? 'waiting' : 'ok', finishedAt: e.at, response: e.response, error: e.error });
      if (agent && e.type === 'tool.failed') agent.lastError = e.error;
      if (agent?.activity?.startsWith('Calling')) agent.activity = undefined;
      return;
    }
    case 'task.created': {
      const t = e.task!;
      state.tasks[e.taskKey!] = {
        key: e.taskKey!,
        label: e.taskLabel!,
        requestId: e.requestId,
        localId: e.taskKey!.slice(e.taskKey!.lastIndexOf(':') + 1),
        request: t.request,
        instruction: t.instruction,
        agent: 'master',
        createdBy: t.createdBy,
        executionType: t.executionType,
        dependsOn: t.dependsOn,
        route: t.route,
        status: 'PENDING',
        createdAt: e.at,
        retryCount: 0,
        reassignments: [],
      };
      state.taskOrder.push(e.taskKey!);
      const over = state.taskOrder.length - MONITOR_LIMITS.tasks;
      if (over > 0) for (const key of state.taskOrder.splice(0, over)) delete state.tasks[key];
      state.dropped += Math.max(0, over);
      return;
    }
    case 'task.assigned':
      if (task && e.to && e.to !== 'provider') {
        task.agent = e.to;
        task.assignedAt = e.at;
        state.agents[e.to].counts.tasks += 1;
      }
      return;
    case 'task.accepted':
    case 'task.resumed':
      if (task) {
        task.status = 'IN_PROGRESS';
        task.startedAt ??= e.at;
        task.model = e.model ?? task.model;
        task.waitingFor = undefined;
        setAgent(state, task.agent, 'running', e.at, { taskKey: task.key, activity: `Working on task ${task.label}` });
      }
      return;
    case 'task.waiting':
      if (task) {
        task.status = 'WAITING_FOR_USER';
        task.waitingFor = e.response;
        setAgent(state, task.agent, 'waiting', e.at, { taskKey: task.key, activity: `Waiting for the provider (task ${task.label})` });
      }
      return;
    case 'task.completed':
      if (task) {
        task.status = 'COMPLETED';
        task.finishedAt = e.at;
        task.result = e.response;
        task.error = undefined;
        task.waitingFor = undefined;
        state.agents[task.agent].counts.completed += 1;
        setAgent(state, task.agent, 'completed', e.at, { taskKey: task.key, activity: `Completed task ${task.label}` });
      }
      return;
    case 'task.failed':
      if (task) {
        task.status = 'FAILED';
        task.error = e.error;
        task.finishedAt = e.at;
        state.agents[task.agent].counts.failed += 1;
        setAgent(state, task.agent, 'failed', e.at, { taskKey: task.key, activity: `Task ${task.label} failed`, lastError: e.error });
      }
      return;
    case 'task.retry':
      if (task) {
        task.status = 'PENDING';
        task.retryCount = e.attempt ?? task.retryCount + 1;
        task.finishedAt = undefined;
      }
      return;
    case 'task.requeued':
      if (task) task.status = 'PENDING';
      return;
    case 'task.reassigned':
      if (task && e.from && e.to && e.from !== 'provider' && e.to !== 'provider') {
        task.reassignments.push({ at: e.at, from: e.from, to: e.to, reason: e.reason ?? '', trigger: e.trigger ?? '', previousStatus: e.previousStatus ?? 'IN_PROGRESS', newStatus: e.newStatus ?? 'PENDING' });
        task.status = 'PENDING';
        task.error = e.reason;
        setAgent(state, e.from, 'idle', e.at, { activity: `Handed task ${task.label} back`, lastError: e.reason });
      }
      return;
    case 'task.cancelled':
      if (task) {
        const wasActive = task.status === 'IN_PROGRESS' || task.status === 'WAITING_FOR_USER';
        task.status = 'CANCELLED';
        task.error = e.reason;
        task.finishedAt = e.at;
        task.waitingFor = undefined;
        const owner = state.agents[task.agent];
        if (wasActive && owner.taskKey === task.key) setAgent(state, task.agent, 'idle', e.at, { activity: `Task ${task.label} cancelled` });
      }
      return;
    case 'handshake.initiated':
      state.handshakes.push({ id: e.handshakeId!, kind: e.kind!, from: e.from!, to: e.to!, requestId: e.requestId, taskKey: e.taskKey, taskLabel: e.taskLabel, status: 'pending', initiatedAt: e.at, detail: e.request ?? e.summary });
      state.dropped += cap(state.handshakes, MONITOR_LIMITS.handshakes);
      return;
    case 'handshake.accepted':
    case 'handshake.rejected':
    case 'handshake.cancelled': {
      const h = state.handshakes.find((x) => x.id === e.handshakeId);
      if (h) Object.assign(h, { status: e.type === 'handshake.accepted' ? 'accepted' : e.type === 'handshake.rejected' ? 'rejected' : 'cancelled', completedAt: e.at, reason: e.reason ?? h.reason });
      return;
    }
    case 'planning.started':
      setAgent(state, 'planning', 'running', e.at, { activity: 'Working out what each action needs' });
      return;
    case 'planning.question':
      setAgent(state, 'planning', 'waiting', e.at, { activity: `Asked: “${e.response ?? ''}”` });
      state.agents.planning.counts.tasks += 1;
      return;
    case 'planning.ready':
      setAgent(state, 'planning', 'completed', e.at, { activity: `Requirements complete${e.approved?.length ? ` (${e.approved.length} values)` : ''}` });
      state.agents.planning.counts.completed += 1;
      return;
    case 'planning.dropped':
      setAgent(state, 'planning', 'idle', e.at, { activity: undefined });
      return;
    case 'safety.reviewed':
      setAgent(state, 'safety', e.level === 'running' ? 'running' : 'completed', e.at, { activity: e.summary.replace(/^Safety Agent:\s*/, '') });
      return;
    case 'safety.corrected':
    case 'safety.blocked': {
      const blocked = e.type === 'safety.blocked';
      setAgent(state, 'safety', blocked ? 'waiting' : 'completed', e.at, { activity: blocked ? `Asked the provider instead of running ${e.from ?? 'the'} call` : `Removed or corrected ${e.findings?.length ?? 0} value${e.findings?.length === 1 ? '' : 's'}` });
      state.agents.safety.counts.tasks += e.findings?.length ?? 0;
      if (blocked) state.agents.safety.counts.failed += 1;
      else state.agents.safety.counts.completed += 1;
      return;
    }
    default:
      return;
  }
}

const monitorSlice = createSlice({
  name: 'monitor',
  initialState,
  reducers: {
    record(state, action: PayloadAction<MonitorEvent[]>) {
      for (const e of action.payload) {
        state.events.push(e);
        apply(state, e);
      }
      state.dropped += cap(state.events, MONITOR_LIMITS.events);
    },
    /** The whole state from the window that runs the agents (Agent Monitoring in its own window). */
    replace(_state, action: PayloadAction<MonitorState>) {
      return action.payload;
    },
    /** Sign-out: the trail names patients, so nothing of it stays. */
    reset(state) {
      const fresh = initialState();
      // What runs is still what runs: keep the configuration.
      Object.assign(state, fresh, { mode: state.mode, models: state.models, speech: state.speech, configuredAt: state.configuredAt });
    },
  },
});

export const monitorActions = monitorSlice.actions;
export default monitorSlice.reducer;

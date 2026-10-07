/**
 * Agent monitoring — the observability record of the assistant (Configuration → Agent Monitoring).
 *
 * Everything is an EVENT first: an append-only audit trail of what the agents did (services/ai/monitor).
 * The monitor slice projects those events into what the monitoring screen shows — each agent's state, every
 * task's lifecycle, the handshakes between agents, the tool and model calls — so the screen and the audit
 * trail can never disagree.
 */
import type { AgentName, ExecutionType, SafetyFinding, TaskStatus } from './ai';

/**
 * An agent of the assistant: the master (the whole assistant in single-agent mode), the Planning Agent, the
 * Safety Agent (rules — no model), or a specialist.
 */
export type MonitorAgentKey = 'master' | 'planning' | 'safety' | AgentName;

/** Who takes part in a handshake: an agent, or the provider (the person speaking to the assistant). */
export type MonitorParty = MonitorAgentKey | 'provider';

export type MonitorEventType =
  | 'agents.configured'
  | 'agent.started'
  | 'agent.stopped'
  | 'request.started'
  | 'request.finished'
  | 'request.failed'
  | 'task.created'
  | 'task.assigned'
  | 'task.accepted'
  | 'task.waiting'
  | 'task.resumed'
  | 'task.completed'
  | 'task.failed'
  | 'task.retry'
  | 'task.requeued'
  | 'task.reassigned'
  | 'task.cancelled'
  | 'handshake.initiated'
  | 'handshake.accepted'
  | 'handshake.rejected'
  | 'handshake.cancelled'
  | 'tool.called'
  | 'tool.completed'
  | 'tool.failed'
  | 'model.request'
  | 'model.response'
  | 'planning.started'
  | 'planning.question'
  | 'planning.ready'
  | 'planning.dropped'
  | 'safety.corrected'
  | 'safety.blocked'
  | 'safety.reviewed'
  | 'error';

export type MonitorLevel = 'ok' | 'info' | 'running' | 'warning' | 'error';

/**
 * Why two parties shook hands. request: the provider gave the master a request. delegation: the master gave
 * a specialist a task. handoff: a task's results went to the agent of a task that depends on it. resume: the
 * provider answered the question a task was waiting on.
 */
export type HandshakeKind = 'request' | 'delegation' | 'handoff' | 'resume';

/** What failed, for the Errors tab. */
export type MonitorErrorKind = 'model' | 'tool' | 'task' | 'handshake' | 'request';

/** One agent's model, as the monitoring screen shows it. */
export interface AgentModelInfo {
  model: string;
  /** Where it runs: This Computer, Kaggle, OpenRouter — or the runtime's own name. */
  provider: string;
}

/** One entry of the audit trail. Never changed once recorded. */
export interface MonitorEvent {
  id: string;
  /** Order of recording (timestamps can tie). */
  seq: number;
  at: number;
  type: MonitorEventType;
  level: MonitorLevel;
  /** The line the logs show. */
  summary: string;
  requestId?: string;
  agent?: MonitorAgentKey;
  /** A task: its key (unique across requests) and the label people read ("#1004"). */
  taskKey?: string;
  taskLabel?: string;
  tool?: string;
  model?: string;
  callId?: string;
  handshakeId?: string;
  durationMs?: number;
  /** What was asked (a tool's arguments, a request's words) and what came back — clipped. */
  request?: string;
  response?: string;
  error?: string;
  // ---- event-specific details
  from?: MonitorParty;
  to?: MonitorParty;
  kind?: HandshakeKind;
  errorKind?: MonitorErrorKind;
  /** The operation that failed ("add_medications", "Task #1004", "Model request"). */
  operation?: string;
  reason?: string;
  /** Who or what triggered a reassignment or retry. */
  trigger?: string;
  previousStatus?: TaskStatus;
  newStatus?: TaskStatus;
  /** A tool call's attempt (1, 2 …) or a task's retry number. */
  attempt?: number;
  /** A tool call's arguments as given. */
  args?: Record<string, unknown>;
  task?: { instruction: string; executionType: ExecutionType; dependsOn: string[]; request: string; route: 'fast' | 'planned'; createdBy: MonitorParty };
  mode?: 'single' | 'multi';
  models?: Partial<Record<MonitorAgentKey, AgentModelInfo>>;
  speech?: AgentModelInfo;
  /** What the Safety Agent did with each value it checked. */
  findings?: SafetyFinding[];
  /** The Planning Agent: what each action still needs, and what was approved. */
  missing?: string[];
  approved?: string[];
}

export type AgentRunStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed';

export interface MonitorAgentState {
  key: MonitorAgentKey;
  status: AgentRunStatus;
  /** The task it is on (or last was on), and what it is doing in words. */
  taskKey?: string;
  activity?: string;
  /** When the current status began. */
  since?: number;
  lastError?: string;
  counts: { tasks: number; completed: number; failed: number; toolCalls: number; modelCalls: number };
}

export interface MonitorReassignment {
  at: number;
  from: MonitorAgentKey;
  to: MonitorAgentKey;
  reason: string;
  trigger: string;
  previousStatus: TaskStatus;
  newStatus: TaskStatus;
}

export interface MonitorTask {
  key: string;
  label: string;
  requestId?: string;
  /** The task's id in its graph (t1, t2 …). */
  localId: string;
  request: string;
  instruction: string;
  agent: MonitorAgentKey;
  createdBy: MonitorParty;
  executionType: ExecutionType;
  dependsOn: string[];
  route: 'fast' | 'planned';
  status: TaskStatus;
  createdAt: number;
  assignedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  model?: string;
  retryCount: number;
  error?: string;
  waitingFor?: string;
  result?: string;
  reassignments: MonitorReassignment[];
}

export interface MonitorHandshake {
  id: string;
  kind: HandshakeKind;
  from: MonitorParty;
  to: MonitorParty;
  requestId?: string;
  taskKey?: string;
  taskLabel?: string;
  /** cancelled: the offer lapsed before anyone answered it (the task was dropped first) — nobody refused. */
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  initiatedAt: number;
  completedAt?: number;
  detail: string;
  reason?: string;
}

export interface MonitorToolCall {
  id: string;
  requestId?: string;
  agent: MonitorAgentKey;
  taskKey?: string;
  taskLabel?: string;
  tool: string;
  args: Record<string, unknown>;
  /** waiting: it succeeded and left a question or confirmation for the provider. */
  status: 'running' | 'ok' | 'waiting' | 'failed';
  startedAt: number;
  finishedAt?: number;
  response?: string;
  error?: string;
  attempt: number;
}

export interface MonitorModelCall {
  id: string;
  requestId?: string;
  agent: MonitorAgentKey;
  taskKey?: string;
  model?: string;
  status: 'running' | 'ok' | 'failed';
  startedAt: number;
  finishedAt?: number;
  toolCalls: string[];
  content?: string;
  error?: string;
}

export interface MonitorRequest {
  id: string;
  said: string;
  mode: 'single' | 'multi';
  startedAt: number;
  finishedAt?: number;
  reply?: string;
  error?: string;
  status: 'running' | 'completed' | 'waiting' | 'failed' | 'cancelled';
}

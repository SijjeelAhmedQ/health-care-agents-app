/**
 * The master's task graph: the one authoritative record of a request in multi-agent mode.
 *
 *   PENDING ─► ASSIGNED ─► IN_PROGRESS ─► COMPLETED
 *                              │
 *                              ├─► WAITING_FOR_USER ─► (the provider answers) ─► IN_PROGRESS …
 *                              ├─► FAILED ─► PENDING (retried once, or reassigned) … or FAILED for good
 *                              └─► CANCELLED (the provider said no, or what it needed failed)
 *
 * Dependencies and order are different things: a task is READY when every task it depends on has
 * COMPLETED, whatever its place in the list. Which ready tasks may run together is the scheduler's
 * business (master.ts), from their execution types. Pure logic — no model, no runtime, no Redux.
 */
import type { AgentName, AgentTask, ExecutionType, PlanStep, TaskGraphSnapshot, TaskResultData, TaskStatus } from '@/types/ai';

export const AGENT_NAMES: readonly AgentName[] = ['patients', 'dashboard', 'appointments', 'patient_appointments', 'medications', 'diagnoses', 'tasks', 'recalls', 'notes', 'summary', 'inbox'];

export const AGENT_TITLES: Record<AgentName, string> = {
  patients: 'Patients Agent',
  dashboard: 'Dashboard Agent',
  appointments: 'My Appointment Agent',
  patient_appointments: 'Appointments Agent',
  medications: 'Medication Agent',
  diagnoses: 'Diagnoses Agent',
  tasks: 'Tasks Agent',
  recalls: 'Recalls Agent',
  notes: 'Notes Agent',
  summary: 'Summary Agent',
  inbox: 'Inbox Agent',
};

/** Strictness order: a task may always be treated as stricter than declared, never looser. */
const STRICTNESS: Record<ExecutionType, number> = { READ_ONLY: 0, CONTEXT: 1, WRITE: 2 };
export const stricter = (a: ExecutionType, b: ExecutionType): ExecutionType => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);

/** A task as the master asked for it (before the graph gives it an id, a status and its checks). */
export interface TaskRequest {
  id?: string;
  agent: AgentName;
  instruction: string;
  dependsOn?: string[];
  executionType?: ExecutionType;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Which moves the lifecycle allows. Anything else is a bug in the scheduler, and throws. */
const MOVES: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'FAILED', 'WAITING_FOR_USER', 'CANCELLED', 'PENDING'],
  WAITING_FOR_USER: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  FAILED: ['PENDING'],
  COMPLETED: [],
  CANCELLED: [],
};

let graphCounter = 0;

export class TaskGraph {
  readonly id = `graph-${Date.now().toString(36)}-${(graphCounter++).toString(36)}`;
  readonly createdAt = Date.now();
  finishedAt?: number;
  readonly tasks: AgentTask[];
  /** What the master's list said that the graph could not keep (a dependency on a later or unknown task). */
  readonly notes: string[] = [];

  constructor(
    readonly request: string,
    requests: TaskRequest[],
    readonly route: 'fast' | 'planned' = requests.length === 1 ? 'fast' : 'planned',
  ) {
    const ids = new Map<string, string>();
    this.tasks = requests.map((r, i) => {
      const id = `t${i + 1}`;
      if (r.id) ids.set(r.id.trim(), id);
      ids.set(id, id);
      return {
        id,
        agent: r.agent,
        instruction: r.instruction.trim(),
        dependsOn: [],
        executionType: r.executionType ?? 'WRITE', // unknown: the strictest — never run beside anything
        status: 'PENDING',
        retryCount: 0,
      };
    });
    // Only a task listed earlier can be depended on: the graph has no cycles by construction.
    requests.forEach((r, i) => {
      for (const dep of r.dependsOn ?? []) {
        const target = ids.get(dep.trim());
        const index = target ? this.tasks.findIndex((t) => t.id === target) : -1;
        if (index < 0 || index >= i) {
          this.notes.push(`${this.tasks[i].id}: dropped dependency "${dep}" (${index < 0 ? 'no such task' : 'not an earlier task'})`);
          continue;
        }
        if (!this.tasks[i].dependsOn.includes(target!)) this.tasks[i].dependsOn.push(target!);
      }
    });
  }

  /** A task the Planning Agent split off another ("select Chloe Bell, then add Metformin"): it runs after it. */
  addAfter(after: AgentTask, r: { agent: AgentName; instruction: string; executionType?: ExecutionType }): AgentTask {
    const task: AgentTask = { id: `t${this.tasks.length + 1}`, agent: r.agent, instruction: r.instruction, dependsOn: [after.id], executionType: r.executionType ?? 'WRITE', status: 'PENDING', retryCount: 0 };
    this.tasks.push(task);
    return task;
  }

  /**
   * A task the Planning Agent split off another that runs BESIDE it ("add Metformin and a task for BP monitoring":
   * the Medication Agent's and the Tasks Agent's) — same dependencies, listed right after it. Records added
   * this way join one care plan, saved with one confirmation.
   */
  addBeside(beside: AgentTask, r: { agent: AgentName; instruction: string; executionType?: ExecutionType }): AgentTask {
    const ids = new Set(this.tasks.map((t) => t.id));
    let n = this.tasks.length + 1;
    while (ids.has(`t${n}`)) n++;
    const task: AgentTask = { id: `t${n}`, agent: r.agent, instruction: r.instruction, dependsOn: [...beside.dependsOn], executionType: r.executionType ?? 'WRITE', status: 'PENDING', retryCount: 0 };
    const at = this.tasks.indexOf(beside);
    let after = at;
    while (after + 1 < this.tasks.length && this.tasks[after + 1].splitFrom === beside.id) after++;
    task.splitFrom = beside.id;
    this.tasks.splice(after + 1, 0, task);
    return task;
  }

  get(id: string): AgentTask {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`No task ${id}`);
    return task;
  }

  /** Move a task along its lifecycle. */
  move(id: string, status: TaskStatus, patch: Partial<AgentTask> = {}) {
    const task = this.get(id);
    if (task.status !== status && !MOVES[task.status].includes(status)) throw new Error(`Task ${id}: ${task.status} → ${status} is not allowed`);
    Object.assign(task, patch, { status });
    if (status !== 'WAITING_FOR_USER') delete task.waitingFor;
    if (this.done && !this.finishedAt) this.finishedAt = Date.now();
    return task;
  }

  /** Tasks that can start now: PENDING, with everything they depend on COMPLETED. In list order. */
  ready(): AgentTask[] {
    return this.tasks.filter((t) => t.status === 'PENDING' && t.dependsOn.every((d) => this.get(d).status === 'COMPLETED'));
  }

  /**
   * Cancel what can never run: tasks depending (directly or not) on a task that failed or was cancelled.
   * Returns the tasks cancelled now.
   */
  cancelUnreachable(): AgentTask[] {
    const cancelled: AgentTask[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of this.tasks) {
        if (t.status !== 'PENDING') continue;
        const blocker = t.dependsOn.map((d) => this.get(d)).find((d) => d.status === 'FAILED' || d.status === 'CANCELLED');
        if (blocker) {
          this.move(t.id, 'CANCELLED', { error: `Not done: it needed ${blocker.id} (${blocker.instruction}), which ${blocker.status === 'FAILED' ? 'failed' : 'was cancelled'}.` });
          cancelled.push(t);
          changed = true;
        }
      }
    }
    return cancelled;
  }

  /**
   * The task that is waiting on the provider, if any: the one whose question or confirmation is on screen —
   * never a task whose records only joined its care plan.
   */
  waiting(): AgentTask | undefined {
    return this.tasks.find((t) => t.status === 'WAITING_FOR_USER' && !t.joinedInto) ?? this.tasks.find((t) => t.status === 'WAITING_FOR_USER');
  }

  /** The tasks whose records joined this task's care plan (they wait on its confirmation). */
  joined(lead: AgentTask): AgentTask[] {
    return this.tasks.filter((t) => t.joinedInto === lead.id && t.status === 'WAITING_FOR_USER');
  }

  /**
   * A task's records went into `lead`'s care plan: from now on `lead` holds the one confirmation for all of
   * them — the tasks that joined it before move over too.
   */
  join(task: AgentTask, lead: AgentTask) {
    for (const t of this.tasks) if (t.joinedInto === task.id) t.joinedInto = lead.id;
    task.joinedInto = lead.id;
  }

  /** The lead task settled: every task that joined it ends the same way (saved together, or cancelled together). */
  settleJoined(lead: AgentTask, status: 'COMPLETED' | 'CANCELLED', patch: Partial<AgentTask> = {}) {
    for (const t of this.joined(lead)) this.move(t.id, status, { ...patch, joinedInto: undefined });
  }

  get done() {
    return this.tasks.every((t) => TERMINAL.has(t.status));
  }

  /** Nothing is running or waiting — only tasks that were never started are left (or none). */
  get idle() {
    return !this.tasks.some((t) => t.status === 'ASSIGNED' || t.status === 'IN_PROGRESS' || t.status === 'WAITING_FOR_USER');
  }

  /** A new request replaced this one: what never started is dropped, and a question left open is too. */
  supersede(reason = 'Replaced by a newer request.') {
    for (const t of this.tasks) if (!TERMINAL.has(t.status)) this.move(t.id, 'CANCELLED', { error: reason });
  }

  /**
   * RESULTS FROM EARLIER TASKS for a task: what every task it depends on (directly or not) returned —
   * structured ids and names first, so the next specialist never has to rediscover them.
   */
  resultsFor(task: AgentTask): string[] {
    const seen = new Set<string>();
    const visit = (id: string): string[] => {
      if (seen.has(id)) return [];
      seen.add(id);
      const dep = this.get(id);
      return [...dep.dependsOn.flatMap(visit), formatResult(dep)];
    };
    return task.dependsOn.flatMap(visit);
  }

  snapshot(): TaskGraphSnapshot {
    return {
      id: this.id,
      request: this.request,
      route: this.route,
      tasks: this.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn], triedAgents: t.triedAgents ? [...t.triedAgents] : undefined })),
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
    };
  }

  /** The graph as the assistant panel's step list shows it. */
  planSteps(): PlanStep[] {
    return this.tasks.map((t) => ({ text: t.instruction, status: planStatus(t.status), taskId: t.id, agent: t.agent }));
  }
}

function planStatus(status: TaskStatus): PlanStep['status'] {
  switch (status) {
    case 'PENDING':
    case 'ASSIGNED':
      return 'pending';
    case 'IN_PROGRESS':
      return 'running';
    case 'WAITING_FOR_USER':
      return 'waiting';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'done';
  }
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** One task's result, as the line a dependent task reads. */
export function formatResult(task: AgentTask): string {
  const r: TaskResultData = task.result ?? {};
  const parts = [
    r.patientId ? `patientId=${r.patientId}` : '',
    r.patientName ? `patientName=${r.patientName}` : '',
    r.data !== undefined ? `data=${show(r.data)}` : '',
    r.reply ? `reply="${r.reply}"` : '',
  ].filter(Boolean);
  return `${task.id} (${task.agent}, ${task.status}): ${task.instruction}${parts.length ? ` → ${parts.join('; ')}` : ''}`;
}

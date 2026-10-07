/**
 * The monitor's recorder: what the assistant already reports, turned into an audit trail.
 *
 *   agent steps (model / tool) ──┐
 *   task-graph snapshots ────────┼─► MonitorRecorder ─► MonitorEvent[] ─► monitor slice ─► Agent Monitoring
 *   request start / end ─────────┘
 *
 * It only OBSERVES: it reads the same hooks the assistant panel and the debug panel read (onStep, onGraph)
 * and never changes how a request is orchestrated. The task lifecycle comes from successive graph snapshots
 * — what changed between two of them is what happened (accepted, waiting, retried, reassigned …) — and the
 * handshakes are the moments work passes between parties:
 *
 *   provider ─request─► master ─delegation─► specialist ─handoff─► specialist (a task that needs its results)
 *   provider ─resume─► specialist (the answer to the question its task was waiting on)
 *
 * Pure logic — no Redux, no React — so it is tested on its own.
 */
import type { AgentStep, AgentTask, SafetyFinding, TaskGraphSnapshot, TaskStatus } from '@/types/ai';
import type { AgentModelInfo, HandshakeKind, MonitorAgentKey, MonitorEvent, MonitorParty } from '@/types/monitor';
import { AGENT_TITLES } from '../agents/taskGraph';

const NOT_MY_TASK = 'not_my_task';
const CLIP = 700;

export const PARTY_TITLES: Record<MonitorParty, string> = { provider: 'Provider', master: 'Master Agent', planning: 'Planning Agent', safety: 'Safety Agent', ...AGENT_TITLES };

/** What the Planning Agent reports as it gathers a request's requirements. */
export interface PlanningReport {
  type: 'started' | 'question' | 'ready' | 'dropped';
  question?: string;
  missing?: string[];
  approved?: string[];
  findings?: SafetyFinding[];
}

/** A value as text, cut to a readable length. */
export function clip(value: unknown, max = CLIP): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

type Draft = Omit<MonitorEvent, 'id' | 'seq' | 'at'> & { at?: number };

interface KnownTask {
  label: string;
  last: AgentTask;
  /** The open delegation handshake (master → its agent), until the agent accepts or rejects it. */
  delegation?: string;
  /** The last delegation accepted: an agent that took the task and then handed it back rejects this one. */
  accepted?: string;
}

interface OpenStep {
  agent: MonitorAgentKey;
  taskKey?: string;
  tool?: string;
  startedAt: number;
}

let recorderCounter = 0;

export class MonitorRecorder {
  private readonly prefix = `m${Date.now().toString(36)}${(recorderCounter++).toString(36)}`;
  private seq = 0;
  private taskSeq = 1000;
  private requestSeq = 0;
  private handshakeSeq = 0;
  private batch: MonitorEvent[] = [];
  /** The request in progress. Its handshake with the master opens with the master's first step: an answer to a waiting task goes straight to that task's agent. */
  private request: { id: string; said: string; active: Set<MonitorAgentKey>; handshake?: string; accepted: boolean } | null = null;
  private graphId: string | null = null;
  private readonly tasks = new Map<string, KnownTask>();
  private readonly open = new Map<string, OpenStep>();
  /** Per task and tool: how many times it was called, and whether the last call failed (retries). */
  private readonly attempts = new Map<string, { count: number; lastFailed: boolean }>();
  /** A specialist handed its task back (not_my_task): why, for the reassignment that follows. */
  private readonly handBacks = new Map<string, { reason?: string; better?: string }>();

  constructor(
    private readonly sink: (events: MonitorEvent[]) => void,
    /** The model an agent thinks with now, e.g. "ollama:qwen3.5:4b". */
    private readonly modelOf: (agent: MonitorAgentKey) => string | undefined = () => undefined,
  ) {}

  // ------------------------------------------------------------------------------------------ inputs

  /** The agents were (re)built: which model and provider each runs on, and the speech model. */
  configured(mode: 'single' | 'multi', models: Partial<Record<MonitorAgentKey, AgentModelInfo>>, speech?: AgentModelInfo) {
    const agents = Object.keys(models) as MonitorAgentKey[];
    this.push({
      type: 'agents.configured',
      level: 'info',
      summary: `${mode === 'multi' ? 'Multi-agent' : 'Single-agent'} mode: ${agents.map((a) => `${PARTY_TITLES[a]} on ${models[a]!.model} (${models[a]!.provider})`).join(', ')}${speech ? `; speech: ${speech.model} (${speech.provider})` : ''}`,
      mode,
      models,
      speech,
    });
    this.flush();
  }

  /** A request reached the assistant. Returns its id. */
  beginRequest(said: string, mode: 'single' | 'multi'): string {
    if (this.request) this.endRequest({ error: 'Superseded before it finished.' });
    const id = `${this.prefix}-r${++this.requestSeq}`;
    this.request = { id, said, active: new Set(), accepted: false };
    this.push({ type: 'request.started', level: 'running', summary: `Provider: “${clip(said, 160)}”`, requestId: id, request: clip(said), mode });
    this.flush();
    return id;
  }

  /** The request is over: answered, waiting on the provider, failed or cancelled. */
  endRequest(end: { reply?: string; awaiting?: boolean; deferred?: boolean; error?: string; cancelled?: boolean }) {
    const request = this.request;
    if (!request) return;
    // Anything still open will not finish now: say so instead of leaving it "running" forever.
    for (const [callId, step] of this.open) {
      const why = end.cancelled ? 'Interrupted: the request was cancelled.' : end.error ? `Interrupted: ${end.error}` : 'Never reported back.';
      if (step.tool) this.toolFinished(callId, step, { ok: false, message: why }, Date.now());
      else this.push({ type: 'model.response', level: 'error', summary: `${PARTY_TITLES[step.agent]}: model call interrupted`, agent: step.agent, taskKey: step.taskKey, taskLabel: this.labelOf(step.taskKey), callId, error: why, durationMs: Date.now() - step.startedAt });
    }
    this.open.clear();
    const failed = !!end.error && !end.cancelled;
    if (request.handshake && !request.accepted) {
      const lapsed = end.deferred || end.cancelled;
      this.push({ type: lapsed ? 'handshake.cancelled' : 'handshake.rejected', level: lapsed ? 'warning' : 'error', summary: `Provider → Master Agent: ${end.deferred ? 'held for the rest of the sentence' : end.cancelled ? 'cancelled' : 'request not taken up'}`, requestId: request.id, handshakeId: request.handshake, from: 'provider', to: 'master', kind: 'request', reason: end.error ?? (end.cancelled ? 'Cancelled.' : end.deferred ? 'Unfinished sentence.' : 'No answer.') });
    }
    for (const agent of request.active) this.push({ type: 'agent.stopped', level: 'info', summary: `${PARTY_TITLES[agent]} stopped`, requestId: request.id, agent });
    if (failed || end.cancelled) {
      this.push({ type: 'request.failed', level: end.cancelled ? 'warning' : 'error', summary: end.cancelled ? 'Request cancelled' : `Request failed: ${clip(end.error, 200)}`, requestId: request.id, error: end.error ?? 'Cancelled.', reason: end.cancelled ? 'cancelled' : 'failed' });
      if (failed) this.push({ type: 'error', level: 'error', summary: `Request failed: ${clip(end.error, 200)}`, requestId: request.id, agent: 'master', errorKind: 'request', operation: `Request “${clip(request.said, 80)}”`, error: end.error });
    } else {
      this.push({ type: 'request.finished', level: end.awaiting ? 'warning' : 'ok', summary: end.deferred ? 'Waiting for the rest of the sentence' : end.awaiting ? `Waiting for the provider: ${clip(end.reply, 200)}` : `Answered: ${clip(end.reply, 200)}`, requestId: request.id, response: clip(end.reply ?? ''), reason: end.deferred ? 'deferred' : end.awaiting ? 'waiting' : 'completed' });
    }
    this.request = null;
    this.flush();
  }

  /** An agent step (a model call or a tool call), as the agent loop reports it: once started, once finished. */
  step(step: AgentStep) {
    const agent: MonitorAgentKey = step.agent ?? 'master';
    const taskKey = step.taskId && this.graphId ? `${this.graphId}:${step.taskId}` : undefined;
    this.activate(agent);
    if (agent === 'master' && this.request && !this.request.handshake) {
      this.request.handshake = this.nextHandshake();
      this.push({ type: 'handshake.initiated', level: 'running', summary: 'Provider → Master Agent: request handed over', handshakeId: this.request.handshake, from: 'provider', to: 'master', kind: 'request', request: clip(this.request.said, 200), at: step.startedAt });
    }
    if (step.type === 'model') {
      if (!step.finishedAt) {
        this.open.set(step.id, { agent, taskKey, startedAt: step.startedAt });
        this.push({ type: 'model.request', level: 'running', summary: `${PARTY_TITLES[agent]} → ${this.modelOf(agent) ?? 'model'}: model request`, agent, taskKey, taskLabel: this.labelOf(taskKey), model: this.modelOf(agent), callId: step.id, at: step.startedAt });
      } else {
        this.open.delete(step.id);
        const calls = step.toolCalls?.map((c) => c.name) ?? [];
        this.push({
          type: 'model.response',
          level: step.error ? 'error' : 'ok',
          summary: step.error ? `${PARTY_TITLES[agent]}: model error — ${clip(step.error, 160)}` : `${PARTY_TITLES[agent]}: model ${calls.length ? `called ${calls.join(', ')}` : 'replied'}`,
          agent,
          taskKey,
          taskLabel: this.labelOf(taskKey),
          model: this.modelOf(agent),
          callId: step.id,
          durationMs: step.finishedAt - step.startedAt,
          response: step.error ? undefined : clip(step.content || (calls.length ? calls.join(', ') : '')),
          error: step.error,
          args: calls.length ? { toolCalls: calls } : undefined,
          at: step.finishedAt,
        });
        if (step.error) this.push({ type: 'error', level: 'error', summary: `${PARTY_TITLES[agent]}: ${clip(step.error, 160)}`, agent, taskKey, taskLabel: this.labelOf(taskKey), model: this.modelOf(agent), callId: step.id, errorKind: 'model', operation: 'Model request', error: step.error, at: step.finishedAt });
        else if (agent === 'master' && this.request?.handshake && !this.request.accepted) {
          this.request.accepted = true;
          this.push({ type: 'handshake.accepted', level: 'ok', summary: 'Provider → Master Agent: request accepted', requestId: this.request.id, handshakeId: this.request.handshake, from: 'provider', to: 'master', kind: 'request', at: step.finishedAt });
        }
      }
      this.flush();
      return;
    }
    // A tool step. Some (wait_for_more_speech) arrive already finished: record both ends.
    if (!this.open.has(step.id)) this.toolStarted(step.id, agent, taskKey, step.call.name, step.call.arguments, step.startedAt);
    if (step.finishedAt && step.result) {
      const open = this.open.get(step.id)!;
      this.open.delete(step.id);
      if (step.safety?.length) this.safetyFindings(step.safety, agent, taskKey, step.id, step.result, step.finishedAt);
      this.toolFinished(step.id, open, step.result, step.finishedAt, step.call.arguments);
    }
    this.flush();
  }

  /** The Planning Agent's progress: started, asked the provider, approved the requirements, or dropped them. */
  planning(report: PlanningReport) {
    const missing = report.missing ?? [];
    const summary = {
      started: 'Planning Agent: working out what each action needs',
      question: `Planning Agent asked the provider: “${report.question ?? ''}”`,
      ready: `Planning Agent: requirements complete${report.approved?.length ? ` — ${report.approved.length} value${report.approved.length === 1 ? '' : 's'} approved` : ''}`,
      dropped: 'Planning Agent: the open requirements were dropped (the provider asked for something else)',
    }[report.type];
    this.push({
      type: `planning.${report.type}`,
      level: report.type === 'question' ? 'warning' : report.type === 'started' ? 'running' : report.type === 'ready' ? 'ok' : 'info',
      summary,
      agent: 'planning',
      missing: missing.length ? missing : undefined,
      approved: report.approved,
      response: report.question,
      findings: report.findings,
    });
    if (report.findings?.length) this.safetyFindings(report.findings, 'planning', undefined, undefined, undefined, Date.now());
    this.flush();
  }

  /** The Safety Agent checked a reply before the provider saw or heard it: as said, or what it corrected. */
  replyChecked(findings: Array<{ issue: string; quote: string }>, what = 'response') {
    const issues: Record<string, string> = {
      'claims-saved': 'it said something was saved that still waits for the yes',
      'wrong-patient': 'it spoke of another patient than the one whose record waits',
      'unknown-value': 'it gave a value nobody said and the app does not hold',
      'summary': 'the summary text did not match the data',
      'summary-urgency': 'the summary called records urgent that their own priority does not',
    };
    const summary = findings.length
      ? `Safety Agent: corrected the ${what} before it was shown — ${[...new Set(findings.map((f) => issues[f.issue] ?? f.issue))].join('; ')}`
      : `Safety Agent: ${what} checked before it was shown — only what was said and done`;
    this.push({ type: 'safety.reviewed', level: findings.length ? 'warning' : 'ok', summary, agent: 'safety' });
    this.flush();
  }

  /** The Safety Agent's model looking at a risky call: begun, and what it found (or why it could not). */
  safetyReview(tool: string, outcome: 'started' | { status: 'ok' } | { status: 'problems'; problems: unknown[] } | { status: 'skipped'; reason: string }) {
    const summary =
      outcome === 'started'
        ? `Safety Agent: reviewing ${tool} against what the provider said`
        : outcome.status === 'ok'
          ? `Safety Agent: ${tool} matches what the provider said`
          : outcome.status === 'problems'
            ? `Safety Agent: ${tool} does not match what the provider said (${outcome.problems.length})`
            : `Safety Agent: review of ${tool} skipped — ${outcome.reason}; the rules' check stands`;
    this.push({ type: 'safety.reviewed', level: outcome === 'started' ? 'running' : outcome.status === 'ok' ? 'ok' : outcome.status === 'problems' ? 'warning' : 'info', summary, agent: 'safety' });
    this.flush();
  }

  /** What the Safety Agent did with a call's values: corrected, removed — or asked the provider instead. */
  private safetyFindings(findings: SafetyFinding[], agent: MonitorAgentKey, taskKey: string | undefined, callId: string | undefined, result: { message: string } | undefined, at: number) {
    const asked = findings.filter((f) => f.action === 'asked');
    const changed = findings.filter((f) => f.action !== 'asked');
    const list = (fs: SafetyFinding[]) => fs.map((f) => (f.action === 'corrected' ? `${f.field} "${f.value}" → "${f.corrected}"` : `${f.field} "${f.value}"`)).join(', ');
    if (changed.length) {
      this.push({ type: 'safety.corrected', level: 'warning', summary: `Safety Agent: ${changed.some((f) => f.action === 'removed') ? 'removed' : 'corrected'} ${list(changed)} — from ${PARTY_TITLES[agent]}'s call, not said by the provider`, agent: 'safety', taskKey, taskLabel: this.labelOf(taskKey), callId, findings: changed, from: agent, at });
    }
    if (asked.length) {
      this.push({ type: 'safety.blocked', level: 'warning', summary: `Safety Agent stopped ${PARTY_TITLES[agent]}'s call (${list(asked)}) and asked the provider: “${result?.message ?? ''}”`, agent: 'safety', taskKey, taskLabel: this.labelOf(taskKey), callId, findings: asked, from: agent, response: result?.message, at });
    }
  }

  /** The task graph changed: what moved since the last snapshot is what happened. */
  graph(snapshot: TaskGraphSnapshot | null) {
    if (!snapshot) return;
    this.graphId = snapshot.id;
    const keyOf = (id: string) => `${snapshot.id}:${id}`;
    for (const task of snapshot.tasks) {
      const key = keyOf(task.id);
      let known = this.tasks.get(key);
      if (!known) {
        known = { label: `#${++this.taskSeq}`, last: { ...task, status: 'PENDING', retryCount: 0, agent: (task.triedAgents?.[0] ?? task.agent) } };
        this.tasks.set(key, known);
        this.created(snapshot, task, key, known);
      }
      this.transition(snapshot, key, known, known.last, task);
      known.last = { ...task, dependsOn: [...task.dependsOn], triedAgents: task.triedAgents ? [...task.triedAgents] : undefined };
    }
    this.flush();
  }

  // -------------------------------------------------------------------------------------- the graph

  private created(snapshot: TaskGraphSnapshot, task: AgentTask, key: string, known: KnownTask) {
    const agent = known.last.agent;
    const deps = task.dependsOn.map((d) => `${snapshot.id}:${d}`);
    this.push({
      type: 'task.created',
      level: 'info',
      summary: `Master Agent created task ${known.label}: ${clip(task.instruction, 160)}`,
      requestId: this.request?.id,
      agent: 'master',
      taskKey: key,
      taskLabel: known.label,
      task: { instruction: task.instruction, executionType: task.executionType, dependsOn: deps, request: snapshot.request, route: snapshot.route, createdBy: 'master' },
      request: clip(task.instruction),
    });
    this.delegate(key, known, agent);
  }

  /** The master hands a task to an agent: assigned, and a handshake the agent has yet to accept. */
  private delegate(key: string, known: KnownTask, agent: MonitorAgentKey, note = '') {
    known.delegation = this.nextHandshake();
    this.push({ type: 'task.assigned', level: 'info', summary: `Task ${known.label} assigned to the ${PARTY_TITLES[agent]}${note}`, requestId: this.request?.id, agent, taskKey: key, taskLabel: known.label, to: agent, newStatus: 'ASSIGNED' });
    this.push({ type: 'handshake.initiated', level: 'running', summary: `Master Agent → ${PARTY_TITLES[agent]}: task ${known.label} offered`, requestId: this.request?.id, handshakeId: known.delegation, from: 'master', to: agent, kind: 'delegation', taskKey: key, taskLabel: known.label, request: clip(known.last.instruction, 200) });
  }

  /**
   * The agent answers the master's offer of a task: accepted, or rejected (it handed the task back). A task
   * dropped before its agent took it up (`lapsed`) cancels the offer — nobody refused it.
   */
  private settleDelegation(key: string, known: KnownTask, accepted: boolean, reason?: string, to: MonitorAgentKey = known.last.agent, lapsed = false) {
    const id = known.delegation ?? (accepted || lapsed ? undefined : known.accepted);
    if (!id) return;
    known.delegation = undefined;
    known.accepted = accepted ? id : undefined;
    const outcome = accepted ? 'accepted' : lapsed ? 'cancelled' : 'rejected';
    this.push({
      type: `handshake.${outcome}`,
      level: accepted ? 'ok' : lapsed ? 'warning' : 'error',
      summary: `Master Agent → ${PARTY_TITLES[to]}: task ${known.label} ${outcome}${reason && !accepted ? ` — ${clip(reason, 160)}` : ''}`,
      requestId: this.request?.id,
      handshakeId: id,
      from: 'master',
      to,
      kind: 'delegation',
      taskKey: key,
      taskLabel: known.label,
      reason,
    });
    if (!accepted && !lapsed) this.push({ type: 'error', level: 'error', summary: `Handshake rejected: ${PARTY_TITLES[to]} did not take task ${known.label}`, requestId: this.request?.id, agent: to, taskKey: key, taskLabel: known.label, errorKind: 'handshake', operation: `Hand task ${known.label} to the ${PARTY_TITLES[to]}`, error: reason ?? 'Rejected.' });
  }

  private transition(snapshot: TaskGraphSnapshot, key: string, known: KnownTask, prev: AgentTask, task: AgentTask) {
    const base = { requestId: this.request?.id, taskKey: key, taskLabel: known.label };
    const label = known.label;

    // Handed to another agent (the one it had sent it back with not_my_task).
    if (task.agent !== prev.agent) {
      const back = this.handBacks.get(key);
      this.handBacks.delete(key);
      const reason = back?.reason ?? task.error ?? 'Not this agent’s task.';
      this.settleDelegation(key, known, false, reason, prev.agent);
      known.accepted = undefined;
      this.push({ ...base, type: 'task.reassigned', level: 'warning', summary: `Task ${label} reassigned: ${PARTY_TITLES[prev.agent]} → ${PARTY_TITLES[task.agent]} (${clip(reason, 140)})`, agent: task.agent, from: prev.agent, to: task.agent, reason, trigger: `${PARTY_TITLES[prev.agent]} handed it back (${NOT_MY_TASK})`, previousStatus: prev.status === 'PENDING' ? 'PENDING' : 'FAILED', newStatus: task.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PENDING' });
      known.last = { ...prev, agent: task.agent, status: 'PENDING' };
      this.delegate(key, known, task.agent, ` (reassigned from the ${PARTY_TITLES[prev.agent]})`);
      prev = known.last;
    }

    // Failed, and sent round again.
    if (task.retryCount > prev.retryCount) {
      const error = task.error ?? 'It failed.';
      this.settleDelegation(key, known, true);
      this.push({ ...base, type: 'task.failed', level: 'error', summary: `Task ${label} failed (attempt ${task.retryCount}): ${clip(error, 160)}`, agent: task.agent, error, previousStatus: prev.status, newStatus: 'FAILED', attempt: task.retryCount });
      this.push({ ...base, type: 'error', level: 'error', summary: `Task ${label} failed: ${clip(error, 160)}`, agent: task.agent, errorKind: 'task', operation: `Task ${label}: ${clip(task.instruction, 80)}`, error, attempt: task.retryCount });
      this.push({ ...base, type: 'task.retry', level: 'warning', summary: `Task ${label}: retry #${task.retryCount} by the ${PARTY_TITLES[task.agent]}`, agent: task.agent, attempt: task.retryCount, reason: error, trigger: 'Master Agent (automatic retry)', previousStatus: 'FAILED', newStatus: 'PENDING' });
      prev = { ...prev, status: 'PENDING', retryCount: task.retryCount };
      known.last = prev;
      this.delegate(key, known, task.agent, ` (retry #${task.retryCount})`);
    }

    if (task.status === prev.status) return;
    const agent = task.agent;
    switch (task.status) {
      case 'PENDING':
        if (prev.status === 'IN_PROGRESS') {
          known.accepted = undefined;
          this.push({ ...base, type: 'task.requeued', level: 'info', summary: `Task ${label} queued again to run on its own (${task.executionType})`, agent, reason: 'It needs to change something, so it cannot run beside other tasks.', previousStatus: prev.status, newStatus: 'PENDING' });
        }
        return;
      case 'ASSIGNED':
        return; // the delegation already said so
      case 'IN_PROGRESS': {
        if (prev.status === 'WAITING_FOR_USER') {
          const id = this.nextHandshake();
          this.push({ ...base, type: 'handshake.initiated', level: 'running', handshakeId: id, from: 'provider', to: agent, kind: 'resume', summary: `Provider → ${PARTY_TITLES[agent]}: answer for task ${label}`, request: clip(this.request?.said ?? '', 200) });
          this.push({ ...base, type: 'handshake.accepted', level: 'ok', handshakeId: id, from: 'provider', to: agent, kind: 'resume', summary: `Provider → ${PARTY_TITLES[agent]}: answer received` });
          this.push({ ...base, type: 'task.resumed', level: 'running', summary: `Task ${label} resumed by the ${PARTY_TITLES[agent]} with the provider’s answer`, agent, previousStatus: prev.status, newStatus: 'IN_PROGRESS', model: task.model });
          return;
        }
        if (!known.delegation) this.delegate(key, known, agent);
        this.settleDelegation(key, known, true);
        this.push({ ...base, type: 'task.accepted', level: 'running', summary: `${PARTY_TITLES[agent]} accepted task ${label}${task.model ? ` (${task.model})` : ''}`, agent, model: task.model, previousStatus: prev.status, newStatus: 'IN_PROGRESS', attempt: task.retryCount + 1 });
        // The results it depends on pass from the agents that produced them.
        for (const dep of task.dependsOn) {
          const depKey = `${snapshot.id}:${dep}`;
          const from = this.tasks.get(depKey);
          if (!from || from.last.agent === agent) continue; // within one agent nothing passes between agents
          const id = this.nextHandshake();
          const detail = `Results of task ${from.label} handed to task ${label}`;
          this.push({ ...base, type: 'handshake.initiated', level: 'running', handshakeId: id, from: from.last.agent, to: agent, kind: 'handoff', summary: `${PARTY_TITLES[from.last.agent]} → ${PARTY_TITLES[agent]}: ${detail}`, request: detail });
          this.push({ ...base, type: 'handshake.accepted', level: 'ok', handshakeId: id, from: from.last.agent, to: agent, kind: 'handoff', summary: `${PARTY_TITLES[from.last.agent]} → ${PARTY_TITLES[agent]}: A2A handshake successful`, response: clip(describeResult(from.last)) });
        }
        return;
      }
      case 'WAITING_FOR_USER':
        this.settleDelegation(key, known, true);
        this.push({ ...base, type: 'task.waiting', level: 'warning', summary: `Task ${label} waiting for the provider: ${clip(task.waitingFor ?? '', 160)}`, agent, response: clip(task.waitingFor ?? ''), previousStatus: prev.status, newStatus: 'WAITING_FOR_USER' });
        return;
      case 'COMPLETED':
        this.settleDelegation(key, known, true);
        this.push({ ...base, type: 'task.completed', level: 'ok', summary: `Task ${label} completed by the ${PARTY_TITLES[agent]}`, agent, response: clip(describeResult(task)), previousStatus: prev.status, newStatus: 'COMPLETED' });
        return;
      case 'FAILED': {
        const error = task.error ?? 'It failed.';
        if (known.delegation) this.settleDelegation(key, known, false, error, agent, true);
        this.push({ ...base, type: 'task.failed', level: 'error', summary: `Task ${label} failed: ${clip(error, 160)}`, agent, error, previousStatus: prev.status, newStatus: 'FAILED', attempt: task.retryCount + 1 });
        this.push({ ...base, type: 'error', level: 'error', summary: `Task ${label} failed: ${clip(error, 160)}`, agent, errorKind: 'task', operation: `Task ${label}: ${clip(task.instruction, 80)}`, error, attempt: task.retryCount + 1 });
        return;
      }
      case 'CANCELLED': {
        const reason = task.error ?? 'Cancelled.';
        // Dropped before its agent took it up: the offer lapses. Once taken up, cancelling is not a rejection.
        if (known.delegation) this.settleDelegation(key, known, false, reason, agent, true);
        // Never started because what it needed failed: the hand-off from that agent never happened.
        for (const dep of task.dependsOn) {
          const from = this.tasks.get(`${snapshot.id}:${dep}`);
          if (!from || from.last.agent === agent || (from.last.status !== 'FAILED' && from.last.status !== 'CANCELLED')) continue;
          const id = this.nextHandshake();
          this.push({ ...base, type: 'handshake.initiated', level: 'running', handshakeId: id, from: from.last.agent, to: agent, kind: 'handoff', summary: `${PARTY_TITLES[from.last.agent]} → ${PARTY_TITLES[agent]}: results of task ${from.label} for task ${label}` });
          this.push({ ...base, type: 'handshake.rejected', level: 'error', handshakeId: id, from: from.last.agent, to: agent, kind: 'handoff', summary: `${PARTY_TITLES[from.last.agent]} → ${PARTY_TITLES[agent]}: hand-off failed — task ${from.label} ${from.last.status === 'FAILED' ? 'failed' : 'was cancelled'}`, reason: `Task ${from.label} ${from.last.status === 'FAILED' ? 'failed' : 'was cancelled'}: ${from.last.error ?? ''}`.trim() });
        }
        this.push({ ...base, type: 'task.cancelled', level: 'warning', summary: `Task ${label} cancelled: ${clip(reason, 160)}`, agent, reason, previousStatus: prev.status, newStatus: 'CANCELLED' });
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------------------- tools

  private toolStarted(callId: string, agent: MonitorAgentKey, taskKey: string | undefined, tool: string, args: Record<string, unknown>, at: number) {
    const key = `${taskKey ?? this.request?.id ?? '-'}|${agent}|${tool}`;
    const seen = this.attempts.get(key) ?? { count: 0, lastFailed: false };
    seen.count += 1;
    const retry = seen.count > 1 && seen.lastFailed;
    this.attempts.set(key, seen);
    this.open.set(callId, { agent, taskKey, tool, startedAt: at });
    this.push({
      type: 'tool.called',
      level: 'running',
      summary: `${PARTY_TITLES[agent]} → ${tool}()${retry ? ` — retry #${seen.count - 1}` : ''}`,
      requestId: this.request?.id,
      agent,
      taskKey,
      taskLabel: this.labelOf(taskKey),
      tool,
      callId,
      args: argsOf(args),
      request: clip(args),
      attempt: seen.count,
      trigger: retry ? 'The previous call failed' : undefined,
      at,
    });
  }

  private toolFinished(callId: string, open: OpenStep, result: { ok: boolean; message: string; data?: unknown; awaitUser?: boolean }, at: number, args?: Record<string, unknown>) {
    const tool = open.tool!;
    const key = `${open.taskKey ?? this.request?.id ?? '-'}|${open.agent}|${tool}`;
    const seen = this.attempts.get(key);
    if (seen) seen.lastFailed = !result.ok;
    const base = { requestId: this.request?.id, agent: open.agent, taskKey: open.taskKey, taskLabel: this.labelOf(open.taskKey), tool, callId, durationMs: at - open.startedAt, attempt: seen?.count ?? 1, at };
    if (tool === NOT_MY_TASK && open.taskKey) this.handBacks.set(open.taskKey, { reason: typeof args?.reason === 'string' ? args.reason : undefined, better: typeof args?.better_agent === 'string' ? args.better_agent : undefined });
    if (result.ok) {
      this.push({ ...base, type: 'tool.completed', level: result.awaitUser ? 'warning' : 'ok', summary: `${tool}(): ${clip(result.message, 180)}`, response: clip(result.data === undefined ? result.message : { message: result.message, data: result.data }), reason: result.awaitUser ? 'awaitUser' : undefined });
    } else {
      this.push({ ...base, type: 'tool.failed', level: 'error', summary: `${tool}() failed: ${clip(result.message, 180)}`, error: result.message, response: clip(result.message) });
      this.push({ ...base, type: 'error', level: 'error', summary: `${PARTY_TITLES[open.agent]} → ${tool}(): ${clip(result.message, 160)}`, errorKind: 'tool', operation: `${tool}()`, error: result.message });
    }
  }

  // ---------------------------------------------------------------------------------------- helpers

  private activate(agent: MonitorAgentKey) {
    if (!this.request || this.request.active.has(agent)) return;
    this.request.active.add(agent);
    this.push({ type: 'agent.started', level: 'running', summary: `${PARTY_TITLES[agent]} started`, requestId: this.request.id, agent, model: this.modelOf(agent) });
  }

  private labelOf(taskKey?: string) {
    return taskKey ? this.tasks.get(taskKey)?.label : undefined;
  }

  private nextHandshake() {
    return `${this.prefix}-h${++this.handshakeSeq}`;
  }

  private push(draft: Draft) {
    const seq = ++this.seq;
    this.batch.push({ ...draft, requestId: draft.requestId ?? this.request?.id, id: `${this.prefix}-e${seq}`, seq, at: draft.at ?? Date.now() });
  }

  private flush() {
    if (!this.batch.length) return;
    const events = this.batch;
    this.batch = [];
    this.sink(events);
  }
}

/** A tool's arguments, kept as given but never huge. */
function argsOf(args: Record<string, unknown>): Record<string, unknown> {
  const text = clip(args, 4000);
  try {
    return text.endsWith('…') ? { truncated: text } : JSON.parse(text);
  } catch {
    return { value: text };
  }
}

/** What a finished task handed on, in a line. */
export function describeResult(task: Pick<AgentTask, 'result'>): string {
  const r = task.result;
  if (!r) return '';
  return [r.patientName && `patient ${r.patientName}${r.patientId ? ` (${r.patientId})` : ''}`, r.reply, r.data !== undefined && `data: ${clip(r.data, 300)}`].filter(Boolean).join(' · ');
}

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
export type { HandshakeKind };

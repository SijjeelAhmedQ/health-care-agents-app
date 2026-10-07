/**
 * The Master Agent: the orchestrator of the multi-agent mode.
 *
 *   utterance ─► master (model: assign_tasks) ─► task graph ─► scheduler ─► specialists ─► tools ─► runtime
 *                                                    ▲                            │
 *                                                    └──────── results / status ──┘
 *
 * The master understands the request and gives it to the specialists as tasks (assign_tasks), with the
 * dependencies between them and how each touches the app. It never operates the records itself. The
 * scheduler then runs the tasks: every task whose dependencies are done is ready, and ready tasks run
 * TOGETHER — every read and context task, and one write at a time (a write usually ends in a confirmation,
 * and the provider answers one at a time, in the order said). The agents think at the same time (the slow
 * part: every model call); only the screen is shared, so each tool call that changes it takes its turn, and
 * a question or confirmation one task leaves for the provider stops the others from acting until they answer:
 *
 *   "select Tom Baker and comment 'hello world' on his normal Inbox records"
 *     Patients Agent  ──think──►  select_patient ─►  reply
 *     Inbox Agent     ──think──►        (waits)   ─► inbox_add_comment(patient: Tom Baker) ─► reply
 *
 * A task left waiting on the provider holds the graph — across turns — until they answer: only that task,
 * then what follows it, carries on. A failed task is retried once, handed to the agent it belongs to, or
 * reported; nothing loops.
 *
 * One runtime turn spans everything done for an utterance, as in the single assistant: a confirmation a
 * task prepares cannot be confirmed by any agent before the provider has heard it.
 */
import { z } from 'zod';
import type { AgentName, AgentTask, AIContext, ExecutionType, TaskGraphSnapshot, ToolResult } from '@/types/ai';
import type { ChatLLM } from '../providers/llm';
import { ModelUnavailableError } from '../providers/llm';
import { Agent, NOTHING_DONE, nextTurnId, planCovers, type AgentHooks, type AgentOutcome, type SafetyGate, type ToolGuard } from '../agent/agent';
import { buildUserMessage, type Exchange } from '../agent/prompt';
import { defineTool, type Tool } from '../agent/tool';
import { WAIT_TOOL } from '../agent/tools';
import { PageRegistry } from '@/registry/pageRegistry';
import { NavigationRegistry } from '@/registry/navigationRegistry';
import type { RecordKind } from '@/types/records';
import { detectOperation } from '../safety/operations';

/** "Select / choose / pick …" — misheard names and all ("select pateint"): a patient to select, not a reply. */
const SELECTS = /\b(select|choose|pick)\b/i;
/** …unless it is about something else the master or another agent selects. */
const SELECTS_ELSE = /\b(inbox|lab|labs|result|results|report|reports|referral|referrals|record|records|model|voice|language|microphone|mic|speech|theme|page|tab)\b/i;
import type { AppRuntime } from '../agent/runtime';
import { AGENT_NAMES, AGENT_TITLES, stricter, TaskGraph, type TaskRequest } from './taskGraph';
import { MASTER_TOOLS, NOT_MY_TASK_TOOL, specialistPrompt, specialistTools, toolExecution } from './specialists';
import { agentPrompt, agentRecordKinds, agentToolNames, recordOwner } from './skills';
import { normalizeReport, PlanningAgent, type RequirementDraft } from './planning';
import type { SafetyAgent } from '../safety/safetyAgent';
import { entitiesIn } from '../safety/operations';
import type { Missing } from '../safety/requirements';
import type { PlanningReport } from '../monitor/recorder';

export const ASSIGN_TOOL = 'assign_tasks';

/** A task, recall or appointment asked for is carried by a task whose instruction names it (or books, reminds…). */
const CARRIED = {
  task: /\b(tasks?|to ?-?do)\b/i,
  recall: /\b(recalls?|remind|reminder)\b/i,
  appointment: /\b(appointments?|visits?|follow ?-?ups?|book|schedule|check ?-?up)\b/i,
};

/** Words asking for a summary — the Summary Agent's, whatever it is of. */
const SUMMARY_WORDS = /\b(summar(y|ies|ise|ize|ised|ized|ising|izing)|overview|recap|brief me|at a glance|digest)\b/i;

/**
 * What a task of a record agent may do while another record agent's form or care plan waits on the provider:
 * add its records to it (they are confirmed together), and read. Anything else waits for the answer.
 */
const JOIN_TOOLS = new Set(['add_medications', 'add_diagnoses', 'add_tasks', 'add_recalls', 'add_appointments', 'add_care_plan']);

/** The open form's own tools: another agent's records waiting there are never filled, saved or confirmed by this one. */
const FORM_TOOLS = new Set(['fill_open_form', 'clear_form_field', 'save_open_form', 'confirm_pending_action', 'cancel_pending_action']);

/**
 * Tools that only move the screen. A specialist calls one when its task asks for it ("go to …", "scroll down",
 * "open the panel", "go back") — never on its own initiative after doing its task (a model that selected a
 * patient then opened a tab, scrolled, opened the side panel and went back). Its own tools open what they need.
 */
const SCREEN_TOOLS: Record<string, RegExp> = {
  open_page: /\b(go(ing)? to|goto|open|show|navigate|take me|switch to|page|tab|screen)\b/i,
  scroll_page: /\b(scroll|page (up|down)|top|bottom)\b/i,
  go_back: /\b(back|previous page|return)\b/i,
  patient_summary_panel: /\b(panel|side ?bar|summary panel)\b/i,
  dashboard_summary_panel: /\b(panel|dashboard summary)\b/i,
};

/** The master's instructions: its skill, src/agents/master-agent/SKILL.md. */
export const MASTER_PROMPT = agentPrompt('master');

export interface MultiAgentOptions {
  maxSteps: number;
  /**
   * Independent ready tasks run together (default on): the agents think at the same time and take turns
   * on the screen. Off: every task runs alone, in order. (The name is the setting's, from when only
   * read-only tasks ran together.)
   */
  parallelReads?: boolean;
  /** Retries of a failed task before it is reported (default 1). */
  maxRetries?: number;
  /** The Planning Agent gathers what each task needs, and asks for what is missing, before anything runs. */
  planning?: boolean;
}

/** Each agent's model: one for all, or one per agent (Configuration → Agents). */
export type AgentLlms = ChatLLM | ((agent: 'master' | 'planning' | AgentName) => ChatLLM);

export interface MultiAgentHooks extends AgentHooks {
  /** The task graph, every time it changes (null: no graph). */
  onGraph?(graph: TaskGraphSnapshot | null): void;
  /** The Planning Agent: started, asked the provider, approved the requirements, or dropped them. */
  onPlanning?(report: PlanningReport): void;
  /**
   * This utterance starts a new request (it answered nothing that was open): only its own words are what the
   * provider said for it — never those of the request before.
   */
  onFreshRequest?(): void;
}

/** What is missing, in a line per thing (for the monitor). */
const missingLines = (missing: Missing[]) =>
  missing.map((m) => (m.kind === 'select_patient' ? 'the patient to select' : m.kind === 'record_patient' ? 'the patient the records are for' : 'fields' in m ? `${m.kind}${m.name ? ` (${m.name})` : ''}: ${m.fields.join(', ')}` : m.kind));

/** One lock for the screen: a tool call that changes what is on it holds it until the call is done. */
class ScreenLock {
  private tail: Promise<void> = Promise.resolve();
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return ready;
  }
}

/** A tool result as the orchestrator keeps it for a task. */
type ToolRecord = { name: string; args: Record<string, unknown>; result: ToolResult };

/** How a task run ended, for the scheduler. */
type RunEnd = 'settled' | 'requeued' | 'handed_back' | 'deferred';

/** What is waiting on the provider now (a confirmation or a question), as one comparable line — or ''. */
const pendingOf = (ctx: AIContext) => [ctx.pendingConfirmation?.description, ctx.pendingQuestion?.question].filter(Boolean).join(' | ');

/** Tools whose work is choosing the selected patient: a task beside others reports a patient only through them. */
const PATIENT_TOOLS = new Set(['select_patient', 'clear_selected_patient', 'create_patient', 'inbox_select_item_patient']);

const isAbort = (e: unknown, signal?: AbortSignal) => signal?.aborted || (e as Error)?.name === 'AbortError';

/** A tool's data, small enough to hand on to the next task. */
function compactData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const trimmed = Array.isArray(data) ? data.slice(0, 8) : data;
  const text = JSON.stringify(trimmed);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : trimmed;
}

export class MultiAgentOrchestrator {
  readonly master: Agent;
  readonly specialists: Record<AgentName, Agent>;
  private tools: Tool[] = [];
  private graph: TaskGraph | null = null;
  private earlier: Exchange[] = [];
  private readonly screen = new ScreenLock();
  /** What assign_tasks received in the current planning call, and how often it was sent back. */
  private assigned: TaskRequest[] | null = null;
  private assignAttempts = 0;
  private planningFor = '';
  /** The Planning Agent (null: off), and a request held while it gathers what is missing. */
  readonly planning: PlanningAgent | null;
  private draft: { graph: TaskGraph; plan: RequirementDraft } | null = null;
  private safetyAgent: SafetyAgent | null = null;
  /** The Summary Agent's model: it only writes (the app gathers the data) — any model, MedGemma included. */
  private readonly summaryLlm: ChatLLM;
  /** Tasks that already tried to join the open care plan this request (and had to wait): never tried again. */
  private joinTried = new Set<string>();
  /** The tasks whose records went up for the yes, in the order they did (the last one's message holds them all). */
  private stagedBy: string[] = [];
  /** Tasks held because their records are another patient's than those waiting: they run after the yes, not before. */
  private otherPatient = new Set<string>();

  constructor(
    llms: AgentLlms,
    private readonly runtime: AppRuntime,
    private readonly buildContext: () => AIContext,
    private readonly options: MultiAgentOptions,
  ) {
    const llmFor = typeof llms === 'function' ? llms : () => llms;
    this.master = new Agent(llmFor('master'), runtime, buildContext, options.maxSteps, false, { name: 'master', systemPrompt: MASTER_PROMPT });
    this.specialists = Object.fromEntries(
      AGENT_NAMES.map((name) => [name, new Agent(llmFor(name), runtime, buildContext, options.maxSteps, false, { name, systemPrompt: specialistPrompt(name) })]),
    ) as Record<AgentName, Agent>;
    this.planning = options.planning ? new PlanningAgent(llmFor('planning'), runtime, buildContext, options.maxSteps, () => this.safetyAgent) : null;
    this.summaryLlm = llmFor('summary');
  }

  /** Give every agent its tools, from the full tool list (the same objects the single assistant uses). */
  setTools(all: Tool[]) {
    this.tools = all;
    const byName = new Map(all.map((t) => [t.name, t]));
    this.master.setTools([...MASTER_TOOLS.map((n) => byName.get(n)).filter((t): t is Tool => !!t), this.assignTool()]);
    for (const name of AGENT_NAMES) this.specialists[name].setTools(specialistTools(name, all));
  }

  get modelName() {
    return this.master.modelName;
  }

  /** The model each agent thinks with, e.g. { master: 'ollama:qwen3.5:4b', inbox: 'vllm:qwen3.5:9b', … }. */
  get agentModelNames(): Partial<Record<'master' | 'planning' | AgentName, string>> {
    return {
      master: this.master.modelName,
      ...(this.planning ? { planning: this.planning.modelName } : {}),
      ...Object.fromEntries(AGENT_NAMES.map((n) => [n, this.specialists[n].modelName])),
    } as Partial<Record<'master' | 'planning' | AgentName, string>>;
  }

  /** Every tool of the application (what the help sheet lists). */
  get toolList(): readonly Tool[] {
    return this.tools;
  }

  /** The Safety Agent between every agent of this mode and its tools — and over the Planning Agent's plan. */
  setSafety(gate: SafetyAgent | null) {
    this.safetyAgent = gate;
    const asGate: SafetyGate | null = gate;
    this.master.setSafety(asGate);
    for (const name of AGENT_NAMES) this.specialists[name].setSafety(asGate);
  }

  /** A request is still open: a task is waiting on the provider's answer, or the Planning Agent asked for what is missing. */
  get holdsRequest(): boolean {
    return !!this.graph?.waiting() || !!this.draft;
  }

  /**
   * The provider settled what waited outside the graph — saved or discarded it before a request of theirs that
   * was held runs: the waiting task (and those whose records joined it) finishes so, and nothing else of the
   * old request runs.
   */
  settleWaiting(saved: boolean, hooks: MultiAgentHooks = {}) {
    this.draft = null;
    const graph = this.graph;
    const waiting = graph?.waiting();
    if (!graph) return;
    if (waiting) {
      graph.move(waiting.id, saved ? 'COMPLETED' : 'CANCELLED', saved ? { result: { ...waiting.result, reply: 'Saved.' } } : { error: 'The provider discarded it.' });
      graph.settleJoined(waiting, saved ? 'COMPLETED' : 'CANCELLED', saved ? { result: { reply: 'Saved with the care plan.' } } : { error: 'The provider discarded the care plan.' });
    }
    if (!graph.done) graph.supersede('Replaced by a newer request.');
    this.publish(graph, hooks);
  }

  /** A newer request replaces what is open: the waiting task and anything the Planning Agent holds. */
  dropOpenRequest() {
    this.draft = null;
    if (this.graph && !this.graph.done) this.graph.supersede('Replaced by a newer request.');
  }

  /** The graph of the latest request (it stays after it finished, for the panels). */
  get activeGraph(): TaskGraphSnapshot | null {
    return this.graph?.snapshot() ?? null;
  }

  /**
   * The master opens only pages no specialist works on (Configuration). Any other page belongs to a task —
   * "go to patients and select …" — so nothing moves before the Planning Agent has what the task needs.
   */
  /** The master's own tools that ran this request (a refused open_page did nothing). */
  private masterCalls = 0;
  private readonly masterGuard: ToolGuard = (call) => {
    const refused = this.refuseOpen(call);
    if (!refused) this.masterCalls += 1;
    return refused;
  };

  private refuseOpen(call: Parameters<ToolGuard>[0]): ToolResult | null {
    if (call.name !== 'open_page') return null;
    const page = PageRegistry.get(String(call.arguments.page ?? ''));
    // On a page that stays on screen (Agent Monitoring) the app itself refuses — and says why.
    if (!page || page.module === 'configuration' || NavigationRegistry.isPinned()) return null;
    return {
      ok: false,
      message: `Not opened: the ${page.title} page belongs to a specialist. Give the whole request — the page and what the provider wants done there — to the specialist with assign_tasks; nothing is opened before what it needs is known.`,
    };
  }

  /** The master's prefix is the one every request starts with: prime its cache. */
  warmUp() {
    return this.master.warmUp();
  }

  resetConversation() {
    this.earlier = [];
    this.graph = null;
    this.draft = null;
  }

  contextBlock(said: string, ctx = this.buildContext(), alsoHeard?: string) {
    return buildUserMessage(said, ctx, this.earlier, alsoHeard);
  }

  // ------------------------------------------------------------------------------------------ entry

  /** Handle an utterance: the answer a waiting task needs, or a new request for the master. */
  async run(said: string, hooks: MultiAgentHooks = {}, signal?: AbortSignal, alsoHeard?: string): Promise<AgentOutcome> {
    this.runtime.beginTurn(nextTurnId(), [said, alsoHeard].filter(Boolean).join(' '));
    let outcome: AgentOutcome = { reply: '', speak: false, awaitingUser: false, deferred: false, fieldsModified: [] };
    try {
      // The Planning Agent asked for what was missing: this is (most likely) the answer.
      if (this.draft) {
        const answered = await this.answerRequirements(said, alsoHeard, hooks, signal);
        if (answered) {
          outcome = answered;
          return outcome;
        }
      }
      const graph = this.graph;
      const waiting = graph?.waiting();
      if (graph && waiting && this.notAnAnswer(waiting, said)) {
        // A request of its own ("create a task … and a recall …") while a task only asked something in words: the
        // master plans it — it is never handed to the agent that asked (which may not even have the tools).
        graph.supersede('The provider asked for something else instead.');
        this.publish(graph, hooks);
      } else if (graph && waiting) {
        // Fast path: the answer goes straight to the task that asked — no master call.
        const turn = new Map<string, AgentOutcome>();
        const end = await this.execute(graph, waiting, hooks, signal, turn, { resume: said, alsoHeard });
        if (end === 'deferred') return { ...turn.get(waiting.id)!, deferred: true };
        if (end !== 'handed_back') {
          outcome = await this.drive(graph, hooks, signal, turn);
          return outcome;
        }
        // Not an answer to it: the waiting request is dropped, and this one is planned afresh.
        graph.supersede('The provider asked for something else instead.');
        this.publish(graph, hooks);
      } else if (graph && !graph.done) {
        graph.supersede('Replaced by a newer request.');
      }
      hooks.onFreshRequest?.();
      outcome = await this.plan(said, alsoHeard, hooks, signal);
      return outcome;
    } catch (e) {
      if (isAbort(e, signal) && this.graph && !this.graph.done) {
        this.graph.supersede('Cancelled.');
        this.publish(this.graph, hooks);
      }
      throw e;
    } finally {
      this.runtime.endTurn();
      hooks.onProgress?.(null);
      if (outcome.reply && !outcome.deferred) {
        this.earlier.push({ said, reply: outcome.reply });
        this.earlier = this.earlier.slice(-Agent.EARLIER_EXCHANGES);
      }
    }
  }

  /**
   * The provider settled the waiting confirmation on screen (the dialog's Confirm / Cancel) instead of by
   * voice: the waiting task is done (or cancelled), and what was waiting behind it runs now. Null when
   * there was nothing to continue.
   */
  async continueAfterScreen(confirmed: boolean, hooks: MultiAgentHooks = {}, signal?: AbortSignal): Promise<AgentOutcome | null> {
    const graph = this.graph;
    const waiting = graph?.waiting();
    if (!graph || !waiting) return null;
    const ctx = this.buildContext();
    if (ctx.pendingConfirmation || ctx.pendingQuestion) return null; // something is still open on screen
    graph.move(waiting.id, confirmed ? 'COMPLETED' : 'CANCELLED', confirmed ? { result: { ...waiting.result, reply: 'Confirmed on screen.' } } : { error: 'The provider cancelled it on screen.' });
    graph.settleJoined(waiting, confirmed ? 'COMPLETED' : 'CANCELLED', confirmed ? { result: { reply: 'Saved with the care plan.' } } : { error: 'The provider cancelled the care plan on screen.' });
    this.publish(graph, hooks);
    if (!graph.ready().length && !graph.tasks.some((t) => t.status === 'PENDING')) return null;
    this.runtime.beginTurn(nextTurnId(), '');
    try {
      return await this.drive(graph, hooks, signal, new Map());
    } finally {
      this.runtime.endTurn();
      hooks.onProgress?.(null);
    }
  }

  // --------------------------------------------------------------------------------------- planning

  private assignTool(): Tool {
    const task = z.object({
      id: z.string().optional().describe('t1, t2, … — what depends_on refers to'),
      agent: z.enum(AGENT_NAMES as [AgentName, ...AgentName[]]),
      instruction: z.string().min(1).describe('The part of the request for this agent, with every detail that belongs to it, in the provider’s words'),
      depends_on: z.array(z.string()).optional().describe('Ids of earlier tasks whose result this one needs'),
      execution: z.enum(['READ_ONLY', 'CONTEXT', 'WRITE']).describe('READ_ONLY: only shows or reads; CONTEXT: changes what is selected or on screen; WRITE: adds, changes, deletes, books, cancels, files'),
    });
    return defineTool({
      name: ASSIGN_TOOL,
      description: 'Give the request to the specialist agents: one task per part of it, in the order said, with what each needs from the others and how it touches the app.',
      parameters: z.object({ tasks: z.array(task).min(1).max(10) }),
      // The list sent as JSON text, or one task on its own (small models): the list it means.
      normalize: (raw) => {
        const tasks = (normalizeReport(raw) as { tasks: unknown[] }).tasks;
        return { ...raw, tasks: tasks.length ? tasks : raw.tasks };
      },
      progress: ({ tasks }) => (tasks.length > 1 ? `Planning ${tasks.length} tasks…` : `Handing it to the ${AGENT_TITLES[tasks[0].agent]}…`),
      run: async ({ tasks }) => {
        const requests: TaskRequest[] = tasks.map((t) => ({ id: t.id, agent: t.agent, instruction: t.instruction, dependsOn: t.depends_on, executionType: t.execution as ExecutionType }));
        // A plan that lost part of what was said goes back once to be fixed — the same check as plan_steps.
        // A kind of record the provider asked for that no task carries ("Create a task for Luke King" assigned as
        // only "Select Luke King"): sent back once.
        const lostKinds = entitiesIn(this.planningFor).filter((k): k is 'task' | 'recall' | 'appointment' => k in CARRIED && !requests.some((r) => CARRIED[k as keyof typeof CARRIED].test(r.instruction)));
        if (lostKinds.length && this.assignAttempts++ === 0) {
          return { ok: false, message: `These tasks lost part of what the provider said: the ${lostKinds.join(', ')} they asked for. Call assign_tasks again with it in the task it belongs to.` };
        }
        if (requests.length > 1 && !planCovers(requests.map((r) => r.instruction), this.planningFor) && this.assignAttempts++ === 0) {
          return { ok: false, message: 'These tasks lost part of what the provider said. Call assign_tasks again with every detail (names, drugs, doses, dates, times) kept in the task it belongs to.' };
        }
        this.assigned = requests;
        return { ok: true, message: requests.length > 1 ? `${requests.length} tasks assigned.` : 'Assigned.', final: true };
      },
    });
  }

  private async plan(said: string, alsoHeard: string | undefined, hooks: MultiAgentHooks, signal?: AbortSignal): Promise<AgentOutcome> {
    this.joinTried = new Set();
    this.otherPatient = new Set();
    this.assigned = null;
    this.assignAttempts = 0;
    this.masterCalls = 0;
    this.planningFor = [said, alsoHeard].filter(Boolean).join(' ');
    const ctx = this.buildContext();
    const content = buildUserMessage(said, ctx, this.earlier, alsoHeard);
    const masterOutcome = await this.master.runMessage(content, this.tagged(hooks, 'master'), signal, { guard: this.masterGuard });
    let requests = this.assigned as TaskRequest[] | null;
    // "Go to patient and select patient" answered from CONTEXT ("Tom Baker is already selected") is a select
    // nobody asked for: it is the Patients Agent's task — and the Planning Agent asks which patient.
    if (!requests && this.masterCalls === 0 && this.planning && SELECTS.test(said) && !SELECTS_ELSE.test(said)) {
      requests = [{ id: 't1', agent: 'patients', instruction: said, executionType: 'CONTEXT' }];
    }
    if (!requests) {
      // The master answered, or did it itself (an unfinished sentence, the microphone, the configuration…).
      this.graph = null;
      hooks.onGraph?.(null);
      return masterOutcome;
    }
    const graph = new TaskGraph(said, requests);
    this.graph = graph;
    this.skipNeedlessSelect(graph, [said, alsoHeard].filter(Boolean).join(' '));
    this.publish(graph, hooks);
    // Requirement gathering before anything runs: what each task needs, and the question for what is missing.
    if (this.planning && PlanningAgent.applies(graph)) {
      hooks.onPlanning?.({ type: 'started' });
      const plan = await this.planning.plan(graph, said, alsoHeard, this.tagged(hooks, 'planning'), signal);
      if (plan.question) return this.holdForAnswer(graph, plan, hooks, masterOutcome.fieldsModified);
      this.approve(graph, plan, hooks);
    }
    const outcome = await this.drive(graph, hooks, signal, new Map(), alsoHeard);
    outcome.fieldsModified.unshift(...masterOutcome.fieldsModified);
    return outcome;
  }

  /** Something is missing: the request is held and the provider asked — one fixed question, never a suggestion. */
  private holdForAnswer(graph: TaskGraph, plan: RequirementDraft, hooks: MultiAgentHooks, fieldsModified: AgentOutcome['fieldsModified'] = []): AgentOutcome {
    this.draft = { graph, plan };
    hooks.onPlanning?.({ type: 'question', question: plan.question ?? '', missing: missingLines(plan.missing), findings: plan.findings });
    this.publish(graph, hooks);
    return { reply: plan.question ?? '', speak: true, awaitingUser: true, deferred: false, fieldsModified };
  }

  /** Everything is there: each task carries its approved requirements to its specialist. */
  private approve(graph: TaskGraph, plan: RequirementDraft, hooks: MultiAgentHooks) {
    for (const task of graph.tasks) if (plan.approved[task.id]) task.requirements = plan.approved[task.id];
    hooks.onPlanning?.({ type: 'ready', approved: Object.values(plan.approved).flat(), findings: plan.findings });
    this.publish(graph, hooks);
  }

  /**
   * The provider's answer to what the Planning Agent asked: added to what was gathered, then asked again or
   * run. Null when it was not an answer — the held request is dropped and this one planned afresh.
   */
  private async answerRequirements(said: string, alsoHeard: string | undefined, hooks: MultiAgentHooks, signal?: AbortSignal): Promise<AgentOutcome | null> {
    const { graph, plan } = this.draft!;
    hooks.onPlanning?.({ type: 'started' });
    const next = await this.planning!.answer(plan, graph, said, alsoHeard, this.tagged(hooks, 'planning'), signal);
    if (next === 'not_an_answer') {
      this.draft = null;
      graph.supersede('The provider asked for something else instead.');
      hooks.onPlanning?.({ type: 'dropped' });
      this.publish(graph, hooks);
      return null;
    }
    if (next.question) return this.holdForAnswer(graph, next, hooks);
    this.draft = null;
    this.approve(graph, next, hooks);
    return this.drive(graph, hooks, signal, new Map(), alsoHeard);
  }

  // -------------------------------------------------------------------------------------- scheduling

  /**
   * Run the graph as far as it goes now: until everything is done, or a task waits on the provider.
   * Ready tasks run together (each tool call that changes the screen in turn); with parallel tasks off,
   * one at a time, in order.
   */
  private async drive(graph: TaskGraph, hooks: MultiAgentHooks, signal: AbortSignal | undefined, turn: Map<string, AgentOutcome>, alsoHeard?: string): Promise<AgentOutcome> {
    const skipped: AgentTask[] = [];
    for (let guard = 0; guard < graph.tasks.length * 4 + 4; guard++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      skipped.push(...graph.cancelUnreachable());
      const waiting = graph.waiting();
      if (waiting) {
        // A record agent's form or care plan waits for the provider's yes: the other record agents' records join
        // it — one care plan, one confirmation — all of them thinking at once. Anything else waits for the answer.
        const joining = this.joinable(graph, waiting);
        // A summary changes nothing and never touches what waits (nor moves the page while it does): it is
        // written now, beside the care plan — not held until the provider's yes.
        const summaries = graph.ready().filter((t) => t.agent === 'summary');
        if (!joining.length && !summaries.length) break;
        for (const t of joining) this.joinTried.add(t.id);
        this.stagedBy = [];
        const parallel = this.options.parallelReads !== false && joining.length + summaries.length > 1;
        await Promise.all([
          ...joining.map((t) => this.execute(graph, t, hooks, signal, turn, { alsoHeard, join: waiting, parallel })),
          ...summaries.map((t) => this.execute(graph, t, hooks, signal, turn, { alsoHeard })),
        ]);
        if (joining.length) this.joinGroup(graph, [waiting, ...joining]);
        continue;
      }
      const ready = graph.ready();
      if (!ready.length) break;
      // Every ready read and context task, and the first ready WRITE: a write usually ends in a confirmation,
      // and the provider answers one at a time — the next write starts once this one is settled, in the order
      // said, and nobody's thinking is thrown away. Records several agents add for the request (a medication,
      // a diagnosis, a task …) are the exception: they meet in ONE care plan with ONE confirmation, so those
      // agents all think at once — each adds its records to the screen in turn.
      const adders = ready.filter((t) => t.executionType === 'WRITE' && this.addsRecords(t));
      const firstWrite = ready.find((t) => t.executionType === 'WRITE');
      const writes = adders.length > 1 && firstWrite && adders.includes(firstWrite) ? adders : firstWrite ? [firstWrite] : [];
      const batch = ready.filter((t) => t.executionType !== 'WRITE' || writes.includes(t));
      const together = this.options.parallelReads !== false && batch.length > 1;
      const group = writes.length > 1 ? new Set(writes.map((t) => t.id)) : null;
      if (together) {
        // What already waited on the provider before these started is not theirs to stop for.
        const pendingAtStart = pendingOf(this.buildContext());
        this.stagedBy = [];
        await Promise.all(batch.map((t) => this.execute(graph, t, hooks, signal, turn, { parallel: true, alsoHeard, pendingAtStart, group: !!group?.has(t.id) })));
        if (group) {
          // A member that had to wait (it reached for something else first) joins the care plan in a moment.
          for (const id of group) if (graph.get(id).status !== 'PENDING' || this.otherPatient.has(id)) this.joinTried.add(id);
          this.joinGroup(graph, batch.filter((t) => group.has(t.id)));
        }
      } else await this.execute(graph, batch[0], hooks, signal, turn, { alsoHeard });
    }
    this.publish(graph, hooks);
    return this.compose(graph, turn, skipped);
  }

  /** Run one task with its specialist, and decide from how it ended where the task goes next. */
  private async execute(
    graph: TaskGraph,
    task: AgentTask,
    hooks: MultiAgentHooks,
    signal: AbortSignal | undefined,
    turn: Map<string, AgentOutcome>,
    mode: { parallel?: boolean; resume?: string; alsoHeard?: string; pendingAtStart?: string; join?: AgentTask; group?: boolean },
  ): Promise<RunEnd> {
    // A summary or overview given to another agent ("give me an overview of Chloe Bell" to the Patients Agent):
    // the Summary Agent's — unless it is a panel to open, or an action.
    if (task.agent !== 'summary' && !mode.resume && SUMMARY_WORDS.test(task.instruction) && !/\b(panel|side ?bar)\b/i.test(task.instruction) && !this.actionOwner({ ...task, instruction: task.instruction.replace(SUMMARY_WORDS, '') })) {
      if (task.status === 'PENDING') graph.move(task.id, 'ASSIGNED');
      graph.move(task.id, 'IN_PROGRESS', { model: this.specialists[task.agent].modelName });
      graph.move(task.id, 'PENDING', { agent: 'summary', triedAgents: [...(task.triedAgents ?? []), task.agent], error: `Reassigned: every summary is the ${AGENT_TITLES.summary}'s.` });
      this.publish(graph, hooks);
      return 'requeued';
    }
    // A summary task that is really an action ("add metformin" given to the Summary Agent): to the agent that owns it.
    if (task.agent === 'summary' && !mode.resume) {
      const owner = this.actionOwner(task);
      if (owner) {
        if (task.status === 'PENDING') graph.move(task.id, 'ASSIGNED');
        graph.move(task.id, 'IN_PROGRESS', { model: this.specialists.summary.modelName });
        graph.move(task.id, 'PENDING', { agent: owner, triedAgents: [...(task.triedAgents ?? []), 'summary'], error: `Reassigned: the ${AGENT_TITLES.summary} only writes summaries.` });
        this.publish(graph, hooks);
        return 'requeued';
      }
    }
    if (task.status === 'PENDING') graph.move(task.id, 'ASSIGNED');
    graph.move(task.id, 'IN_PROGRESS', { model: task.agent === 'summary' ? this.summaryLlm.name : this.specialists[task.agent].modelName });
    this.publish(graph, hooks);
    if (task.agent === 'summary') return this.summarize(graph, task, hooks, signal, turn, mode.resume);

    const records: ToolRecord[] = [];
    /** Beside other tasks: this task stopped before acting, because another one is waiting on the provider. */
    let deferred = false;
    /** This task itself left the question or confirmation that is waiting. */
    let asked = false;
    let release: (() => void) | null = null;
    const guard: ToolGuard = async (call) => {
      const meta = toolExecution(call.name);
      // The task does more than the master said: from now on it is scheduled as what it really is.
      if (stricter(meta.type, task.executionType) !== task.executionType) {
        task.declaredType ??= task.executionType;
        task.executionType = stricter(meta.type, task.executionType);
      }
      const asks = SCREEN_TOOLS[call.name];
      if (asks && !asks.test(`${task.instruction} ${mode.resume ?? ''}`)) {
        return { ok: false, message: 'Your task does not ask to move the screen. Do nothing more and reply in one short sentence with what your task did.' };
      }
      if (meta.pure) return null;
      // Beside other tasks, a call that changes the screen waits for its turn (and gives it back when done).
      if (mode.parallel) release = await this.screen.acquire();
      const joins = JOIN_TOOLS.has(call.name) && this.samePatient(call.arguments);
      // Another agent's form (or care plan) waits for the provider's yes, and this agent — seeing it in CONTEXT —
      // reaches for the form itself: never. Its own add tool puts its records into that care plan; it is told so
      // and carries on now (it is not held until the yes — that left only one agent's form on screen).
      if ((mode.join || mode.group) && !asked && FORM_TOOLS.has(call.name) && this.runtime.recordsWaiting?.()) {
        const add = agentToolNames(task.agent).find((n) => JOIN_TOOLS.has(n)) ?? 'your add tool';
        return { ok: false, message: `That open form is another agent's, waiting for the provider's yes — never fill, save or confirm it. Add your own records with ${add} (the patient as said): they join it, in one care plan.` };
      }
      if (mode.join) {
        // Joining another agent's care plan: only adding records — for the same patient — and before anything
        // else this task does. The rest waits for the provider's answer.
        if (deferred || !joins) {
          deferred = true;
          return { ok: false, message: 'Another agent\'s records are waiting on the provider\'s confirmation, and this is not an addition to them. Do nothing more now and reply in a few words: this task carries on after they answer.' };
        }
        return null;
      }
      if (!mode.parallel) return null;
      const pending = pendingOf(this.buildContext());
      // One of the agents adding records together put its records up for the yes first: the others' records join
      // that care plan (in turn, on the screen) — anything else they would do waits for the answer.
      if (mode.group && !deferred && pending && pending !== mode.pendingAtStart && !asked && joins && this.runtime.recordsWaiting?.()) return null;
      if (mode.group && JOIN_TOOLS.has(call.name) && !joins) this.otherPatient.add(task.id);
      if (deferred || (!asked && pending && pending !== mode.pendingAtStart)) {
        deferred = true;
        return { ok: false, message: 'Another task has just asked the provider something (a question or a confirmation is on screen). Do nothing more now and reply in a few words: this task carries on after they answer.' };
      }
      return null;
    };
    const tagged: MultiAgentHooks = {
      ...this.tagged(hooks, task.agent, task.id),
      onStep: (step) => {
        hooks.onStep?.({ ...step, agent: task.agent, taskId: task.id });
        if (step.type !== 'tool' || !step.finishedAt) return;
        // The call is done: the screen is the next task's turn.
        (release as (() => void) | null)?.();
        release = null;
        if (step.result) records.push({ name: step.call.name, args: step.call.arguments, result: step.result });
        if (step.result?.awaitUser) asked = true;
        if (step.result?.ok && step.result.awaitUser && JOIN_TOOLS.has(step.call.name)) this.stagedBy.push(task.id);
      },
    };

    const before = this.buildContext().currentPatientId;
    let outcome: AgentOutcome = { reply: '', speak: false, awaitingUser: false, deferred: false, fieldsModified: [] };
    let error: string | null = null;
    try {
      outcome = await this.specialists[task.agent].runMessage(this.taskMessage(graph, task, mode.resume, mode.alsoHeard), tagged, signal, { inPlan: !mode.resume, guard });
    } catch (e) {
      if (isAbort(e, signal) || e instanceof ModelUnavailableError) throw e;
      error = (e as Error).message;
    } finally {
      (release as (() => void) | null)?.();
    }
    turn.set(task.id, outcome);

    const done = records.filter((r) => r.name !== NOT_MY_TASK_TOOL && r.name !== WAIT_TOOL && r.result.ok);
    const handedBack = records.find((r) => r.name === NOT_MY_TASK_TOOL);
    const cancelled = records.some((r) => r.name === 'cancel_pending_action' && r.result.ok);
    // A question at the end of the reply leaves the task waiting only when it did nothing yet (it is asking what
    // to do): "Luke King is selected. How would you like to proceed?" is a finished select, not a question to hold.
    const asks = !outcome.awaitingUser && !done.length && /\?\s*$/.test(outcome.reply.trim());

    if (mode.resume && outcome.deferred) {
      graph.move(task.id, 'WAITING_FOR_USER', { waitingFor: task.waitingFor ?? outcome.reply }); // an unfinished answer: keep waiting
      return 'deferred';
    }
    // Given the provider's words as its answer, the waiting agent did nothing with them — no tool at all, only
    // words (asking again): it was no answer to it. The master plans them afresh; the agent never holds the
    // conversation in a loop of the same question.
    // (Only when nothing of it waits on screen: asked about the form or confirmation it prepared, words are an answer.)
    const onScreen = this.buildContext();
    if (mode.resume && !records.length && !outcome.awaitingUser && error === null && !onScreen.pendingConfirmation && !onScreen.pendingQuestion) {
      graph.move(task.id, 'WAITING_FOR_USER', { waitingFor: task.waitingFor });
      turn.delete(task.id);
      return 'handed_back';
    }
    if (deferred && done.every((r) => toolExecution(r.name).type === 'READ_ONLY')) {
      // It had not acted yet: back in the queue (not a retry) — it runs once the provider has answered.
      graph.move(task.id, 'PENDING');
      turn.delete(task.id);
      return 'requeued';
    }
    if (handedBack && !done.length) {
      if (mode.resume) {
        graph.move(task.id, 'WAITING_FOR_USER', { waitingFor: task.waitingFor });
        return 'handed_back';
      }
      const better = handedBack.args.better_agent as AgentName | undefined;
      const tried = [...(task.triedAgents ?? []), task.agent];
      if (better && !tried.includes(better)) {
        graph.move(task.id, 'PENDING', { agent: better, triedAgents: tried, error: `Reassigned from the ${AGENT_TITLES[task.agent]}.` });
        turn.delete(task.id);
        return 'requeued';
      }
      graph.move(task.id, 'FAILED', { triedAgents: tried, error: `The ${AGENT_TITLES[task.agent]} could not do this${handedBack.args.reason ? `: ${String(handedBack.args.reason)}` : '.'}` });
      return 'settled';
    }
    const result = { ...this.resultOf(done, before, task.agent, mode.parallel), reply: outcome.reply || undefined };
    if (outcome.awaitingUser || asks) {
      graph.move(task.id, 'WAITING_FOR_USER', { waitingFor: outcome.reply, result });
      return 'settled';
    }
    if (cancelled) {
      graph.move(task.id, 'CANCELLED', { error: 'The provider cancelled it.', result });
      graph.settleJoined(task, 'CANCELLED', { error: 'The provider cancelled the care plan.' });
      return 'settled';
    }
    const failed = error !== null || (!done.length && (records.length > 0 || outcome.reply === NOTHING_DONE));
    // The provider said yes, and the save was refused (a time already booked, a value still missing): what was
    // prepared is still on screen, waiting — so is the task (and every task whose records are in it). They put
    // it right and say yes again; nothing is cancelled behind their back.
    if (failed && mode.resume && error === null && this.buildContext().pendingConfirmation) {
      const why = [...records].reverse().find((r) => !r.result.ok)?.result.message?.replace(/^confirm_pending_action failed:\s*/, '') ?? outcome.reply;
      graph.move(task.id, 'WAITING_FOR_USER', { waitingFor: `Not saved yet: ${why} Change it on screen (or tell me), then confirm — or cancel.`, result });
      return 'settled';
    }
    if (failed) {
      const why = error ?? [...records].reverse().find((r) => !r.result.ok)?.result.message ?? outcome.reply;
      if (!mode.resume && task.retryCount < (this.options.maxRetries ?? 1)) {
        graph.move(task.id, 'FAILED', { error: why });
        graph.move(task.id, 'PENDING', { retryCount: task.retryCount + 1 });
        turn.delete(task.id);
        return 'requeued';
      }
      graph.move(task.id, 'FAILED', { error: why, result });
      graph.settleJoined(task, 'CANCELLED', { error: `Not saved: ${why}` });
      return 'settled';
    }
    graph.move(task.id, 'COMPLETED', { result, error: undefined });
    graph.settleJoined(task, 'COMPLETED', { result: { reply: 'Saved with the care plan.' }, error: undefined });
    return 'settled';
  }

  /**
   * The Summary Agent's task: no tools and no model choosing any — the app reads what is asked about from the
   * task, gathers the data, and the agent's model writes the text (MedGemma can). It opens in the Summary panel;
   * the reply is one line.
   */
  private async summarize(graph: TaskGraph, task: AgentTask, hooks: MultiAgentHooks, signal: AbortSignal | undefined, turn: Map<string, AgentOutcome>, resume?: string): Promise<RunEnd> {
    const tagged = this.tagged(hooks, 'summary', task.id);
    const stepId = `summary-${task.id}-${Date.now().toString(36)}`;
    const call = { name: 'summarize', arguments: { what: resume ?? task.instruction } };
    const started = Date.now();
    tagged.onProgress?.('Writing the summary…');
    tagged.onStep?.({ id: stepId, type: 'tool', call, startedAt: started });
    const modelStep = { id: `${stepId}-model`, type: 'model' as const, startedAt: started };
    tagged.onStep?.(modelStep);
    let summary: Awaited<ReturnType<AppRuntime['summaryOf']>>;
    try {
      summary = await this.runtime.summaryOf(resume ?? task.instruction, { llm: this.summaryLlm, signal });
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      summary = { result: { ok: false, message: (e as Error).message } };
    }
    const written = summary.outcome;
    tagged.onStep?.({ ...modelStep, finishedAt: Date.now(), content: written?.model?.answer ?? written?.text ?? '', toolCalls: [], error: written?.source === 'rules' && written.model?.note && !written.empty ? written.model.note : undefined });
    tagged.onStep?.({ id: stepId, type: 'tool', call, startedAt: started, finishedAt: Date.now(), result: summary.result });
    const outcome: AgentOutcome = { reply: summary.result.message, speak: true, awaitingUser: false, deferred: false, fieldsModified: [] };
    turn.set(task.id, outcome);
    if (!summary.result.ok) {
      graph.move(task.id, 'FAILED', { error: summary.result.message });
      return 'settled';
    }
    graph.move(task.id, 'COMPLETED', { result: { reply: outcome.reply, data: compactData(summary.result.data) }, error: undefined });
    return 'settled';
  }

  /**
   * Record agents that added together: of those now waiting on the provider, the one that put records up last
   * holds the care plan's one confirmation (its message names them all) — the others joined it.
   */
  private joinGroup(graph: TaskGraph, tasks: AgentTask[]) {
    const waiting = tasks.filter((t) => t.status === 'WAITING_FOR_USER' && (this.stagedBy.includes(t.id) || t === graph.waiting()));
    if (waiting.length < 2) return;
    const lead = [...waiting].sort((a, b) => this.stagedBy.lastIndexOf(a.id) - this.stagedBy.lastIndexOf(b.id)).at(-1)!;
    for (const t of waiting) if (t !== lead && t.joinedInto !== lead.id) graph.join(t, lead);
  }

  /**
   * What the provider said is plainly no answer to the task waiting: nothing of it waits on screen (no form, no
   * confirmation, no field asked for) — the task only asked in words — and they ask for an operation of their own.
   */
  private notAnAnswer(waiting: AgentTask, said: string): boolean {
    const ctx = this.buildContext();
    if (ctx.pendingConfirmation || ctx.pendingQuestion) return false;
    const { operation, kind } = detectOperation(said);
    if (operation === 'other') return SUMMARY_WORDS.test(said) && waiting.agent !== 'summary';
    if (kind && kind !== 'patient') return recordOwner(kind as RecordKind) !== waiting.agent;
    return operation !== 'view';
  }

  /**
   * A select the provider never asked for: a patient is selected, and they neither said "select" nor named
   * anyone — the master added "Select patient Luke King" from CONTEXT ("add medication and diagnoses" with Luke
   * King on screen). It is done already: marked so, never planned (that once asked "Which patient would you like
   * to select?" while Luke King was selected). A select of the patient already selected is done already too.
   */
  private skipNeedlessSelect(graph: TaskGraph, said: string) {
    const ctx = this.buildContext();
    if (!ctx.currentPatientId) return;
    const named = this.safetyAgent?.namedPatients() ?? [];
    const asked = SELECTS.test(said) || /\b(sle+c?t|selct|slect)\b/i.test(said);
    // The provider asked for a select (whoever it names), or named someone else: theirs — it runs.
    if (asked || named.some((p) => p.id !== ctx.currentPatientId)) return;
    for (const t of graph.tasks) {
      if (t.agent !== 'patients' || t.status !== 'PENDING' || !/\b(select|choose|pick|open|find)\b/i.test(t.instruction)) continue;
      if (detectOperation(t.instruction).operation !== 'select_patient' && !/\bselect\b/i.test(t.instruction)) continue;
      graph.move(t.id, 'ASSIGNED');
      graph.move(t.id, 'IN_PROGRESS');
      graph.move(t.id, 'COMPLETED', { result: { patientId: ctx.currentPatientId, patientName: ctx.currentPatientName ?? undefined, reply: undefined }, error: undefined });
    }
  }

  /** A record agent's task that adds records (not one that changes, deletes or shows them). */
  private addsRecords(t: AgentTask): boolean {
    if (!agentRecordKinds(t.agent).length) return false;
    return t.requirements?.length ? !t.requirements.some((r) => r.startsWith('operation:')) : detectOperation(t.instruction).operation === 'add';
  }

  /** A Summary Agent task that asks for an action on records (not a summary): the agent that owns them. */
  private actionOwner(task: AgentTask): AgentName | undefined {
    if (SUMMARY_WORDS.test(task.instruction)) return undefined;
    const { operation, kind } = detectOperation(task.instruction);
    if (operation === 'other' || operation === 'view') return undefined;
    if (kind && kind !== 'patient') return recordOwner(kind as RecordKind);
    return operation === 'select_patient' || operation === 'create_patient' || kind === 'patient' ? 'patients' : undefined;
  }

  /**
   * The ready task that may add its records to the form or care plan waiting on the provider — another record
   * agent's records, added (not changed or deleted), while nothing but that form's question or confirmation is
   * open. Null when there is none: the graph waits for the answer.
   */
  private joinable(graph: TaskGraph, waiting: AgentTask): AgentTask[] {
    if (!agentRecordKinds(waiting.agent).length || !this.runtime.recordsWaiting?.()) return [];
    return graph.ready().filter((t) => !this.joinTried.has(t.id) && t.executionType === 'WRITE' && this.addsRecords(t));
  }

  /** The records a joining call adds are for the patient the open care plan is for (or name nobody). */
  private samePatient(args: Record<string, unknown>): boolean {
    if (Array.isArray(args.for_patients) && args.for_patients.length) return false;
    const current = this.buildContext().currentPatientName?.toLowerCase();
    const waitingFor = new Set((this.runtime.waitingPatients?.() ?? []).map((n) => n.toLowerCase()));
    const named = [args.patient, ...Object.values(args).flatMap((v) => (Array.isArray(v) ? v.map((item) => (item as Record<string, unknown> | null)?.patient) : []))]
      .filter((v): v is string => typeof v === 'string' && !!v.trim());
    return named.every((raw) => {
      const found = this.runtime.findPatient(raw).name?.toLowerCase();
      return !!found && (found === current || waitingFor.has(found));
    });
  }

  /**
   * What a task hands on: the selected patient, and the data of its last successful tool call. Beside other
   * tasks, the selected patient may have been changed by another one: it is this task's only when it chose it.
   */
  private resultOf(done: ToolRecord[], patientBefore: string | null, agent: AgentName, parallel = false) {
    const ctx = this.buildContext();
    const withData = [...done].reverse().find((r) => r.result.data !== undefined);
    const chose = !parallel || done.some((r) => PATIENT_TOOLS.has(r.name));
    const patientChanged = ctx.currentPatientId && chose && (ctx.currentPatientId !== patientBefore || agent === 'patients');
    return {
      patientId: patientChanged ? (ctx.currentPatientId ?? undefined) : undefined,
      patientName: patientChanged ? (ctx.currentPatientName ?? undefined) : undefined,
      data: compactData(withData?.result.data),
    };
  }

  /** The message a specialist gets for a task: CONTEXT, the whole request, what it depends on, its task. */
  private taskMessage(graph: TaskGraph, task: AgentTask, resume?: string, alsoHeard?: string): string {
    const ctx = this.buildContext();
    const fast = graph.route === 'fast';
    const sections: string[] = [];
    if (!fast || resume) sections.push(`REQUEST: ${graph.request}`);
    const results = graph.resultsFor(task);
    if (results.length) sections.push(`RESULTS FROM EARLIER TASKS\n${results.join('\n')}`);
    if (task.requirements?.length) sections.push(`APPROVED REQUIREMENTS (gathered by the Planning Agent, checked by the Safety Agent — use these values; a value the provider SAID that is not listed still comes from their words. Never add one they did not say: the app asks for it)\n${task.requirements.map((r) => `- ${r}`).join('\n')}`);
    if (task.retryCount > 0 && task.error && !resume) sections.push(`PREVIOUS ATTEMPT FAILED: ${task.error} — do it differently, or ask the provider.`);
    if (resume) sections.push(`YOUR TASK (${task.id}): ${task.instruction}\nIt is waiting for the provider: "${task.waitingFor ?? ''}" — SAID is what they said next.`);
    // One task: the specialist gets the provider's own words, not the master's rewording of them.
    const said = resume ?? (fast ? graph.request : task.instruction);
    const index = graph.tasks.indexOf(task);
    const step = !fast && !resume ? { index: index + 1, total: graph.tasks.length } : undefined;
    return buildUserMessage(said, ctx, this.earlier, fast || resume ? alsoHeard : undefined, step, sections);
  }

  // ------------------------------------------------------------------------------------------ result

  /**
   * The reply for the provider, from what the tasks did this turn: the one task's own words (fast path),
   * or each task's result in order, with what failed or was skipped — and the open question last.
   */
  private compose(graph: TaskGraph, turn: Map<string, AgentOutcome>, skipped: AgentTask[]): AgentOutcome {
    const outcome: AgentOutcome = { reply: '', speak: false, awaitingUser: false, deferred: false, fieldsModified: [] };
    for (const o of turn.values()) {
      outcome.fieldsModified.push(...o.fieldsModified);
      if (o.speak) outcome.speak = true;
    }
    const waiting = graph.waiting();
    const lines: string[] = [];
    for (const task of graph.tasks) {
      const o = turn.get(task.id);
      if (task === waiting) continue;
      if (task.status === 'COMPLETED' && o?.reply) lines.push(o.reply);
      else if (task.status === 'FAILED' && o) {
        lines.push(graph.route === 'fast' ? o.reply || task.error || NOTHING_DONE : `Could not ${lowerFirst(task.instruction)}: ${task.error ?? 'it failed'}`);
        outcome.speak = true;
      } else if (task.status === 'CANCELLED' && (o || skipped.includes(task))) {
        lines.push(o ? (o.reply || 'Cancelled.') : `Skipped: ${lowerFirst(task.instruction)} (${task.error ?? 'not needed any more'}).`);
        if (!o) outcome.speak = true;
      }
    }
    const said = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
    if (waiting) {
      outcome.awaitingUser = true;
      outcome.speak = true;
      said.push(waiting.waitingFor ?? turn.get(waiting.id)?.reply ?? '');
    }
    outcome.reply = said.filter(Boolean).join(' ') || (turn.size ? 'Done.' : NOTHING_DONE);
    return outcome;
  }

  // ------------------------------------------------------------------------------------------ helpers

  /** Steps tagged with the agent (and task) they belong to, for the trace and the debug panel. */
  private tagged(hooks: MultiAgentHooks, agent: 'master' | 'planning' | AgentName, taskId?: string): MultiAgentHooks {
    return {
      onStep: (step) => hooks.onStep?.({ ...step, agent, taskId }),
      onProgress: (text) => hooks.onProgress?.(text),
    };
  }

  private publish(graph: TaskGraph, hooks: MultiAgentHooks) {
    hooks.onGraph?.(graph.snapshot());
    hooks.onPlan?.(graph.planSteps());
  }
}

const lowerFirst = (s: string) => s.replace(/^./, (c) => c.toLowerCase()).replace(/[.!]\s*$/, '');

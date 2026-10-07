/**
 * The agent loop: the model decides, the tools act.
 *
 *   utterance + CONTEXT ──► model ──► tool calls ──► tools run ──► results ──► model ──► … ──► reply
 *
 * Each model turn may call several tools; their results go back to the model,
 * which calls more tools, corrects a failed call, or answers. The loop ends
 * when the model replies without calling a tool, when a tool leaves the app
 * waiting for the user (a question or a confirmation), or after `maxSteps`
 * model calls.
 *
 * A long request ("go to patients, select James, add metformin … a task … a recall … an appointment")
 * is first split into its actions (plan_steps), then carried out one step at a time through the same
 * loop — a small model doing it all in one go tends to stop part-way.
 */
import type { AgentStep, AIContext, ExtractionResult, FieldValues, PlanStep, SafetyFinding, ToolCall, ToolResult } from '@/types/ai';
import { RECORD_KINDS } from '@/types/records';
import { FieldRegistry, type FieldScalar } from '@/registry/fieldRegistry';
import type { ChatLLM, ChatMessage, ToolSchema } from '../providers/llm';
import { parseArgs, toToolSchema, type Tool } from './tool';
import { buildExtractionMessage, buildPlanMessage, buildSessionMessage, buildUserMessage, SESSION_ACK, SYSTEM_PROMPT, type Exchange } from './prompt';
import { NOTE_FINDINGS_TOOL, PLAN_TOOL, recordPlural, WAIT_TOOL } from './tools';
import type { AppRuntime } from './runtime';

export interface AgentOutcome {
  reply: string;
  /** The reply is worth reading aloud (an answer, a question, a confirmation). */
  speak: boolean;
  /** The app is waiting on the user (question or confirmation). */
  awaitingUser: boolean;
  /** The model judged the utterance unfinished: nothing was done, it is held for the next one. */
  deferred: boolean;
  fieldsModified: NonNullable<ToolResult['fieldsModified']>;
}

export interface AgentHooks {
  onStep?(step: AgentStep): void;
  onProgress?(text: string | null): void;
  /** A long request is being carried out in steps: each step and how far it got. */
  onPlan?(steps: PlanStep[]): void;
}

/**
 * Who an agent is: its name and its system prompt. The single assistant is the default; the specialists
 * and the master of the multi-agent mode (agents/) are the same class with their own profile and tools.
 */
export interface AgentProfile {
  name: string;
  systemPrompt: string;
}

export const ASSISTANT_PROFILE: AgentProfile = { name: 'assistant', systemPrompt: SYSTEM_PROMPT };

/**
 * A check made before a tool runs: a result refuses the call (it goes back to the model as that tool's
 * result), null lets it run. The multi-agent scheduler uses it to keep a read-only task from writing.
 */
export type ToolGuard = (call: ToolCall, tool: Tool) => ToolResult | null | Promise<ToolResult | null>;

/**
 * The Safety Agent as the agent loop sees it (services/ai/safety): `check` before a tool runs — keep, correct,
 * remove values, or ask the provider instead of running it; `after` once it ran — what it prepared for
 * confirmation holds only what was said.
 */
export interface SafetyGate {
  check(call: ToolCall): { kind: 'allow'; findings: SafetyFinding[] } | { kind: 'rewrite'; args: Record<string, unknown>; findings: SafetyFinding[] } | { kind: 'ask' | 'refuse'; result: ToolResult; findings: SafetyFinding[] };
  after(call: ToolCall, result: ToolResult): { kind: 'ask'; result: ToolResult; findings: SafetyFinding[] } | { kind: string; findings: SafetyFinding[] } | null;
  note(findings: SafetyFinding[]): string;
  /** A tool's result: what the application showed (dates, times) may be pointed at later in the request. */
  observe?(result: ToolResult): void;
  /** Its model's second look at a risky call the rules let through — it can only ask. */
  review?(call: ToolCall): Promise<{ kind: 'ask'; result: ToolResult; findings: SafetyFinding[] } | null>;
}

/** The reply when a request ended without anything being done. */
export const NOTHING_DONE = "I couldn't carry that out — nothing was changed. Please say it again, or in shorter parts.";

/**
 * Agent turns share one counter: the runtime tells a confirmation prepared in this turn from one prepared
 * earlier by the turn number, whichever agent (single or multi-agent mode) ran it.
 */
let turnCounter = 0;
export const nextTurnId = () => ++turnCounter;

/**
 * Whether the planned steps still hold what was said: nearly every content word of the request must
 * appear in them. A plan that dropped a drug or a date is not used — the request runs in one go instead.
 */
export function planCovers(steps: string[], said: string): boolean {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const planned = new Set(words(steps.join(' ')));
  const content = [...new Set(words(said))].filter((w) => w.length >= 4 && !PLAN_FILLER.has(w));
  if (!content.length) return true;
  const kept = content.filter((w) => planned.has(w) || [...planned].some((p) => p.length >= 4 && (p.startsWith(w) || w.startsWith(p))));
  return kept.length / content.length >= 0.75;
}

/** Words that only announce what the model is about to do ("Let me correct this:"), not an answer. */
function announcesOnly(text: string): boolean {
  const t = text.trim();
  return !t.endsWith('?') && (/:\s*$/.test(t) || /\b(let me|i will|i'll|i need to|i am going to|i'm going to)\b/i.test(t));
}

const NUDGE_ACT = 'Do it now: call the tool(s) that carry out SAID. Do not describe what you will do.';
const NUDGE_TRUNCATED =
  'Your answer was cut off before the tool call was complete, so nothing happened. Call the tool again, shorter: only the fields the provider said, and the same records for several patients listed once with for_patients.';

/**
 * The reply the provider hears. A question from the app is kept word for word; a confirmation may be put
 * in the model's own words when they say the same (review / confirm); otherwise the model's words, or
 * what the last tool did — and when nothing happened, it says so rather than "Done".
 */
function finalReply(awaiting: string | null, modelText: string, lastToolMessage: string, calledTools: boolean): string {
  const usable = !!modelText && !announcesOnly(modelText);
  if (awaiting) return !awaiting.trim().endsWith('?') && usable && /\b(review|confirm)/i.test(modelText) ? modelText : awaiting;
  if (usable) return modelText;
  if (lastToolMessage) return lastToolMessage;
  return calledTools ? 'Done.' : NOTHING_DONE;
}

const PLAN_FILLER = new Set(['then', 'also', 'with', 'that', 'this', 'please', 'after', 'into', 'from', 'have', 'them', 'they', 'their', 'there', 'and', 'what', 'will', 'would', 'could', 'should', 'just', 'okay', 'well', 'unclear']);

let stepCounter = 0;
const stepId = () => `step-${Date.now().toString(36)}-${(stepCounter++).toString(36)}`;

/** What goes back to the model for a tool call. */
function toolMessage(result: ToolResult): string {
  return JSON.stringify(result.data === undefined ? { ok: result.ok, message: result.message } : { ok: result.ok, message: result.message, data: result.data });
}

export class Agent {
  private tools: Tool[] = [];
  private schemas: ToolSchema[] = [];
  private byName = new Map<string, Tool>();
  /** Earlier exchanges (what was said, what was answered), shown in CONTEXT so follow-ups make sense. */
  private earlier: Exchange[] = [];
  static readonly EARLIER_EXCHANGES = 3;
  /** The SESSION message the model's cache was last primed with. */
  private primedSession: string | null = null;
  /** The Safety Agent, between this agent and its tools (null: none). */
  private safety: SafetyGate | null = null;

  constructor(
    private readonly llm: ChatLLM,
    private readonly runtime: AppRuntime,
    private readonly buildContext: () => AIContext,
    private readonly maxSteps: number,
    /** Split long requests into steps before carrying them out. */
    private readonly planSteps = false,
    readonly profile: AgentProfile = ASSISTANT_PROFILE,
  ) {}

  get modelName() {
    return this.llm.name;
  }

  get name() {
    return this.profile.name;
  }

  /** (Re)build the tool list — whenever its inputs (e.g. the provider list) change. */
  setTools(tools: Tool[]) {
    this.tools = tools;
    this.schemas = tools.map(toToolSchema);
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  get toolNames() {
    return this.tools.map((t) => t.name);
  }

  /** Put the Safety Agent between this agent and its tools (null takes it away). */
  setSafety(gate: SafetyGate | null) {
    this.safety = gate;
  }

  get toolList(): readonly Tool[] {
    return this.tools;
  }

  /** What every request starts with: the static system prompt, then the day's SESSION exchange. */
  private prefix(ctx: AIContext): ChatMessage[] {
    return [
      { role: 'system', content: this.profile.systemPrompt },
      { role: 'user', content: buildSessionMessage(ctx) },
      { role: 'assistant', content: SESSION_ACK },
    ];
  }

  /**
   * Load the model and prime its cache with the prefix (system prompt, tools, SESSION), off the
   * first utterance's path. Resolves with an error message when the model could not be loaded, or null.
   */
  async warmUp(): Promise<string | null> {
    if (!this.llm.warmUp) return null;
    const ctx = this.buildContext();
    this.primedSession = buildSessionMessage(ctx);
    return this.llm.warmUp(this.prefix(ctx), this.schemas);
  }

  resetConversation() {
    this.earlier = [];
  }

  contextBlock(said: string, ctx = this.buildContext(), alsoHeard?: string, requirements?: string[]) {
    const sections = requirements?.length
      ? [`APPROVED REQUIREMENTS (gathered by the Planning Agent, checked by the Safety Agent — use these values; a value the provider SAID that is not listed still comes from their words. Never add one they did not say: the app asks for it)\n${requirements.map((r) => `- ${r}`).join('\n')}`]
      : [];
    return buildUserMessage(said, ctx, this.earlier, alsoHeard, undefined, sections);
  }

  /** `alsoHeard`: the same speech as a second recogniser (with the app's vocabulary) heard it. */
  /**
   * One model–tools loop over a user message someone else built (the multi-agent orchestrator: a task for
   * a specialist, or a request for the master). Nothing else: no turn is begun or ended — the caller holds
   * one runtime turn around every agent it runs for the utterance — and no exchange is remembered.
   * `inPlan`: part of a larger request — an "unfinished sentence" there just ends the part.
   */
  async runMessage(content: string, hooks: AgentHooks = {}, signal?: AbortSignal, options: { inPlan?: boolean; guard?: ToolGuard } = {}): Promise<AgentOutcome> {
    const outcome: AgentOutcome = { reply: '', speak: false, awaitingUser: false, deferred: false, fieldsModified: [] };
    const ctx = this.buildContext();
    await this.act([...this.prefix(ctx), { role: 'user', content }], hooks, signal, outcome, options.inPlan ?? false, options.guard);
    return outcome;
  }

  async run(said: string, hooks: AgentHooks = {}, signal?: AbortSignal, alsoHeard?: string, requirements?: string[]): Promise<AgentOutcome> {
    const turn = nextTurnId();
    const ctx = this.buildContext();
    // A new day (or another provider) changed the SESSION block: re-prime the cache after this turn.
    const reprime = this.primedSession !== null && buildSessionMessage(ctx) !== this.primedSession;
    const outcome: AgentOutcome = { reply: '', speak: false, awaitingUser: false, deferred: false, fieldsModified: [] };

    // One turn for the whole utterance, even when it is carried out in steps: what one step prepares
    // (a confirmation, a question) is not the next step's to confirm or answer — only the provider's.
    this.runtime.beginTurn(turn, [said, alsoHeard].filter(Boolean).join(' '));
    try {
      const steps = this.planSteps && Agent.worthPlanning(said) ? await this.plan(said, ctx, alsoHeard, hooks, signal) : null;
      if (!steps) {
        // A long request done in one go (the model does not plan, or planning is off) still shows its steps:
        // the tools as they are carried out — no extra model call.
        const shown = !this.planSteps && Agent.worthPlanning(said) ? this.stepsFromTools(hooks) : hooks;
        await this.act([...this.prefix(ctx), { role: 'user', content: this.contextBlock(said, ctx, alsoHeard, requirements) }], shown, signal, outcome, false);
      } else {
        await this.actInSteps(steps, hooks, signal, outcome);
      }
      return outcome;
    } finally {
      this.runtime.endTurn();
      hooks.onProgress?.(null);
      if (outcome.reply || outcome.awaitingUser) {
        this.earlier.push({ said, reply: outcome.reply });
        this.earlier = this.earlier.slice(-Agent.EARLIER_EXCHANGES);
      }
      if (reprime) void this.warmUp();
    }
  }

  /**
   * The steps of an unplanned request, as its tools run: each call a step in its own words ("Selecting Tom
   * Baker"), done when it succeeds, 'waiting' when it left a question or a confirmation. A refused call is
   * dropped — the model's corrected call takes its place.
   */
  private stepsFromTools(hooks: AgentHooks): AgentHooks {
    const steps: Array<PlanStep & { id: string }> = [];
    const show = () => hooks.onPlan?.(steps.map(({ text, status }) => ({ text, status })));
    return {
      ...hooks,
      onStep: (step) => {
        hooks.onStep?.(step);
        if (step.type !== 'tool') return;
        const at = steps.findIndex((s) => s.id === step.id);
        if (!step.finishedAt) {
          if (at < 0) steps.push({ id: step.id, text: this.stepLabel(step.call), status: 'running' });
        } else if (at >= 0) {
          if (step.result?.ok) steps[at].status = step.result.awaitUser ? 'waiting' : 'done';
          else steps.splice(at, 1);
        }
        show();
      },
    };
  }

  /** A tool call in the words its tool uses while it runs, without the trailing "…". */
  private stepLabel(call: ToolCall): string {
    const tool = this.byName.get(call.name);
    let text: string | undefined;
    try {
      text = tool?.progress?.(call.arguments);
    } catch {
      text = undefined;
    }
    return (text ?? call.name.replace(/_/g, ' ')).replace(/…$/, '').replace(/^./, (c) => c.toUpperCase());
  }

  /** Long enough to hold several actions. Shorter requests go straight to the tools, as always. */
  static worthPlanning(said: string) {
    return said.trim().split(/\s+/).length >= Agent.PLAN_MIN_WORDS;
  }
  static readonly PLAN_MIN_WORDS = 14;
  static readonly PLAN_MAX_STEPS = 10;

  /**
   * Ask the model to split the request into its actions. Null — carry it out in one go, as always —
   * when it is one action, when the model does not plan, or when the plan lost part of what was said.
   */
  private async plan(said: string, ctx: AIContext, alsoHeard: string | undefined, hooks: AgentHooks, signal?: AbortSignal): Promise<string[] | null> {
    const modelStep: AgentStep = { id: stepId(), type: 'model', startedAt: Date.now() };
    hooks.onStep?.(modelStep);
    hooks.onProgress?.('Working out the steps…');
    let steps: string[] | null = null;
    try {
      const messages: ChatMessage[] = [...this.prefix(ctx), { role: 'user', content: buildPlanMessage(said, ctx, this.earlier, alsoHeard) }];
      const answer = await this.llm.chat(messages, this.schemas, { signal });
      hooks.onStep?.({ ...modelStep, finishedAt: Date.now(), content: answer.content, toolCalls: answer.toolCalls });
      const call = answer.toolCalls.find((c) => c.name === PLAN_TOOL);
      const tool = this.byName.get(PLAN_TOOL);
      const parsed = call && tool ? parseArgs(tool, call.arguments) : null;
      if (parsed?.ok) steps = ((parsed.args as { steps: string[] }).steps ?? []).map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      if (signal?.aborted || (e as Error).name === 'AbortError') throw e;
      hooks.onStep?.({ ...modelStep, finishedAt: Date.now(), error: (e as Error).message });
      return null; // the request itself is still carried out — in one go
    }
    if (!steps || steps.length < 2 || steps.length > Agent.PLAN_MAX_STEPS) return null;
    return planCovers(steps, [said, alsoHeard].filter(Boolean).join(' ')) ? steps : null;
  }

  /** Carry out the planned steps one after another, each with fresh CONTEXT: what the steps before it did is on screen. */
  private async actInSteps(texts: string[], hooks: AgentHooks, signal: AbortSignal | undefined, outcome: AgentOutcome) {
    const steps: PlanStep[] = texts.map((text) => ({ text, status: 'pending' }));
    const show = () => hooks.onPlan?.(steps.map((s) => ({ ...s })));
    const done: Exchange[] = [];
    const replies: string[] = [];
    let awaiting: string | null = null;
    for (let i = 0; i < steps.length; i++) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      steps[i].status = 'running';
      show();
      const ctx = this.buildContext();
      const earlier = [...this.earlier, ...done].slice(-Agent.EARLIER_EXCHANGES);
      const content = buildUserMessage(steps[i].text, ctx, earlier, undefined, { index: i + 1, total: steps.length });
      const part: AgentOutcome = { reply: '', speak: false, awaitingUser: false, deferred: false, fieldsModified: [] };
      const end = await this.act([...this.prefix(ctx), { role: 'user', content }], hooks, signal, part, true);
      steps[i].status = part.awaitingUser ? 'waiting' : 'done';
      show();
      outcome.fieldsModified.push(...part.fieldsModified);
      if (part.speak) outcome.speak = true;
      if (part.awaitingUser) awaiting = part.reply;
      else if (part.reply && !replies.includes(part.reply)) replies.push(part.reply);
      done.push({ said: steps[i].text, reply: part.reply });
      if (end === 'final') {
        outcome.reply = part.reply;
        return;
      }
    }
    // One question or confirmation for the provider at the end — the latest, if it is still open.
    const now = this.buildContext();
    if (awaiting && (now.pendingConfirmation || now.pendingQuestion)) {
      outcome.awaitingUser = true;
      outcome.speak = true;
      outcome.reply = awaiting;
    } else {
      outcome.reply = replies.join(' ') || 'Done.';
    }
  }

  /**
   * The model–tools loop for one request (or one planned step), writing into `outcome`.
   * `inPlan`: a step of a planned request — an "unfinished sentence" there just ends the step.
   */
  private async act(messages: ChatMessage[], hooks: AgentHooks, signal: AbortSignal | undefined, outcome: AgentOutcome, inPlan: boolean, guard?: ToolGuard): Promise<'done' | 'final'> {
    let lastToolMessage = '';
    let calledTools = false;
    const seen = new Set<string>();
    let stalls = 0;
    /** What the app is waiting on the provider for (the latest question or confirmation), if anything. */
    let awaiting: string | null = null;
    /** The model's own last words, when it wrote any beside its tool calls. */
    let lastModelText = '';
    let lastResultOk = true;
    /** One nudge per request: an answer cut off, empty, or only announcing what it would do. */
    let nudged = false;

    for (let step = 0; step < this.maxSteps; step++) {
      const modelStep: AgentStep = { id: stepId(), type: 'model', startedAt: Date.now() };
      hooks.onStep?.(modelStep);
      hooks.onProgress?.(step === 0 ? 'Understanding…' : 'Thinking…');
      let content = '';
      let calls: ToolCall[] = [];
      let truncated = false;
      try {
        const answer = await this.llm.chat(messages, this.schemas, { signal });
        content = answer.content.trim();
        calls = answer.toolCalls;
        truncated = !!answer.truncated;
        hooks.onStep?.({ ...modelStep, finishedAt: Date.now(), content, toolCalls: calls });
      } catch (e) {
        hooks.onStep?.({ ...modelStep, finishedAt: Date.now(), error: (e as Error).message });
        throw e;
      }

      if (!calls.length) {
        // No tool call, but the request is not done: the answer was cut off, came back empty, or only
        // announced what it would do ("Let me correct this:"). The model is told once to carry it out.
        const stalledOut = truncated || (!content && !calledTools) || (!!content && !lastResultOk && announcesOnly(content));
        if (stalledOut && !nudged && step < this.maxSteps - 1) {
          nudged = true;
          if (content) messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: truncated ? NUDGE_TRUNCATED : NUDGE_ACT });
          continue;
        }
        if (content) lastModelText = content;
        outcome.reply = finalReply(awaiting, lastModelText, lastToolMessage, calledTools);
        if (awaiting) outcome.speak = true;
        if (!calledTools) outcome.speak = true;
        break;
      }
      if (content) lastModelText = content;
      calledTools = true;
      messages.push({ role: 'assistant', content, tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) });

      // Every result goes back to the model: only the model knows whether the request has
      // more parts ("go to patients, select James and add a task") or is done.
      for (const call of calls) {
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        if (call.name === WAIT_TOOL && calls.length === 1) {
          // A planned step is part of a finished request: there is nothing more to wait for.
          if (!inPlan) outcome.deferred = true;
          hooks.onStep?.({ id: stepId(), type: 'tool', startedAt: Date.now(), finishedAt: Date.now(), call, result: { ok: true, message: 'Waiting for the rest of the sentence.' } });
          return 'done';
        }
        const result = await this.execute(call, hooks, guard);
        // The same call giving the same result again is a loop, not progress ("next page" twice is
        // progress: its result changes). Tell the model once; the second time, end the turn.
        const signature = `${call.name} ${JSON.stringify(call.arguments)} → ${result.message}`;
        const stalled = seen.has(signature);
        seen.add(signature);
        if (stalled && ++stalls >= 2) {
          outcome.reply = awaiting ?? result.message; // what the provider must answer, not the looping call
          outcome.speak = true;
          return 'done';
        }
        const note = stalled ? { ...result, message: `${result.message} (Same call, same result as before — do not repeat it: try something different or answer the provider.)` } : result;
        messages.push({ role: 'tool', tool_name: call.name, content: toolMessage(note) });
        lastToolMessage = result.message;
        lastResultOk = result.ok;
        if (result.fieldsModified) outcome.fieldsModified.push(...result.fieldsModified);
        if (result.speak) outcome.speak = true;
        if (result.awaitUser) {
          // The app needs the provider (a missing value, a confirmation) — but the rest of what they
          // asked for still gets done first: "…metformin, a task for BP monitoring and a follow-up next
          // Tuesday" must not lose the task and the appointment because the medication form asked a
          // question. The model continues; the question is the reply at the end.
          outcome.awaitingUser = true;
          awaiting = result.message;
        }
        if (result.final) {
          // Nothing can follow (the model is being replaced, or the provider signed out).
          outcome.reply = result.message;
          return 'final';
        }
      }
      if (step === this.maxSteps - 1) outcome.reply = awaiting ?? lastToolMessage;
    }
    return 'done';
  }

  private async execute(asked: ToolCall, hooks: AgentHooks, guard?: ToolGuard): Promise<ToolResult> {
    const step: AgentStep = { id: stepId(), type: 'tool', startedAt: Date.now(), call: asked };
    hooks.onStep?.(step);
    const tool = this.byName.get(asked.name);
    let result: ToolResult;
    // The Safety Agent first: what the model put in the call must have been said.
    const safety = tool && this.safety ? this.safety.check(asked) : null;
    let findings: SafetyFinding[] = safety?.findings ?? [];
    const call: ToolCall = safety?.kind === 'rewrite' ? { ...asked, arguments: safety.args } : asked;
    const stopped = safety?.kind === 'ask' || safety?.kind === 'refuse';
    const refused = tool && guard && !stopped ? await guard(call, tool) : null;
    // Then, for a risky call, the Safety Agent's model: it finds what does not match what was said, and asks.
    if (tool && this.safety?.review && !stopped && !refused) {
      const reviewed = await this.safety.review(call);
      if (reviewed) {
        result = reviewed.result;
        findings = [...findings, ...reviewed.findings];
        hooks.onStep?.({ ...step, finishedAt: Date.now(), result, safety: findings });
        return result;
      }
    }
    if (!tool) {
      result = { ok: false, message: `There is no tool "${call.name}". Available: ${this.toolNames.join(', ')}.` };
    } else if (safety?.kind === 'ask' || safety?.kind === 'refuse') {
      result = safety.result;
    } else if (refused) {
      result = refused;
    } else {
      const parsed = parseArgs(tool, call.arguments);
      if (!parsed.ok) result = { ok: false, message: parsed.error };
      else {
        hooks.onProgress?.(tool.progress?.(parsed.args) ?? 'Working…');
        try {
          result = await tool.run(parsed.args, { runtime: this.runtime });
        } catch (e) {
          result = { ok: false, message: `${call.name} failed: ${(e as Error).message}` };
        }
      }
      if (this.safety && findings.length) result = { ...result, message: `${result.message} ${this.safety.note(findings)}`.trim() };
      this.safety?.observe?.(result);
      // What it prepared for the provider to confirm holds only what was said — or it is not shown to them.
      const post = this.safety?.after(call, result);
      if (post?.kind === 'ask' && 'result' in post) {
        result = post.result;
        findings = [...findings, ...post.findings];
      }
    }
    hooks.onStep?.({ ...step, finishedAt: Date.now(), result, safety: findings.length ? findings : undefined });
    return result;
  }

  /**
   * Extract a clinical note into items for review (AI Summary). Uses the same system prompt
   * and tools as every command, so the runtime's cached prefix is reused; the model reports
   * the findings through the record_note_findings tool, validated against its schema.
   */
  async extractNote(note: string, hooks: AgentHooks = {}): Promise<ExtractionResult> {
    const tool = this.byName.get(NOTE_FINDINGS_TOOL)!;
    const ctx = this.buildContext();
    const messages: ChatMessage[] = [...this.prefix(ctx), { role: 'user', content: buildExtractionMessage(note, ctx) }];
    for (let attempt = 0; attempt < 3; attempt++) {
      const modelStep: AgentStep = { id: stepId(), type: 'model', startedAt: Date.now() };
      hooks.onStep?.(modelStep);
      const answer = await this.llm.chat(messages, this.schemas, { maxTokens: 1500 });
      hooks.onStep?.({ ...modelStep, finishedAt: Date.now(), content: answer.content, toolCalls: answer.toolCalls });
      const call = answer.toolCalls.find((c) => c.name === NOTE_FINDINGS_TOOL);
      const parsed = call ? parseArgs(tool, call.arguments) : null;
      const findings = call && parsed?.ok ? toExtraction(note, this.llm.name, parsed.args as Record<string, unknown>) : null;
      if (findings && !findings.problems.length) return findings.result;
      const problem = !call ? 'You did not call record_note_findings.' : findings ? `Fix these and call it again: ${findings.problems.join('; ')}` : (parsed as { error: string }).error;
      messages.push(
        { role: 'assistant', content: answer.content, tool_calls: answer.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) },
        call ? { role: 'tool', tool_name: call.name, content: JSON.stringify({ ok: false, message: problem }) } : { role: 'user', content: `${problem} Call it now with the findings of the note.` },
      );
    }
    throw new Error('The model did not return the note findings in the expected form. Try again, or add the items by hand.');
  }
}

/** Findings checked against the form definitions: values that do not fit are sent back to the model to fix. */
function toExtraction(note: string, provider: string, args: Record<string, unknown>): { result: ExtractionResult; problems: string[] } {
  const items = Object.fromEntries(RECORD_KINDS.map((kind) => [kind, [] as ExtractionResult['items'][typeof kind]])) as ExtractionResult['items'];
  const problems: string[] = [];
  for (const kind of RECORD_KINDS) {
    const list = (args[recordPlural[kind]] as Array<Record<string, FieldScalar>> | undefined) ?? [];
    list.forEach((entry, i) => {
      const { quote, ...fields } = entry;
      const clean: FieldValues = {};
      for (const [name, value] of Object.entries(fields)) {
        if (value === '') continue;
        const field = FieldRegistry.resolveField(kind, name);
        if (!field) {
          problems.push(`${recordPlural[kind]}[${i}]: "${name}" is not a ${kind} field`);
          continue;
        }
        const coerced = FieldRegistry.coerceValue(field, value);
        if (coerced.ok) clean[field.name] = coerced.value;
        else problems.push(`${recordPlural[kind]}[${i}]: ${coerced.error}`);
      }
      if (Object.keys(clean).length) items[kind].push({ fields: clean, quote: typeof quote === 'string' ? quote : undefined });
    });
  }
  return { result: { transcript: note, provider, items, questions: ((args.questions as string[] | undefined) ?? []).filter(Boolean) }, problems };
}

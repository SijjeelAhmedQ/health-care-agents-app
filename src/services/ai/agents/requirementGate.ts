/**
 * The requirement gate of the single assistant — the Planning Agent before anything runs, as in multi-agent mode.
 *
 *   provider says ─► the operation (add · change · delete · show · select …)? none: the assistant runs as before
 *                       │
 *                       ▼
 *                 PLANNING AGENT (submit_requirements) + Safety Agent: what this operation still needs
 *                       │
 *          missing? ────┼─ yes → one polite question; nothing runs — no page change, no search, no form.
 *                       │        The answer is added (across turns), and asked again until complete.
 *                       └─ no  → the assistant runs the whole request, with the approved requirements.
 *
 * The same Planning Agent, prompts and checks as multi-agent mode: one task, for the agent whose records the
 * request is about. Nothing here decides values — the model reports what was said, the Safety Agent checks it.
 */
import type { AgentName } from '@/types/ai';
import type { AgentHooks, AgentOutcome } from '../agent/agent';
import { detectOperation } from '../safety/operations';
import type { PlanningReport } from '../monitor/recorder';
import { PlanningAgent, type RequirementDraft } from './planning';
import { recordOwner } from './skills';
import { TaskGraph } from './taskGraph';

export type GateHooks = AgentHooks & { onPlanning?: (report: PlanningReport) => void; onFreshRequest?: () => void };

export type GateResult =
  /** Something is missing: this is the reply (a question); nothing runs. */
  | { kind: 'ask'; outcome: AgentOutcome }
  /** Complete: run the assistant on `said` (the whole request, answers included) with these requirements. */
  | { kind: 'run'; said: string; requirements: string[] }
  /** Not an operation on records (a question, "yes", an answer to a form): the assistant runs as it would. */
  | { kind: 'pass' };

/** The one task of a request: for the agent whose records it is about. Null: nothing to gather. */
export function singleTask(said: string): TaskGraph | null {
  const { operation, kind } = detectOperation(said);
  if (operation === 'other') return null;
  const agent: AgentName =
    (kind && kind !== 'patient' ? recordOwner(kind) : undefined) ?? (operation === 'select_patient' || operation === 'create_patient' || kind === 'patient' ? 'patients' : 'medications');
  const executionType = operation === 'view' ? 'READ_ONLY' : operation === 'select_patient' ? 'CONTEXT' : 'WRITE';
  const graph = new TaskGraph(said, [{ id: 't1', agent, instruction: said, executionType }]);
  return PlanningAgent.applies(graph) ? graph : null;
}

export class RequirementGate {
  private held: { graph: TaskGraph; plan: RequirementDraft; request: string; answers: string[] } | null = null;

  constructor(private readonly planning: PlanningAgent) {}

  /** A request is held: the provider was asked for what it is missing. */
  get holding(): boolean {
    return !!this.held;
  }

  /** Forget the held request (signed out, cleared, replaced). */
  drop() {
    this.held = null;
  }

  async check(said: string, alsoHeard: string | undefined, hooks: GateHooks, signal?: AbortSignal): Promise<GateResult> {
    if (this.held) {
      const held = this.held;
      hooks.onPlanning?.({ type: 'started' });
      const next = await this.planning.answer(held.plan, held.graph, said, alsoHeard, hooks, signal);
      if (next !== 'not_an_answer') {
        const answers = [...held.answers, said];
        if (next.question) {
          this.held = { ...held, plan: next, answers };
          return this.ask(next, hooks);
        }
        this.held = null;
        hooks.onPlanning?.({ type: 'ready', approved: Object.values(next.approved).flat(), findings: next.findings });
        return { kind: 'run', said: [held.request, ...answers].join(' — '), requirements: Object.values(next.approved).flat() };
      }
      // They asked for something else: the held request is dropped, this one is gathered afresh.
      this.held = null;
      hooks.onPlanning?.({ type: 'dropped' });
    }
    const graph = singleTask(said);
    if (!graph) return { kind: 'pass' };
    // A new request: only its own words count as said for it.
    hooks.onFreshRequest?.();
    hooks.onPlanning?.({ type: 'started' });
    const plan = await this.planning.plan(graph, said, alsoHeard, hooks, signal);
    if (plan.question) {
      this.held = { graph, plan, request: said, answers: [] };
      return this.ask(plan, hooks);
    }
    hooks.onPlanning?.({ type: 'ready', approved: Object.values(plan.approved).flat(), findings: plan.findings });
    return { kind: 'run', said, requirements: Object.values(plan.approved).flat() };
  }

  private ask(plan: RequirementDraft, hooks: GateHooks): GateResult {
    hooks.onPlanning?.({ type: 'question', question: plan.question ?? '', missing: plan.missing.map((m) => m.kind), findings: plan.findings });
    return { kind: 'ask', outcome: { reply: plan.question ?? '', speak: true, awaitingUser: true, deferred: false, fieldsModified: [] } };
  }
}

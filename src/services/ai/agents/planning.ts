/**
 * The Planning Agent — requirement gathering before anything runs (multi-agent mode).
 *
 *   master: assign_tasks ─► PLANNING AGENT (model: submit_requirements — only what was SAID)
 *                               │
 *                               ├─ the OPERATION of each task: add · update · delete one · delete all · view ·
 *                               │   select / create a patient — the provider's words decide it (code), a model's
 *                               │   "add_records" for "delete all medications" is corrected
 *                               ├─ Safety Agent vets every value (said? app data? app default?)
 *                               ├─ code works out what THIS operation still needs (safety/operations.ts):
 *                               │   an add its form's required fields; an update the record and its changes;
 *                               │   a delete the record (one) or nothing but the patient (all); a view the patient
 *                               │
 *                    missing? ──┼─ yes → ONE fixed question; the request is held (across turns)
 *                               │         the provider answers → Planning Agent adds what the answer gives → again
 *                               └─ no  → APPROVED REQUIREMENTS go with each task to its specialist ─► scheduler
 *                                         (a delete is still confirmed by the provider before anything is deleted)
 *
 * It never runs an action and never fills a value: the model only reports what the provider said, and a
 * value it reports that was not said is removed by the Safety Agent, so it is asked for instead.
 */
import { z } from 'zod';
import type { AgentName, AIContext, FieldValues, SafetyFinding } from '@/types/ai';
import { RECORD_KINDS, type RecordKind } from '@/types/records';
import { recordLabels } from '@/registry/recordRegistry';
import { FieldRegistry } from '@/registry/fieldRegistry';
import type { ChatLLM } from '../providers/llm';
import { Agent, type AgentHooks } from '../agent/agent';
import { buildUserMessage } from '../agent/prompt';
import { defineTool } from '../agent/tool';
import type { AppRuntime } from '../agent/runtime';
import type { SafetyAgent } from '../safety/safetyAgent';
import { questionFor, type Missing } from '../safety/requirements';
import { detectOperation, entitiesIn, isDestructive, missingFor, saysAdd, type Entity, type Operation } from '../safety/operations';
import { agentPrompt, agentRecordKinds, recordOwner } from './skills';
import { AGENT_NAMES, AGENT_TITLES, type TaskGraph } from './taskGraph';

export const SUBMIT_TOOL = 'submit_requirements';
export const NOT_AN_ANSWER_TOOL = 'not_an_answer';

export type PlannedActionKind = 'select_patient' | 'create_patient' | 'add_records' | 'update_record' | 'delete_records' | 'view_records' | 'other';
const ACTION_KINDS = ['select_patient', 'create_patient', 'add_records', 'update_record', 'delete_records', 'view_records', 'other'] as const;

export interface PlannedAction {
  task: string;
  agent: AgentName;
  action: PlannedActionKind;
  /** The patient as the provider said it (vetted). */
  patient?: string;
  /** add_records: each record with only what was said. */
  records: Array<{ kind: RecordKind; values: FieldValues }>;
  patientDetails: FieldValues;
  /** update / delete / view: the kind of record it is about. */
  kind?: Entity;
  /** update / delete one: the record as the provider named it (vetted). */
  record?: string;
  /** delete: one record, or ALL of the kind. */
  scope?: 'one' | 'all';
  /** update: only the fields being changed, with what they change to (vetted). */
  changes: FieldValues;
  /** A second operation the model reported for the same task — it becomes its own task, after that one. */
  split?: boolean;
  /** What the specialist of the task is told it does NOT do (it was split off to another task). */
  notes?: string[];
  /** The patient named is nobody on file, or several: asked which. */
  unresolved?: boolean;
  /** Each record names its own patient. */
  perRecord?: boolean;
  /** "To Luke King, Tom Baker and Chloe Bell": every record for each of them. */
  forPatients?: string[];
}

/** A request's requirements: what each action has, what it still needs, and the question that asks for it. */
export interface RequirementDraft {
  actions: PlannedAction[];
  missing: Missing[];
  question: string | null;
  /** The approved requirements, per task, as the specialists read them. */
  approved: Record<string, string[]>;
  findings: SafetyFinding[];
}

/**
 * The tasks the Planning Agent gathers requirements for: the ones that select, add, change, delete or show records
 * (the patients' and each record kind's agent; a Summary Agent task only when it is really an action on records).
 */
const PLANNED_AGENTS: ReadonlySet<AgentName> = new Set(['patients', 'appointments', 'patient_appointments', 'medications', 'diagnoses', 'tasks', 'recalls', 'summary']);
/** The provider's OWN appointments ("my appointments", "my schedule"): not a patient's records — nothing to gather. */
const MY_OWN = /\b(my|mine)\s+(own\s+)?(appointments?|schedule|agenda|calendar|bookings?|day)\b|\bwho am i seeing\b|\bmy\s+\d{1,2}(:\d\d)?\s*(am|pm)\b/i;
/** A summary asked for — the Summary Agent's, with nothing to gather: it changes nothing. */
const SUMMARY_WORDS = /\b(summar(y|ies|ise|ize|ised|ized|ising|izing)|overview|recap|brief me|at a glance|digest)\b/i;
/** Words of an action that needs something said — whatever execution type the master gave the task. */
const ACTION_WORDS = /\b(select|choose|pick|add|create|new|book|schedule|prescribe|record|register|enrol|enroll)\b/i;
const planned = (t: { agent: AgentName; executionType: string; instruction: string }) => {
  if (!PLANNED_AGENTS.has(t.agent)) return false;
  if (t.agent === 'summary' && SUMMARY_WORDS.test(t.instruction)) return false;
  if (t.agent === 'appointments' && MY_OWN.test(t.instruction)) return false;
  if (t.executionType !== 'READ_ONLY' || ACTION_WORDS.test(t.instruction)) return true;
  // Whatever execution type the master gave it: an operation on records ("Recall Zoe Hill", "Give Luke King …")
  // is gathered for — and seeing a patient's records needs the patient.
  const seen = detectOperation(t.instruction);
  return (seen.operation !== 'other' && seen.operation !== 'view') || (seen.operation === 'view' && !!seen.kind);
};

/** The operation, as the planner names it. */
function actionOf(operation: Operation): { action: PlannedActionKind; scope?: 'one' | 'all' } | null {
  switch (operation) {
    case 'add':
      return { action: 'add_records' };
    case 'create_patient':
      return { action: 'create_patient' };
    case 'select_patient':
      return { action: 'select_patient' };
    case 'update':
      return { action: 'update_record' };
    case 'delete_one':
      return { action: 'delete_records', scope: 'one' };
    case 'delete_all':
      return { action: 'delete_records', scope: 'all' };
    case 'view':
      return { action: 'view_records' };
    default:
      return null;
  }
}

/** …and back: the operation a planned action is. */
function operationOf(a: PlannedAction): Operation {
  switch (a.action) {
    case 'add_records':
      return 'add';
    case 'update_record':
      return 'update';
    case 'delete_records':
      return a.scope === 'all' ? 'delete_all' : 'delete_one';
    case 'view_records':
      return 'view';
    case 'select_patient':
    case 'create_patient':
      return a.action;
    default:
      return 'other';
  }
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** What a request must hold for a record of these kinds to be asked for (a drug or a condition can be named alone). */
const TRACE: Partial<Record<RecordKind, RegExp>> = {
  appointment: /\b(appointments?|visits?|follow ?-?ups?|book|schedule|see (him|her|them)|check ?-?up)\b/,
  recall: /\b(recalls?|remind|reminder)\b/,
  task: /\b(tasks?|to ?-?do)\b/,
};

const NAME_FIELD: Partial<Record<RecordKind | 'patient', string>> = { medication: 'medicationName', diagnosis: 'description', task: 'title', recall: 'reason' };

/** What a record can hold — the field names the Planning Agent reports values under. */
function fieldList(): string {
  return [...RECORD_KINDS, 'patient' as const]
    .map((kind) => `${kind}: ${FieldRegistry.getForm(kind)!.fields.filter((f) => f.name !== 'patient').map((f) => f.name).join(', ')}`)
    .join('\n');
}

const show = (v: unknown) => (typeof v === 'string' ? v : String(v));

/** JSON sent as text ("[{\"kind\": …}]") is the JSON it holds. */
function parsed(v: unknown): unknown {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    // "{…}, {…}" — a list without its brackets.
    try {
      return /^\s*\{/.test(v) ? JSON.parse(`[${v}]`) : v;
    } catch {
      return v;
    }
  }
}

/**
 * A report as small models send it — one task on its own instead of in `tasks`, lists and values as JSON text —
 * read as what it means. Nothing is added: only its shape is mended.
 */
export function normalizeReport(raw: unknown): unknown {
  const args = (parsed(raw) ?? {}) as Record<string, unknown>;
  let tasks = parsed(args.tasks);
  if (!Array.isArray(tasks)) tasks = args.task !== undefined || args.action !== undefined ? [args] : [];
  return {
    tasks: (tasks as unknown[]).map((t) => {
      const task = { ...((parsed(t) ?? {}) as Record<string, unknown>) };
      for (const key of ['records', 'values', 'changes', 'patient_details']) if (key in task) task[key] = parsed(task[key]);
      if (Array.isArray(task.records)) task.records = (task.records as unknown[]).map((r) => {
        const rec = { ...((parsed(r) ?? {}) as Record<string, unknown>) };
        if ('values' in rec) rec.values = parsed(rec.values);
        return rec;
      });
      return task;
    }),
  };
}
const copyActions = (actions: PlannedAction[]): PlannedAction[] =>
  actions.map((a) => ({ ...a, records: a.records.map((r) => ({ ...r, values: { ...r.values } })), patientDetails: { ...a.patientDetails }, changes: { ...a.changes } }));
const pluralOf = (kind: Entity) => (kind === 'patient' ? 'patients' : recordLabels[kind].plural);

type Submitted = {
  task?: string;
  action?: PlannedActionKind;
  patient?: string;
  records?: Array<{ kind: RecordKind; values?: FieldValues }>;
  patient_details?: FieldValues;
  kind?: Entity;
  record?: string;
  scope?: 'one' | 'all';
  changes?: FieldValues;
  /** One record given on the task itself (kind + values) instead of in records. */
  values?: FieldValues;
};

export class PlanningAgent {
  readonly agent: Agent;
  private submitted: unknown = null;
  private declined = false;

  constructor(
    llm: ChatLLM,
    runtime: AppRuntime,
    private readonly buildContext: () => AIContext,
    maxSteps: number,
    private readonly safety: () => SafetyAgent | null,
  ) {
    this.agent = new Agent(llm, runtime, buildContext, Math.min(maxSteps, 3), false, { name: 'planning', systemPrompt: agentPrompt('planning') });
    this.agent.setTools([this.submitTool(), this.notAnAnswerTool()]);
  }

  get modelName() {
    return this.agent.modelName;
  }

  /** Whether a graph has anything to plan (a task that selects, adds, changes, deletes or shows records). */
  static applies(graph: TaskGraph): boolean {
    return graph.tasks.some((t) => t.status === 'PENDING' && planned(t));
  }

  /** A new request: what does each task need, and is any of it missing? */
  async plan(graph: TaskGraph, said: string, alsoHeard: string | undefined, hooks: AgentHooks, signal?: AbortSignal): Promise<RequirementDraft> {
    const tasks = graph.tasks.filter((t) => t.status === 'PENDING' && planned(t));
    const actions = tasks.map<PlannedAction>((t) => ({ task: t.id, agent: t.agent, action: 'other', records: [], patientDetails: {}, changes: {} }));
    // Only showing records, for a patient already chosen: nothing to read from the words — no model is asked.
    // (A delete always is: whose records go must be read from what was said.)
    const codeOnly = this.patientChosen(actions, graph) && tasks.every((t) => this.detect(t, tasks.length === 1 ? said : undefined).operation === 'view');
    let submitted: unknown = null;
    if (!codeOnly) {
      const sections = [`TASKS (from the master)\n${tasks.map((t) => `${t.id} ${t.agent}: ${t.instruction}`).join('\n')}`, `FIELDS (the names to report values under)\n${fieldList()}`];
      submitted = await this.ask(buildUserMessage(said, this.buildContext(), [], alsoHeard, undefined, sections), hooks, signal);
    }
    const findings: SafetyFinding[] = [];
    this.merge(actions, submitted, graph, said, findings);
    return this.complete(actions, graph, findings);
  }

  /** The provider answered the question: add what the answer gives. 'not_an_answer': they asked for something else. */
  async answer(draft: RequirementDraft, graph: TaskGraph, said: string, alsoHeard: string | undefined, hooks: AgentHooks, signal?: AbortSignal): Promise<RequirementDraft | 'not_an_answer'> {
    const known = draft.actions.map(
      (a) =>
        `${a.task} ${a.action}${a.kind ? ` · kind: ${a.kind}` : ''}${a.scope ? ` · scope: ${a.scope}` : ''}${a.record ? ` · record: ${a.record}` : ''}${a.patient ? ` · patient: ${a.patient}` : ''}` +
        `${Object.keys(a.changes).length ? ` · changes: ${Object.entries(a.changes).map(([k, v]) => `${k}=${show(v)}`).join(', ')}` : ''}` +
        a.records.map((r, i) => ` · ${r.kind} ${i + 1}: ${Object.entries(r.values).map(([k, v]) => `${k}=${show(v)}`).join(', ') || 'nothing yet'}`).join(''),
    );
    const sections = [
      `OPEN REQUEST: ${graph.request}`,
      `GATHERED SO FAR\n${known.join('\n')}`,
      `QUESTION ASKED: "${draft.question ?? ''}" — SAID is the provider's answer`,
      `FIELDS (the names to report values under)\n${fieldList()}`,
    ];
    const submitted = await this.ask(buildUserMessage(said, this.buildContext(), [], alsoHeard, undefined, sections), hooks, signal);
    if (this.declined) return 'not_an_answer';
    const actions = copyActions(draft.actions);
    const findings: SafetyFinding[] = [];
    // The operation was settled with the request: an answer adds what it gives, it never turns a delete into an add.
    this.merge(actions, submitted, graph, undefined, findings, true);
    return this.complete(actions, graph, [...draft.findings, ...findings]);
  }

  // ------------------------------------------------------------------------------------------- internals

  private async ask(message: string, hooks: AgentHooks, signal?: AbortSignal): Promise<unknown> {
    this.submitted = null;
    this.declined = false;
    await this.agent.runMessage(message, hooks, signal, { inPlan: true });
    return this.submitted;
  }

  /** The operation a task's words ask for — the master's instruction, else (one task) what was said. */
  private detect(task: { instruction: string }, said?: string) {
    const fromTask = detectOperation(task.instruction);
    if (fromTask.operation !== 'other' || !said) return fromTask;
    return detectOperation(said);
  }

  /** A patient is chosen: selected now, selected earlier in this request, or selected / created by one of its tasks. */
  private patientChosen(actions: PlannedAction[], graph: TaskGraph) {
    return (
      !!this.buildContext().currentPatientId ||
      actions.some((a) => (a.action === 'select_patient' || a.action === 'create_patient') && (a.patient || a.action === 'create_patient')) ||
      graph.tasks.some((t) => t.agent === 'patients' && t.status === 'COMPLETED')
    );
  }

  /**
   * What the model reported, into the actions (new values add to, never replace, what was said before) — then
   * the operation the words ask for: the code's, whenever the model's differs ("delete all medications"
   * reported as add_records is a delete of ALL medications, with nothing else to ask).
   */
  private merge(actions: PlannedAction[], submitted: unknown, graph: TaskGraph, said: string | undefined, findings: SafetyFinding[], answering = false) {
    const list = ((submitted as { tasks?: unknown[] } | null)?.tasks ?? []) as Submitted[];
    const reported = new Set<PlannedAction>();
    for (const item of list) {
      let action =
        actions.find((a) => a.task === item.task?.trim()) ??
        (list.length === 1 && actions.length === 1 ? actions[0] : undefined) ??
        // No task id (qwen3.5:9b left it out of the select): the task in the same place of a list of the same length.
        (!item.task && list.length === actions.length ? actions[list.indexOf(item)] : undefined);
      if (!action) continue;
      // The same task reported twice with two operations ("select Chloe Bell, then add Metformin"): neither is
      // lost — the second is its own action, and becomes its own task.
      if (!answering && reported.has(action) && item.action && item.action !== 'other' && action.action !== 'other' && item.action !== action.action) {
        const extra: PlannedAction = { task: action.task, agent: action.agent, action: 'other', records: [], patientDetails: {}, changes: {}, split: true };
        actions.push(extra);
        action = extra;
      }
      reported.add(action);
      if (item.action && item.action !== 'other' && !answering) action.action = item.action;
      // Several reports for one task, each for another patient ("For Luke King add Panadol … For Tom Baker add
      // Gabapentin …"): each record keeps the patient it was said for.
      const ownPatient = item.patient && action.patient && action.patient.toLowerCase() !== item.patient.toLowerCase() ? item.patient : undefined;
      if (ownPatient) {
        for (const r of action.records) if (r.values.patient === undefined && action.patient) r.values.patient = action.patient;
        action.perRecord = true;
      } else if (item.patient && !action.perRecord) action.patient = item.patient;
      if (item.kind && !action.kind) action.kind = item.kind;
      if (item.record) action.record = item.record;
      if (item.scope && !answering) action.scope = item.scope;
      if (item.changes) Object.assign(action.changes, item.changes);
      // One record on the task itself ({kind, values}) is a record — or, for a change, its changes.
      const shorthand = item.values && Object.keys(item.values).length ? item.values : undefined;
      if (shorthand && (item.action === 'update_record' || action.action === 'update_record')) Object.assign(action.changes, shorthand);
      const records = item.records?.length ? item.records : shorthand && item.kind && item.kind !== 'patient' && item.action !== 'update_record' ? [{ kind: item.kind, values: shorthand }] : [];
      if (shorthand && item.action === 'create_patient') Object.assign(action.patientDetails, shorthand);
      // A new report: every record is its own ("metformin, Panadol, gabapentin, rituximab" are four). An answer
      // adds to what was gathered: the n-th record of a kind it gives goes to the n-th of that kind asked about.
      // An answer for records that were split off to their own agent's task ("…and diabetes" for the Diagnoses
      // Agent's task beside the Medication Agent's) goes to that task — never a second copy of it.
      const homeOf = (kind: RecordKind): PlannedAction => {
        const owner = recordOwner(kind);
        if (!answering || !owner || owner === action!.agent) return action!;
        const root = (id: string) => graph.tasks.find((t) => t.id === id)?.splitFrom ?? id;
        return actions.find((a) => a.agent === owner && root(a.task) === root(action!.task)) ?? action!;
      };
      const before = new Map<PlannedAction, PlannedAction['records']>();
      const nth = new Map<string, number>();
      for (const record of records) {
        if (!(RECORD_KINDS as readonly string[]).includes(record.kind)) continue;
        const into = homeOf(record.kind);
        if (!before.has(into)) before.set(into, answering ? into.records.slice() : []);
        const key = `${into.task}:${record.kind}`;
        const n = nth.get(key) ?? 0;
        nth.set(key, n + 1);
        const target = before.get(into)!.filter((r) => r.kind === record.kind)[n];
        const values = { ...(record.values ?? {}), ...(into.perRecord && item.patient ? { patient: item.patient } : {}) };
        if (target) Object.assign(target.values, values);
        else into.records.push({ kind: record.kind, values });
        if (into.action === 'other') into.action = 'add_records';
      }
      if (item.patient_details) Object.assign(action.patientDetails, item.patient_details);
    }

    for (const action of actions) {
      const task = graph.tasks.find((t) => t.id === action.task);
      if (!task) continue;
      if (!answering && !action.split) this.settleOperation(action, task, actions.length === 1 ? said : undefined, findings);
      // A record of a kind nothing in the words asks for (an appointment when only a recall was said): the model's.
      if (action.action === 'add_records' && !answering) {
        const words = `${task.instruction} ${graph.tasks.length === 1 ? (said ?? '') : ''}`.toLowerCase();
        const kept = action.records.filter((r) => !TRACE[r.kind] || TRACE[r.kind]!.test(words));
        for (const r of action.records) if (!kept.includes(r)) findings.push({ tool: 'plan', field: `${action.task} · ${r.kind}`, value: r.kind, action: 'removed', reason: `no ${r.kind} was asked for` });
        action.records = kept;
      }
      // A record the provider asked to add that the model did not list ("Add medication"): there, with nothing said yet.
      if (action.action === 'add_records' && !action.records.length) {
        // What the words ask for: a kind named ("task"), a drug the app knows ("add metformin"), a booking.
        const words = `${task.instruction} ${graph.tasks.length === 1 ? (said ?? '') : ''}`.toLowerCase();
        const kinds = new Set(entitiesIn(words).filter((k) => k !== 'patient') as RecordKind[]);
        const safety = this.safety();
        if (safety?.namesKnown('medication', words)) kinds.add('medication');
        for (const [kind, re] of Object.entries(TRACE) as Array<[RecordKind, RegExp]>) if (re.test(words)) kinds.add(kind);
        action.records = RECORD_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, values: {} }));
      }
      if (action.action !== 'add_records') action.records = action.action === 'update_record' || action.action === 'delete_records' ? [] : action.records;
    }
  }

  /** The operation the words ask for wins over the model's; what the model reported is moved to where it belongs. */
  private settleOperation(action: PlannedAction, task: { agent: AgentName; instruction: string }, said: string | undefined, findings: SafetyFinding[]) {
    // "Add Metformin … to Chloe Bell" reported as a new patient WITH the records: the records are the request —
    // for the patient named; nobody new is registered.
    if (action.action === 'create_patient' && action.records.length) {
      const d = action.patientDetails;
      const name = action.patient ?? ([d.firstName, d.lastName].filter((v) => v !== undefined && v !== '').join(' ') || undefined);
      findings.push({ tool: 'plan', field: `${action.task} · operation`, value: 'create_patient', action: 'corrected', corrected: 'add_records', reason: 'records were asked for — for the patient named' });
      action.action = 'add_records';
      if (name) action.patient = String(name);
      action.patientDetails = {};
    }
    const detected = this.detect(task, said);
    let wanted = actionOf(detected.operation);
    // An add is the model's to tell apart — records, or a new patient — from what it reported; never a guess
    // from which agent the master picked ("Add Panadol … to Luke King" sent to the Patients Agent adds a drug).
    if (detected.operation === 'add') {
      if (action.action === 'add_records' || action.action === 'create_patient') wanted = null;
      else if (!action.records.length && task.agent === 'patients') wanted = null;
    }
    // "Select Tom Baker, add Gabapentin …, create a task …": the model reported the records — the add, for the
    // patient selected, is what the task does; selecting them comes with it. Nothing reported is lost.
    if (detected.operation === 'select_patient' && action.action === 'add_records' && action.records.length && saysAdd(task.instruction)) wanted = null;
    // …also when the model called it a select, with the records under it.
    if (action.action === 'select_patient' && action.records.length && saysAdd(task.instruction)) {
      action.action = 'add_records';
      wanted = null;
    }
    const kind = action.kind ?? detected.kind ?? action.records[0]?.kind ?? (task.agent === 'patients' ? 'patient' : undefined);
    if (wanted && (wanted.action !== action.action || (wanted.scope && wanted.scope !== action.scope))) {
      if (action.action !== 'other') {
        findings.push({ tool: 'plan', field: `${action.task} · operation`, value: `${action.action}${action.scope ? ` (${action.scope})` : ''}`, action: 'corrected', corrected: `${wanted.action}${wanted.scope ? ` (${wanted.scope})` : ''}`, reason: 'the operation the provider asked for' });
      }
      // An add's record reported for an update or a delete: its name is the record, the rest are the changes.
      const first = action.records[0];
      const nameField = first ? NAME_FIELD[first.kind] : undefined;
      if (first && (wanted.action === 'update_record' || wanted.action === 'delete_records')) {
        if (nameField && first.values[nameField] !== undefined && !action.record) action.record = show(first.values[nameField]);
        if (wanted.action === 'update_record') {
          for (const [k, v] of Object.entries(first.values)) if (k !== nameField && action.changes[k] === undefined) action.changes[k] = v;
        }
      }
      action.action = wanted.action;
      action.scope = wanted.scope;
    }
    if (['update_record', 'delete_records', 'view_records'].includes(action.action)) action.kind = kind;
    if (action.action === 'delete_records' && action.scope === 'all') action.record = undefined;
    if (action.action === 'delete_records' && !action.scope) action.scope = 'one';
  }

  /** Vet every value, then work out what THIS operation still needs — and the one question that asks for it. */
  private complete(actions: PlannedAction[], graph: TaskGraph, earlier: SafetyFinding[] = []): RequirementDraft {
    const safety = this.safety();
    const findings: SafetyFinding[] = [];
    const unknown: Missing[] = [];
    this.route(actions, graph, findings);
    for (const action of actions) {
      if (action.patient && safety) {
        const vetted = safety.vetPatient(action.patient, action.action === 'select_patient' || (action.kind === 'patient' && action.action !== 'view_records'));
        if (vetted.finding) findings.push(vetted.finding);
        action.patient = vetted.value;
      }
      action.records = action.records.map((r, i) => {
        if (!safety) return r;
        const vetted = safety.vetRecord(r.kind, r.values, `${action.task} ${r.kind} ${i + 1}`);
        findings.push(...vetted.findings);
        return { kind: r.kind, values: vetted.values };
      });
      // A dose said once after a list of drugs is each drug's: the specialist is told it for every one.
      if (safety) {
        const meds = action.records.filter((r) => r.kind === 'medication').map((r) => r.values);
        findings.push(...safety.shareListDose(meds, `${action.task} medication`).map((f) => ({ ...f, tool: 'plan' })));
      }
      if (safety && Object.keys(action.patientDetails).length) {
        const vetted = safety.vetRecord('patient', action.patientDetails, `${action.task} new patient`);
        findings.push(...vetted.findings);
        action.patientDetails = vetted.values;
      }
      // Update / delete one: the record named must have been named by the provider; the changes, said.
      if (safety && action.record && action.kind && action.kind !== 'patient') {
        const vetted = safety.vetRecordName(action.kind, action.record, `${action.task} ${action.kind}`);
        if (vetted.finding) findings.push(vetted.finding);
        action.record = vetted.value;
      }
      if (safety && Object.keys(action.changes).length && action.kind) {
        const vetted = safety.vetRecord(action.kind, action.changes, `${action.task} change`);
        findings.push(...vetted.findings);
        // A change said but not usable as said ("gabapentin 500" — 500 what?): asked, not dropped.
        const lost = Object.keys(action.changes).filter((k) => !(k in vetted.values));
        if (lost.length && action.kind !== 'patient') unknown.push({ kind: action.kind as RecordKind, name: action.record, fields: lost });
        action.changes = vetted.values;
      }
      // Records with no patient reported, and exactly one patient named in the words: that patient (said, and on file).
      if (safety && !action.patient && ['add_records', 'update_record', 'delete_records', 'view_records'].includes(action.action) && action.kind !== 'patient') {
        const named = safety.namedPatients();
        if (named.length === 1 && named[0].id !== this.buildContext().currentPatientId) action.patient = named[0].fullName;
      }
      // A patient being changed or deleted IS the patient named.
      if (action.kind === 'patient' && (action.action === 'update_record' || action.action === 'delete_records') && !action.patient && action.record) action.patient = action.record;
      // "Create a task for Luke King" reported as a new patient Luke King — who is on file: the task is for him.
      if (safety && action.action === 'create_patient') {
        const d = action.patientDetails;
        const name = [d.firstName, d.lastName].filter((v) => v !== undefined && v !== '').join(' ');
        const onFile = name ? safety.whichPatient(name) : null;
        const task = graph.tasks.find((t) => t.id === action.task);
        const kinds = (task ? entitiesIn(task.instruction) : []).filter((k) => k !== 'patient') as RecordKind[];
        if (onFile && 'name' in onFile && onFile.name.toLowerCase() === name.toLowerCase() && kinds.length) {
          findings.push({ tool: 'plan', field: `${action.task} · operation`, value: 'create_patient', action: 'corrected', corrected: 'add_records', reason: `${onFile.name} is on file — the ${kinds.join(', ')} is for them` });
          action.action = 'add_records';
          action.patient = onFile.name;
          action.patientDetails = {};
          if (!action.records.length) action.records = kinds.map((kind) => ({ kind, values: {} }));
        }
      }
      // "Luke King, Tom Baker, Chloe Bell, and Zoe Hill" as one patient: each of them.
      if (safety && action.patient && /,|\band\b/.test(action.patient)) {
        const parts = action.patient.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((p) => p.trim()).filter(Boolean);
        const found = parts.map((p) => safety.whichPatient(p));
        if (parts.length > 1 && found.every((f) => f && 'name' in f)) {
          action.forPatients = found.map((f) => (f as { name: string }).name);
          action.patient = undefined;
        }
      }
      // Each record's own patient: who they are.
      if (safety) {
        for (const r of action.records) {
          if (typeof r.values.patient !== 'string') continue;
          const which = safety.whichPatient(r.values.patient);
          if (which && 'name' in which) r.values.patient = which.name;
          else if (which && 'ask' in which) unknown.push(which.ask);
        }
      }
      // Who the patient named is: one patient → their full name; nobody, or several → asked which.
      if (safety && action.patient) {
        const which = safety.whichPatient(action.patient);
        if (which && 'name' in which) action.patient = which.name;
        else if (which && 'ask' in which) {
          unknown.push(which.ask);
          action.patient = undefined;
          action.unresolved = true;
        }
      }
    }

    const chosen = this.patientChosen(actions, graph);
    // A patient asked about by name ("Which Ahmed?") is not asked about again as "which patient".
    const missing = actions.flatMap((a) =>
      missingFor(
        {
          operation: operationOf(a),
          kind: a.kind ?? (a.action === 'add_records' ? a.records[0]?.kind : undefined),
          patient: a.patient ?? (a.forPatients?.length ? a.forPatients.join(', ') : undefined),
          record: a.record,
          records: a.records,
          changes: a.changes,
          patientDetails: a.patientDetails,
        },
        chosen || !!a.unresolved || (a.records.length > 0 && a.records.every((r) => typeof r.values.patient === 'string')),
      ).filter((m) => !(a.unresolved && m.kind === 'select_patient')),
    );
    // Records split between agents are still one request for one patient: asked once, for all of them.
    const forRecords = missing.filter((m): m is Extract<Missing, { kind: 'record_patient' }> => m.kind === 'record_patient');
    if (forRecords.length > 1) {
      const of = [...new Set(forRecords.flatMap((m) => m.of ?? []))];
      missing.splice(0, missing.length, ...missing.filter((m) => m.kind !== 'record_patient'));
      missing.unshift({ kind: 'record_patient', of });
    }
    const listed = [...unknown, ...missing];
    const all = listed.filter((m, i) => listed.findIndex((x) => JSON.stringify(x) === JSON.stringify(m)) === i);
    // Asked: only what the provider's words hold no trace of. A dose, a drug, a date or a patient that IS in the
    // words but the model did not report is not the provider's to say again — the specialist takes it from the
    // words, and the Safety Agent checks it at the tool. The same question whatever the model.
    const unique = safety ? safety.unsaid(all, actions.map((a) => [a.patient, a.record, a.records.map((r) => r.values), a.changes, a.patientDetails])) : all;
    const approved: Record<string, string[]> = {};
    for (const action of actions) {
      const lines = this.approvedLines(action);
      if (lines.length) approved[action.task] = lines;
    }
    return { actions, missing: unique, question: unique.length ? questionFor(unique) : null, approved, findings: [...earlier, ...findings] };
  }

  /**
   * Records go to the agent that owns their kind (its skill's record-kinds): a medication the master handed to
   * the Patients Agent is the Medication Agent's task — it alone has the tools to add it.
   */
  private route(actions: PlannedAction[], graph: TaskGraph, findings: SafetyFinding[]) {
    for (const action of actions.filter((a) => a.split)) {
      const from = graph.tasks.find((t) => t.id === action.task);
      const kinds = action.action === 'add_records' ? action.records.map((r) => r.kind) : action.kind && action.kind !== 'patient' ? [action.kind as RecordKind] : [];
      const owner = kinds.length ? AGENT_NAMES.find((agent) => kinds.every((k) => agentRecordKinds(agent).includes(k))) : from?.agent;
      if (!from || !owner) continue;
      const added = graph.addAfter(from, { agent: owner, instruction: from.instruction });
      const origin = actions.find((a) => a.task === from.id && !a.split);
      if (origin) origin.notes = [...(origin.notes ?? []), `only the ${origin.action.replace('_', ' ')} part: the ${action.action.replace('_', ' ')} part is task ${added.id} (the ${owner} agent's) — do not do it`];
      findings.push({ tool: 'plan', field: `${from.id} · split`, value: from.instruction, action: 'corrected', corrected: `${from.id} ${origin?.action ?? ''} + ${added.id} ${action.action} (${owner})`, reason: 'two operations in one task' });
      action.task = added.id;
      action.agent = owner;
      action.split = false;
    }
    // Records of kinds that different agents own ("Metformin 500 mg and a task for BP monitoring"): each agent
    // adds its own, side by side — the records open together in one care plan, and one "yes" saves them all.
    for (const action of [...actions]) {
      if (action.action !== 'add_records' || action.records.length < 2) continue;
      const owners = [...new Set(action.records.map((r) => recordOwner(r.kind)).filter((a): a is AgentName => !!a))];
      const from = graph.tasks.find((t) => t.id === action.task);
      if (owners.length < 2 || !from) continue;
      const records = action.records;
      const keep = owners.includes(action.agent) ? action.agent : owners[0];
      const what = (rs: typeof records) => [...new Set(rs.map((r) => pluralOf(r.kind)))].join(' and ');
      action.records = records.filter((r) => recordOwner(r.kind) === keep);
      if (from.agent !== keep) {
        from.triedAgents = [...(from.triedAgents ?? []), from.agent];
        from.agent = keep;
      }
      action.agent = keep;
      const beside: string[] = [];
      for (const owner of owners.filter((o) => o !== keep)) {
        const added = graph.addBeside(from, { agent: owner, instruction: from.instruction, executionType: 'WRITE' });
        const mine = records.filter((r) => recordOwner(r.kind) === owner);
        actions.push({
          ...action,
          task: added.id,
          agent: owner,
          records: mine,
          patientDetails: { ...action.patientDetails },
          changes: { ...action.changes },
          forPatients: action.forPatients ? [...action.forPatients] : undefined,
          notes: [`only the ${what(mine)}: the ${what(action.records)} are task ${from.id}'s (the ${AGENT_TITLES[keep]}) — they open together in one care plan, saved with one confirmation`],
        });
        beside.push(`${added.id} ${what(mine)} (${owner})`);
      }
      action.notes = [...(action.notes ?? []), `only the ${what(action.records)}: ${beside.join(', ')} ${beside.length === 1 ? 'is' : 'are'} other agents' tasks — do not add them`];
      findings.push({ tool: 'plan', field: `${from.id} · split`, value: from.instruction, action: 'corrected', corrected: `${from.id} ${what(action.records)} (${keep}) + ${beside.join(' + ')}`, reason: 'each kind of record is its own agent’s — added side by side into one care plan' });
    }
    for (const action of actions) {
      const kinds = action.action === 'add_records' ? action.records.map((r) => r.kind) : action.kind && action.kind !== 'patient' && ['update_record', 'delete_records', 'view_records'].includes(action.action) ? [action.kind as RecordKind] : [];
      if (!kinds.length) continue;
      const owns = (agent: AgentName) => kinds.every((k) => agentRecordKinds(agent).includes(k));
      if (owns(action.agent)) continue;
      const owner = AGENT_NAMES.find(owns);
      const task = graph.tasks.find((t) => t.id === action.task);
      if (!owner || !task) continue;
      findings.push({ tool: 'plan', field: `${action.task} · agent`, value: action.agent, action: 'corrected', corrected: owner, reason: `the ${kinds.join(', ')} records are the ${owner} agent's` });
      task.triedAgents = [...(task.triedAgents ?? []), task.agent];
      task.agent = owner;
      action.agent = owner;
    }
  }

  /** What the specialist is told it has — the operation itself first, so it calls the right tool with nothing more. */
  private approvedLines(action: PlannedAction): string[] {
    const lines: string[] = [];
    const op = operationOf(action);
    const kind = action.kind;
    if (op === 'delete_all' && kind) lines.push(`operation: delete ALL of the patient's ${pluralOf(kind)} — delete_record with all: true (no record, no field)`);
    else if (op === 'delete_one' && kind) lines.push(`operation: delete one ${kind}${action.record ? ` — record: ${action.record}` : ''}`);
    else if (op === 'update' && kind) lines.push(`operation: change one ${kind}${action.record ? ` — record: ${action.record}` : ''} — only the fields below; nothing else is asked or changed`);
    else if (op === 'view' && kind) lines.push(`operation: show the patient's ${pluralOf(kind)}`);
    if (action.patient) lines.push(`patient: ${action.patient}`);
    if (action.forPatients?.length) lines.push(`for each of the patients: ${action.forPatients.join(', ')} (for_patients)`);
    if (op === 'update') for (const [k, v] of Object.entries(action.changes)) lines.push(`change: ${k} = ${show(v)}`);
    action.records.forEach((r, i) => lines.push(`${r.kind} ${i + 1}: ${Object.entries(r.values).map(([k, v]) => `${k} = ${show(v)}`).join(', ') || '(nothing said)'}`));
    if (Object.keys(action.patientDetails).length) lines.push(`new patient: ${Object.entries(action.patientDetails).map(([k, v]) => `${k} = ${show(v)}`).join(', ')}`);
    if (isDestructive(op)) lines.push('confirmation: required — the app shows what will be deleted and the provider confirms; never confirm it yourself');
    for (const note of action.notes ?? []) lines.push(note);
    return lines;
  }

  private submitTool() {
    const record = z.object({
      kind: z.enum(RECORD_KINDS),
      values: z.record(z.string(), scalar).optional().describe('Only the values the provider SAID for this record, under the FIELDS names — never one they did not say'),
    });
    return defineTool({
      name: SUBMIT_TOOL,
      description:
        'Report what the provider SAID each task needs: the operation, the patient they named, and — by operation — the records to add (only the values said), the record to change and only the fields being changed, the record to delete or that ALL are deleted. Leave out everything not said — the app asks the provider for it.',
      parameters: z.object({
        tasks: z.array(
          z.object({
            task: z.string().optional().describe('The task id (t1, t2 …) from TASKS — always give it'),
            action: z.enum(ACTION_KINDS),
            patient: z.string().optional().describe('The patient exactly as SAID, when the provider named one for this task; leave out when not said'),
            kind: z.enum([...RECORD_KINDS, 'patient']).optional().describe('update_record / delete_records / view_records: the kind of record'),
            record: z.string().optional().describe('update_record / delete_records (one): the record as SAID ("Gabapentin")'),
            scope: z.enum(['one', 'all']).optional().describe('delete_records: all when the provider said all / every ("delete all medications") — then no record'),
            changes: z.record(z.string(), scalar).optional().describe('update_record: ONLY the fields being changed, with the new value SAID ({"frequency": "twice daily"})'),
            records: z.array(record).optional().describe('add_records: one entry per record asked for — also when nothing about it was said ("add medication": kind medication, no values)'),
            values: z.record(z.string(), scalar).optional().describe('Shorthand for ONE record: its values (with kind) instead of records'),
            patient_details: z.record(z.string(), scalar).optional().describe("create_patient: the new patient's details SAID"),
          }),
        ),
      }),
      progress: () => 'Working out what each action needs…',
      normalize: (raw) => normalizeReport(raw) as Record<string, unknown>,
      run: async (args) => {
        this.submitted = args;
        return { ok: true, message: 'Requirements received.', final: true };
      },
    });
  }

  private notAnAnswerTool() {
    return defineTool({
      name: NOT_AN_ANSWER_TOOL,
      description: 'SAID does not answer the question asked — the provider asked for something else.',
      parameters: z.object({}),
      run: async () => {
        this.declined = true;
        return { ok: true, message: 'Not an answer.', final: true };
      },
    });
  }
}

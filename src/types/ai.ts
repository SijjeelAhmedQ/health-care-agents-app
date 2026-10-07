/**
 * Types shared by the assistant: the model decides what to do by calling
 * tools (services/ai/agent/tools.ts); these are the shapes that flow between
 * the model, the agent loop, the tool runtime and the UI.
 */
import type { EntityKind } from './records';

export type FieldValues = Record<string, string | number | boolean>;

/** Kept as a name for the entities the assistant can create, update and delete. */
export type AIRecordKind = EntityKind;

/** One tool call the model made. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What a tool reports back — to the model (as the tool message) and to the UI trace. */
export interface ToolResult {
  ok: boolean;
  /** What happened, in plain words. The model reads this; a question or confirmation is shown to the user as is. */
  message: string;
  /** Structured data for the model: lists of records, patients, the provider's day… */
  data?: unknown;
  /**
   * The application is now waiting for the user — a question about a missing value or a
   * confirmation before saving/deleting. The turn ends and `message` is the reply.
   */
  awaitUser?: boolean;
  /**
   * The turn is over and `message` is the reply — nothing can follow it in the same turn
   * (the model itself is being replaced, or the provider signed out).
   */
  final?: boolean;
  /** The reply to this turn is worth hearing (information the user asked for, a question). */
  speak?: boolean;
  fieldsModified?: Array<{ formId: string; field: string; value: string }>;
}

/** A snapshot of where the user is, given to the model with every utterance. */
export interface AIContext {
  today: string;
  /** The next seven dates with their weekdays, so "next Tuesday" resolves without arithmetic. */
  nextDays: string;
  /** Dates weeks and months ahead ("in two weeks", "in 3 months"), for the same reason. */
  laterDates: string;
  now: string;
  providerName: string | null;
  currentPageId: string | null;
  currentPageTitle: string | null;
  currentPatientId: string | null;
  currentPatientName: string | null;
  /** The open dialog/form and what it holds. */
  openForm: { id: string; values: Record<string, unknown>; entries: number } | null;
  /** The question the assistant asked and is waiting on. */
  pendingQuestion: { formId: string; field: string; question: string } | null;
  /** What saying "yes" would do right now. */
  pendingConfirmation: { kind: PendingConfirmation['kind']; description: string } | null;
  /** The Inbox, when it is on screen. */
  inbox: { view: string; items: number; openItem: string | null; query: string } | null;
  /** The patient search on screen (Patients page). */
  patientSearch: { query: string; results: number } | null;
  /** The list (table) on screen: what it shows and how it can be filtered. */
  list: { name: string; shown: number; total: number; page: number; pageCount: number; search: string; filters: Record<string, string>; filterable: string } | null;
  /** Items extracted in the AI Summary, waiting to be added. */
  extracted: string | null;
  /** The Care Plan dialog, when open: its records by kind. */
  carePlan: string | null;
}

/**
 * Something that will change data once the user confirms it: saving a form, or
 * deleting a record. Nothing destructive happens until it is confirmed.
 */
export interface PendingConfirmation {
  /** 'form' = save what is in the open form. 'delete' = remove an existing record. 'inbox_file' = file / unfile Inbox items. */
  kind: 'form' | 'delete' | 'inbox_file';
  /** Form id for a save; record kind for a delete. */
  formId: string;
  formTitle: string;
  summary: Array<{ label: string; value: string }>;
  description: string;
  recordKind?: AIRecordKind;
  recordId?: string;
  /** Delete ALL of a patient's records of one kind: every id, deleted together on one confirmation. */
  recordIds?: string[];
  /** Inbox items to file or unfile (kind 'inbox_file'). */
  inboxItemIds?: string[];
  /** True to file, false to move back to unfiled (kind 'inbox_file'). */
  inboxFile?: boolean;
}

/**
 * One action of a long request that was split into steps ("go to patients, select James, add … a task … a
 * recall … an appointment"), carried out one after another. Shown to the provider as progress only.
 */
export interface PlanStep {
  text: string;
  /**
   * 'waiting' = done, and it left a question or a confirmation for the provider. 'failed' / 'cancelled':
   * multi-agent mode only — the task could not be done, or was dropped (the provider said no, or what it
   * needed failed).
   */
  status: 'pending' | 'running' | 'done' | 'waiting' | 'failed' | 'cancelled';
  /** Multi-agent mode: the task this step shows, and the specialist carrying it out. */
  taskId?: string;
  agent?: AgentName;
}

/** Where a step ran, in multi-agent mode: the master, the Planning Agent, or a specialist carrying out a task. */
export interface StepOrigin {
  agent?: 'master' | 'planning' | AgentName;
  taskId?: string;
}

/**
 * What the Safety Agent did with one value of a tool call: removed it (nobody said it), corrected it from
 * what was said, or asked the provider for it instead of running the call.
 */
export interface SafetyFinding {
  tool: string;
  /** "medication 1 · dosage", "patient", "text" … */
  field: string;
  value: string;
  action: 'removed' | 'corrected' | 'asked';
  reason: string;
  /** The value it was corrected to, from the provider's own words. */
  corrected?: string;
}

/** One step of an agent turn, for the trace and the debug panel. */
export type AgentStep =
  | ({ id: string; type: 'model'; startedAt: number; finishedAt?: number; content?: string; toolCalls?: ToolCall[]; error?: string } & StepOrigin)
  | ({ id: string; type: 'tool'; startedAt: number; finishedAt?: number; call: ToolCall; result?: ToolResult; safety?: SafetyFinding[] } & StepOrigin);

// ------------------------------------------------------------------ multi-agent mode

/** The specialists of the multi-agent mode (services/ai/agents) — one Agent Skill each (src/agents). */
export type AgentName =
  | 'patients'
  | 'dashboard'
  | 'appointments'
  | 'patient_appointments'
  | 'medications'
  | 'diagnoses'
  | 'tasks'
  | 'recalls'
  | 'notes'
  | 'summary'
  | 'inbox';

/**
 * How a task may be scheduled. READ_ONLY: reads only — may run beside other read-only tasks. CONTEXT:
 * changes what is on screen or selected (page, patient, open form) — one at a time. WRITE: creates,
 * changes, deletes, files, schedules or cancels — one at a time, through the runtime's confirmation.
 */
export type ExecutionType = 'READ_ONLY' | 'CONTEXT' | 'WRITE';

export type TaskStatus = 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'WAITING_FOR_USER' | 'CANCELLED';

/** What a finished task hands to the tasks that depend on it — structured, never only prose. */
export interface TaskResultData {
  /** The selected patient once the task was done (a task that found or selected one). */
  patientId?: string;
  patientName?: string;
  /** The data of the task's last successful tool call, trimmed. */
  data?: unknown;
  /** What the specialist said. */
  reply?: string;
}

/** One task of the master's task graph. */
export interface AgentTask {
  id: string;
  agent: AgentName;
  instruction: string;
  dependsOn: string[];
  executionType: ExecutionType;
  status: TaskStatus;
  result?: TaskResultData;
  error?: string;
  retryCount: number;
  /** Agents that already had the task (a reassigned task lists where it was before). */
  triedAgents?: AgentName[];
  /** What the provider is being asked (a question or a confirmation), while WAITING_FOR_USER. */
  waitingFor?: string;
  /** The execution type the master gave, when the scheduler had to make it stricter. */
  declaredType?: ExecutionType;
  /** The model the specialist ran it on (Configuration → Agents), e.g. "vllm:qwen3.5:9b". */
  model?: string;
  /**
   * What the Planning Agent gathered for it and the Safety Agent approved ("medication 1: medicationName =
   * Metformin, dosage = 500 mg") — the specialist uses exactly these.
   */
  requirements?: string[];
  /** A task split off this one by the Planning Agent, running beside it (its records join the same care plan). */
  splitFrom?: string;
  /**
   * Its records were added to another task's open care plan: that task's confirmation saves them too, and
   * this one finishes with it.
   */
  joinedInto?: string;
}

/** The authoritative task graph of a request, as the assistant panel and the debug panel show it. */
export interface TaskGraphSnapshot {
  id: string;
  /** What the provider said. */
  request: string;
  /** 'fast': one task, routed by the master with no planning; 'planned': a task graph. */
  route: 'fast' | 'planned';
  tasks: AgentTask[];
  createdAt: number;
  finishedAt?: number;
}

export interface DebugTrace {
  transcript: string;
  provider: string;
  /** The CONTEXT block the model received with the utterance. */
  context: string;
  steps: AgentStep[];
  /** Multi-agent mode: the task graph the request ran as. */
  graph?: TaskGraphSnapshot;
  reply?: string;
  fieldsModified: Array<{ formId: string; field: string; value: string }>;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** Structured information the model extracted from a dictated clinical note. */
export interface ExtractedItem {
  /** Fields matching the target form's field names, ready to review and save. */
  fields: FieldValues;
  /** The words in the note this came from — shown so the user can check the AI. */
  quote?: string;
}

export interface ExtractionResult {
  transcript: string;
  provider: string;
  items: Record<Exclude<AIRecordKind, 'patient'>, ExtractedItem[]>;
  /** Anything the model was unsure about — surfaced instead of guessed. */
  questions: string[];
}

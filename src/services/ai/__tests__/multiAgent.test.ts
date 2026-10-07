/**
 * The multi-agent mode against a runtime of spies: routing, task graphs, dependencies, execution types,
 * parallel reads, retries, reassignment, waiting on the provider across turns — and that the master never
 * holds a domain tool. The model is scripted per agent: each call is answered from the script of the
 * agent whose system prompt it carries.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentName, AIContext, ToolCall, ToolResult } from '@/types/ai';
import type { ChatLLM, ChatMessage, ChatTurn, ToolSchema } from '../providers/llm';
import type { AppRuntime } from '../agent/runtime';
import { buildTools } from '../agent/tools';
import { toToolSchema } from '../agent/tool';
import { MultiAgentOrchestrator, type MultiAgentHooks } from '../agents/master';
import { MASTER_TOOLS, specialistTools, TOOL_EXECUTION } from '../agents/specialists';
import { AGENT_NAMES } from '../agents/taskGraph';
import { call } from './fakes';

type Who = 'master' | AgentName;
type Reply = { content?: string; calls?: ToolCall[] };
type Turn = Reply | ((messages: ChatMessage[]) => Reply | Promise<Reply>);

const WHO: Array<[RegExp, Who]> = [
  [/^You are the master agent/, 'master'],
  [/You are the Patients Agent/, 'patients'],
  [/You are the Dashboard Agent/, 'dashboard'],
  [/You are the My Appointment Agent/, 'appointments'],
  [/You are the Appointments Agent/, 'patient_appointments'],
  [/You are the Medication Agent/, 'medications'],
  [/You are the Diagnoses Agent/, 'diagnoses'],
  [/You are the Tasks Agent/, 'tasks'],
  [/You are the Recalls Agent/, 'recalls'],
  [/You are the Notes Agent/, 'notes'],
  [/You are the Summary Agent/, 'summary'],
  [/You are the Inbox Agent/, 'inbox'],
];

/** A model scripted per agent. An agent with nothing left to say replies "<agent> done." */
class RoutedLLM implements ChatLLM {
  readonly name = 'routed';
  readonly log: Array<{ who: Who; messages: ChatMessage[]; tools: string[] }> = [];
  private scripts = new Map<Who, Turn[]>();
  private active = 0;
  maxActive = 0;
  constructor(private readonly delayMs = 0) {}

  script(who: Who, ...turns: Turn[]) {
    this.scripts.set(who, [...(this.scripts.get(who) ?? []), ...turns]);
    return this;
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[]): Promise<ChatTurn> {
    const system = String(messages[0]?.content ?? '');
    const who = WHO.find(([re]) => re.test(system))?.[1];
    if (!who) throw new Error('unknown agent');
    this.log.push({ who, messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.function.name) });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const next = this.scripts.get(who)?.shift();
      if (!next) return { content: `${who} done.`, toolCalls: [] };
      const turn = typeof next === 'function' ? await next(messages) : next;
      return { content: turn.content ?? '', toolCalls: turn.calls ?? [] };
    } finally {
      this.active--;
    }
  }

  /** The user messages one agent received, in order. */
  said(who: Who) {
    return this.log.filter((l) => l.who === who).map((l) => String(l.messages.at(-1)?.role === 'user' ? l.messages.at(-1)!.content : l.messages.find((m, i) => i > 2 && m.role === 'user')?.content ?? ''));
  }

  calls(who?: Who) {
    return who ? this.log.filter((l) => l.who === who).length : this.log.length;
  }
}

const baseContext = (): AIContext => ({
  today: '2026-09-30 (Wednesday)',
  nextDays: 'Thu 2026-10-01, Fri 2026-10-02',
  laterDates: '1 week 2026-10-07',
  now: '10:30',
  providerName: 'Dr. Lucy White',
  currentPageId: 'dashboard',
  currentPageTitle: 'Dashboard',
  currentPatientId: null,
  currentPatientName: null,
  openForm: null,
  pendingQuestion: null,
  pendingConfirmation: null,
  inbox: null,
  patientSearch: null,
  list: null,
  extracted: null,
  carePlan: null,
});

const ok = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, message, ...extra });

/** A runtime of spies over a context the spies change, like the real one changes the app. */
function setup(llm: RoutedLLM, options: { parallelReads?: boolean; overrides?: Record<string, unknown> } = {}) {
  const ctx = baseContext();
  const stage = (description: string) => {
    ctx.pendingConfirmation = { kind: 'form', description };
    return ok(`${description} — please confirm or cancel.`, { awaitUser: true, speak: true });
  };
  const runtime = {
    beginTurn: vi.fn(),
    endTurn: vi.fn(),
    selectPatient: vi.fn(async ({ patient }: { patient?: string }) => {
      ctx.currentPatientId = 'pat-7';
      ctx.currentPatientName = patient ?? 'John Ahmed';
      return ok(`${patient} is now the selected patient.`);
    }),
    searchPatients: vi.fn(async (q: string) => ok(`1 patient matches "${q}".`, { data: [{ id: 'pat-7', name: 'John Ahmed' }] })),
    providerOverview: vi.fn(() => ok('Schedule and work queue.', { speak: true, data: { today: [] } })),
    inboxShow: vi.fn(async () => ok('The Inbox shows 3 lab results.', { data: [{ position: 1, subject: 'HbA1c' }] })),
    inboxOpen: vi.fn(async () => ok('HbA1c 6.1 % — normal.', { data: { subject: 'HbA1c' } })),
    createRecords: vi.fn(async (kind: string) => stage(`Save the new ${kind}`)),
    addCarePlan: vi.fn(async () => stage('Save the care plan')),
    confirm: vi.fn(async () => {
      const was = ctx.pendingConfirmation;
      ctx.pendingConfirmation = null;
      return was ? ok(`${was.description}: saved.`) : { ok: false, message: 'Nothing is waiting for confirmation.' };
    }),
    cancel: vi.fn(() => {
      ctx.pendingConfirmation = null;
      return ok('Cancelled — nothing was saved.');
    }),
    myAppointments: vi.fn(async () => ok('You have 2 appointments today.', { data: [{ id: 'a1' }, { id: 'a2' }] })),
    cancelAppointment: vi.fn(async () => stage('Cancel the appointment')),
    // New records wait in a form for the provider's yes — another agent's records may join them.
    recordsWaiting: vi.fn(() => ctx.pendingConfirmation?.kind === 'form'),
    findPatient: vi.fn((raw: string) => ({ name: raw, options: [] })),
    summaryOf: vi.fn(async (what: string) => ({
      result: ok('The summary of normal Inbox records (All patients · 5 records) is open in the Summary panel.', { data: { summary: '5 normal records.' } }),
      outcome: { title: 'Normal Inbox records', scope: 'All patients · 5 records', text: `Summary of: ${what}`, source: 'model', empty: false, model: { name: 'routed', answer: '5 normal records.' } },
    })),
    ...options.overrides,
  } as unknown as AppRuntime;
  const orchestrator = new MultiAgentOrchestrator(llm, runtime, () => ({ ...ctx }), { maxSteps: 6, parallelReads: options.parallelReads });
  orchestrator.setTools(buildTools());
  const graphs: Array<ReturnType<NonNullable<MultiAgentHooks['onGraph']>> | unknown> = [];
  const hooks: MultiAgentHooks = { onGraph: (g) => graphs.push(g) };
  return { ctx, runtime, orchestrator, hooks };
}

const assign = (tasks: Array<Record<string, unknown>>) => ({ calls: [call('assign_tasks', { tasks })] });

describe('who holds which tools', () => {
  const all = buildTools();
  const names = (agent: (typeof AGENT_NAMES)[number]) => specialistTools(agent, all).map((t) => t.name);
  const schemaOf = (agent: (typeof AGENT_NAMES)[number], tool: string) => toToolSchema(specialistTools(agent, all).find((t) => t.name === tool)!).function.parameters as Record<string, any>;

  it('the master has no domain tool — only orchestration and the application itself', () => {
    const llm = new RoutedLLM();
    const { orchestrator } = setup(llm);
    const master = orchestrator.master.toolNames;
    expect(master).toContain('assign_tasks');
    for (const domain of ['create_patient', 'delete_patient', 'add_medications', 'add_appointments', 'add_care_plan', 'inbox_file_item', 'update_record', 'select_patient', 'fill_open_form', 'confirm_pending_action']) {
      expect(master).not.toContain(domain);
    }
    expect(master.length).toBe(MASTER_TOOLS.length + 1);
  });

  it('every specialist has only its own tools, plus the shared ones — far fewer than the single assistant', () => {
    expect(names('patients')).toEqual(expect.arrayContaining(['search_patients', 'select_patient', 'clear_selected_patient', 'create_patient', 'edit_patient', 'delete_patient']));
    expect(names('patients')).not.toContain('add_medications');
    expect(names('dashboard')).toEqual(expect.arrayContaining(['get_provider_overview', 'dashboard_summary_panel', 'control_list']));
    expect(names('inbox')).toEqual(expect.arrayContaining(['inbox_show', 'inbox_open_item', 'inbox_file_item', 'inbox_add_comment', 'inbox_select_item_patient']));
    for (const agent of AGENT_NAMES.filter((a) => a !== 'summary')) {
      expect(names(agent)).toContain('not_my_task');
      expect(names(agent)).toContain('confirm_pending_action');
      expect(names(agent).length).toBeLessThan(all.length / 2);
    }
    // The Summary Agent only writes summaries: no tools at all — so any model can run it (MedGemma calls none).
    expect(names('summary')).toEqual([]);
  });

  it('each kind of record has one agent: medications, diagnoses, tasks, recalls and patients\' appointments — the provider\'s own appointments are the My Appointment Agent\'s', () => {
    expect(names('appointments')).toEqual(expect.arrayContaining(['list_my_appointments', 'cancel_my_appointment', 'reschedule_my_appointment']));
    for (const tool of ['add_appointments', 'cancel_patient_appointment', 'reschedule_patient_appointment', 'update_record', 'list_records']) expect(names('appointments')).not.toContain(tool);
    expect(names('patient_appointments')).toEqual(expect.arrayContaining(['add_appointments', 'cancel_patient_appointment', 'reschedule_patient_appointment', 'update_record', 'delete_record', 'list_records']));
    expect(names('patient_appointments')).not.toContain('list_my_appointments');
    const owners: Array<[AgentName, string, string]> = [
      ['medications', 'add_medications', 'medication'],
      ['diagnoses', 'add_diagnoses', 'diagnosis'],
      ['tasks', 'add_tasks', 'task'],
      ['recalls', 'add_recalls', 'recall'],
      ['patient_appointments', 'add_appointments', 'appointment'],
    ];
    for (const [agent, add, kind] of owners) {
      expect(names(agent)).toContain(add);
      for (const [other, otherAdd] of owners) if (other !== agent) expect(names(agent)).not.toContain(otherAdd);
      for (const tool of ['update_record', 'delete_record', 'list_records']) expect(schemaOf(agent, tool).properties.kind.enum).toEqual([kind]);
      expect(schemaOf(agent, 'list_records').properties.search).toBeDefined(); // search and get
      expect(names(agent)).not.toContain('add_care_plan'); // the care plan is put together by the scheduler
    }
    expect(names('notes')).toEqual(expect.arrayContaining(['take_clinical_note', 'add_extracted_item']));
  });

  it('unfiling is the existing inbox_file_item with file=false — no second tool for it', () => {
    expect(names('inbox').filter((n) => n.includes('unfile'))).toEqual([]);
    expect(schemaOf('inbox', 'inbox_file_item').properties.file.type).toBe('boolean');
  });

  it('every tool of the app has an execution type, and every one but the extraction/planning tools has an owner', () => {
    const owned = new Set([...AGENT_NAMES.flatMap((a) => names(a)), ...MASTER_TOOLS]);
    // The single assistant's own: extraction and planning, its summary tool and add_care_plan (in multi-agent mode
    // the Summary Agent writes summaries without tools, and the care plan is put together from each agent's records).
    const singleOnly = new Set(['record_note_findings', 'plan_steps', 'summarize', 'get_patient_summary', 'add_care_plan']);
    for (const tool of all) {
      if (singleOnly.has(tool.name)) {
        expect(TOOL_EXECUTION[tool.name] ?? (tool.name === 'record_note_findings' || tool.name === 'plan_steps' ? 'n/a' : undefined), tool.name).toBeDefined();
        continue;
      }
      expect(TOOL_EXECUTION[tool.name], tool.name).toBeDefined();
      expect(owned.has(tool.name), tool.name).toBe(true);
    }
  });
});

describe('the master and its specialists', () => {
  it('fast path: a simple request is one task, and the specialist gets the provider’s own words', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'appointments', instruction: 'List today appointments', execution: 'READ_ONLY' }]))
      .script('appointments', { calls: [call('list_my_appointments', { when: 'today' })] }, { content: 'You have 2 appointments today.' });
    const { orchestrator, runtime, hooks } = setup(llm);
    const outcome = await orchestrator.run("Show today's appointments.", hooks);
    expect(outcome.reply).toBe('You have 2 appointments today.');
    expect(runtime.myAppointments).toHaveBeenCalledWith({ when: 'today' });
    expect(orchestrator.activeGraph?.route).toBe('fast');
    expect(orchestrator.activeGraph?.tasks[0].status).toBe('COMPLETED');
    // Two model calls for the request itself (master, specialist) and one for the specialist's reply.
    expect(llm.calls('master')).toBe(1);
    const task = String(llm.log.find((l) => l.who === 'appointments')!.messages.at(-1)!.content);
    expect(task).toMatch(/SAID: Show today's appointments\.$/);
    expect(task).not.toContain('REQUEST:');
    // The specialist was given its own tools only.
    expect(llm.log.find((l) => l.who === 'appointments')!.tools).not.toContain('add_medications');
    // One runtime turn around everything done for the utterance.
    expect(runtime.beginTurn).toHaveBeenCalledTimes(1);
    expect(runtime.endTurn).toHaveBeenCalledTimes(1);
  });

  it('the master answers small talk, or does the application things itself — no graph', async () => {
    const llm = new RoutedLLM().script('master', { content: 'Good morning!' });
    const { orchestrator } = setup(llm);
    expect((await orchestrator.run('good morning')).reply).toBe('Good morning!');
    expect(orchestrator.activeGraph).toBeNull();

    llm.script('master', { calls: [call('wait_for_more_speech')] });
    expect((await orchestrator.run('add metformin to')).deferred).toBe(true);
  });

  it('dependencies: find John first; the lab report and the appointment both get his id as structured results', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { id: 't1', agent: 'patients', instruction: 'Find and select John Ahmed', execution: 'CONTEXT' },
          { id: 't2', agent: 'inbox', instruction: "Open John Ahmed's latest lab report", depends_on: ['t1'], execution: 'READ_ONLY' },
          { id: 't3', agent: 'patient_appointments', instruction: 'Schedule an appointment for John Ahmed tomorrow at 3 PM', depends_on: ['t1'], execution: 'WRITE' },
        ]),
      )
      .script('patients', { calls: [call('select_patient', { patient: 'John Ahmed' })] }, { content: 'John Ahmed is selected.' })
      .script('inbox', { calls: [call('inbox_show', { category: 'lab', scope: 'selected_patient' })] }, { calls: [call('inbox_open_item', { target: 1 })] }, { content: 'His latest HbA1c is 6.1 %, normal.' })
      .script('patient_appointments', { calls: [call('add_appointments', { appointments: [{ patient: 'John Ahmed', date: '2026-10-01', startTime: '15:00' }] })] }, { content: 'The appointment is ready — please confirm.' });
    const { orchestrator, runtime } = setup(llm);
    const outcome = await orchestrator.run('Find John Ahmed, check his latest lab report and schedule an appointment for tomorrow at 3 PM');

    const graph = orchestrator.activeGraph!;
    expect(graph.tasks.map((t) => [t.id, t.agent, t.dependsOn, t.status])).toEqual([
      ['t1', 'patients', [], 'COMPLETED'],
      // The lab report waits: the appointment's confirmation came on screen before it could open it — it opens
      // once the provider has answered (it is never marked done having only listed the Inbox).
      ['t2', 'inbox', ['t1'], 'PENDING'],
      ['t3', 'patient_appointments', ['t1'], 'WAITING_FOR_USER'],
    ]);
    expect(graph.tasks[0].result).toMatchObject({ patientId: 'pat-7', patientName: 'John Ahmed' });
    // Structured results, not prose: both dependents were told the id.
    for (const who of ['inbox', 'patient_appointments'] as const) {
      const first = String(llm.log.find((l) => l.who === who)!.messages.at(-1)!.content);
      expect(first).toContain('RESULTS FROM EARLIER TASKS');
      expect(first).toContain('patientId=pat-7');
      expect(first).toContain('REQUEST: Find John Ahmed');
      expect(first).toMatch(/request: step \d of 3/);
    }
    // The order: t1, then t2 (read-only), then t3 (a write, alone).
    expect(llm.log.map((l) => l.who).filter((w) => w !== 'master')[0]).toBe('patients');
    expect(runtime.createRecords).toHaveBeenCalledTimes(1);
    // One reply: what was done, then the open confirmation last (in the specialist's words, which name it).
    expect(outcome.awaitingUser).toBe(true);
    expect(outcome.reply).toBe('John Ahmed is selected. The appointment is ready — please confirm.');
  });

  it('WAITING_FOR_USER survives the turn: "yes" goes straight to the waiting task (no master call), which completes', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'patient_appointments', instruction: 'Schedule John tomorrow at 3 PM', execution: 'WRITE' }]))
      .script('patient_appointments', { calls: [call('add_appointments', { appointments: [{ patient: 'John Ahmed', date: '2026-10-01', startTime: '15:00' }] })] }, { content: 'Ready — please confirm.' });
    const { orchestrator, runtime } = setup(llm);
    const first = await orchestrator.run("Schedule John's appointment tomorrow at 3 PM");
    expect(first.awaitingUser).toBe(true);
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('WAITING_FOR_USER');
    expect(orchestrator.activeGraph!.tasks[0].waitingFor).toMatch(/confirm/);

    llm.script('patient_appointments', { calls: [call('confirm_pending_action')] }, { content: 'The appointment is booked.' });
    const second = await orchestrator.run('yes');
    expect(llm.calls('master')).toBe(1); // the answer did not go through the master again
    expect(runtime.confirm).toHaveBeenCalledTimes(1);
    expect(second.reply).toBe('The appointment is booked.');
    expect(second.awaitingUser).toBe(false);
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('COMPLETED');
    const resumed = String(llm.log.filter((l) => l.who === 'patient_appointments')[2].messages.at(-1)!.content);
    expect(resumed).toContain('YOUR TASK (t1): Schedule John tomorrow at 3 PM');
    expect(resumed).toMatch(/SAID: yes$/);
    // A new turn for the answer: the confirmation was staged in the earlier one, so it may be confirmed now.
    expect(runtime.beginTurn).toHaveBeenCalledTimes(2);
    expect((runtime.beginTurn as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toBe((runtime.beginTurn as ReturnType<typeof vi.fn>).mock.calls[1][0]);
  });

  it('a medication, a task and a follow-up — three agents, ONE care plan and ONE confirmation: the records join what waits for the yes', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg twice daily', execution: 'WRITE' },
          { agent: 'tasks', instruction: 'Add a task for blood pressure monitoring', execution: 'WRITE' },
          { agent: 'patient_appointments', instruction: 'Book a follow-up next Tuesday at 3 pm', execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Medication ready.' })
      .script('tasks', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] }, { content: 'Added the task to the care plan.' })
      .script('patient_appointments', { calls: [call('add_appointments', { appointments: [{ date: '2026-10-06', startTime: '15:00', reason: 'Follow-up' }] })] }, { content: 'The care plan has the medication, the task and the follow-up — please confirm.' });
    const { orchestrator, runtime } = setup(llm);
    const first = await orchestrator.run('add metformin 500 mg twice daily and a task for blood pressure monitoring, and a follow-up next Tuesday at 3 pm');
    let [t1, t2, t3] = orchestrator.activeGraph!.tasks;
    // Each agent added its own records while the first ones waited for the yes: they are one care plan now.
    expect(runtime.createRecords).toHaveBeenCalledTimes(3);
    expect((runtime.createRecords as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['medication', 'task', 'appointment']);
    expect([t1.status, t2.status, t3.status]).toEqual(['WAITING_FOR_USER', 'WAITING_FOR_USER', 'WAITING_FOR_USER']);
    expect([t1.joinedInto, t2.joinedInto, t3.joinedInto]).toEqual(['t3', 't3', undefined]);
    // One question for the provider: the last agent's, which holds the whole care plan.
    expect(first.reply).toBe('The care plan has the medication, the task and the follow-up — please confirm.');

    // One "yes" saves all of it, and every task that joined finishes with it.
    llm.script('patient_appointments', { calls: [call('confirm_pending_action')] }, { content: 'The care plan is saved — 3 records.' });
    const second = await orchestrator.run('yes');
    [t1, t2, t3] = orchestrator.activeGraph!.tasks;
    expect(runtime.confirm).toHaveBeenCalledTimes(1);
    expect([t1.status, t2.status, t3.status]).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(second).toMatchObject({ reply: 'The care plan is saved — 3 records.', awaitingUser: false });
    expect(llm.calls('master')).toBe(1);
  });

  it('the record agents of one request think AT THE SAME TIME — each adds to the screen in turn — into one care plan', async () => {
    const llm = new RoutedLLM(80)
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg twice daily', execution: 'WRITE' },
          { agent: 'diagnoses', instruction: 'Add hypertension as a diagnosis', execution: 'WRITE' },
          { agent: 'tasks', instruction: 'Add a task for blood pressure monitoring', execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Medication ready.' })
      .script('diagnoses', { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] }, { content: 'Diagnosis added.' })
      .script('tasks', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] }, { content: 'The care plan is ready — please confirm.' });
    const order: string[] = [];
    let stagedOnce = false;
    const { orchestrator, ctx } = setup(llm, {
      overrides: {
        createRecords: vi.fn(async (kind: string) => {
          order.push(`${kind}:start`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`${kind}:end`);
          ctx.pendingConfirmation = { kind: 'form', description: stagedOnce ? 'Save the care plan' : `Save the new ${kind}` };
          stagedOnce = true;
          return ok(`${kind} added — please confirm or cancel.`, { awaitUser: true, speak: true });
        }),
      },
    });
    const started = Date.now();
    const outcome = await orchestrator.run('add metformin 500 mg twice daily, hypertension as a diagnosis and a task for blood pressure monitoring');
    const took = Date.now() - started;
    // The three agents' models were asked at once…
    expect(llm.maxActive).toBeGreaterThanOrEqual(3);
    // …while the screen took one addition at a time — never two overlapping.
    expect(order).toHaveLength(6);
    for (let i = 0; i < order.length; i += 2) expect(order[i].replace(':start', '')).toBe(order[i + 1].replace(':end', ''));
    // One care plan, one confirmation: every task waits on the one that put records up last.
    const tasks = orchestrator.activeGraph!.tasks;
    expect(tasks.every((t) => t.status === 'WAITING_FOR_USER')).toBe(true);
    const lead = tasks.find((t) => !t.joinedInto)!;
    expect(tasks.filter((t) => t.joinedInto === lead.id)).toHaveLength(2);
    expect(outcome.awaitingUser).toBe(true);
    // Not one after another: well under three models' time in turn (3 × (80 ms + 80 ms)).
    expect(took).toBeLessThan(3 * 160 + 200);
  });

  it('"yes", but the save is refused (a time already booked): the care plan and every task in it keep waiting — nothing cancelled', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg twice daily', execution: 'WRITE' },
          { agent: 'patient_appointments', instruction: 'Book a follow-up next Tuesday at 3 pm', execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Ready.' })
      .script('patient_appointments', { calls: [call('add_appointments', { appointments: [{ date: '2026-10-06', startTime: '15:00' }] })] }, { content: 'Care plan ready — please confirm.' });
    const { orchestrator } = setup(llm, {
      // The save is refused, and what was prepared stays on screen, waiting.
      overrides: { confirm: vi.fn(async () => ({ ok: false, message: 'The care plan cannot be saved yet: Dr. Lucy White is already booked at 15:00 — choose another time.' })) },
    });
    await orchestrator.run('add metformin 500 mg twice daily and a follow-up next tuesday at 3 pm');
    const lead = orchestrator.activeGraph!.tasks.find((t) => !t.joinedInto)!;
    llm.script(lead.agent, { calls: [call('confirm_pending_action')] }, { content: 'It could not be saved.' });
    const outcome = await orchestrator.run('yes');
    const tasks = orchestrator.activeGraph!.tasks;
    expect(tasks.map((t) => t.status)).toEqual(['WAITING_FOR_USER', 'WAITING_FOR_USER']);
    expect(outcome.awaitingUser).toBe(true);
    expect(outcome.reply).toMatch(/^Not saved yet: The care plan cannot be saved yet: Dr\. Lucy White is already booked at 15:00/);
  });

  it('records AND a summary in one request (the summary given to the Inbox Agent): the summary is written now — not held behind the care plan’s yes', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg twice daily', execution: 'WRITE' },
          { agent: 'diagnoses', instruction: 'Add hypertension as a diagnosis', execution: 'WRITE' },
          { agent: 'inbox', instruction: 'Summarize all inbox normal records', execution: 'READ_ONLY' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Ready.' })
      .script('diagnoses', { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] }, { content: 'Care plan ready — please confirm.' });
    const { orchestrator, runtime } = setup(llm);
    const outcome = await orchestrator.run('add metformin 500 mg twice daily and hypertension, and summarize all inbox normal records');
    const tasks = orchestrator.activeGraph!.tasks;
    expect(runtime.summaryOf).toHaveBeenCalledTimes(1);
    expect(llm.calls('inbox')).toBe(0); // straight to the Summary Agent
    expect(tasks.map((t) => [t.agent, t.status])).toEqual([
      ['medications', 'WAITING_FOR_USER'],
      ['diagnoses', 'WAITING_FOR_USER'],
      ['summary', 'COMPLETED'],
    ]);
    // One reply: the summary's line, and the care plan's question last.
    expect(outcome.reply).toMatch(/Summary panel\..*confirm/);
    expect(outcome.awaitingUser).toBe(true);
  });

  it('an agent that reaches for ANOTHER agent’s open form (as qwen3.5:9b does) is told to add its own — and still joins the care plan now', async () => {
    const llm = new RoutedLLM(30)
      .script(
        'master',
        assign([
          { agent: 'recalls', instruction: 'Recall the patient for neck pain after two weeks', execution: 'WRITE' },
          { agent: 'diagnoses', instruction: 'Add hypertension as a diagnosis', execution: 'WRITE' },
          { agent: 'tasks', instruction: 'Create a task for blood pressure monitoring', execution: 'WRITE' },
        ]),
      )
      .script('recalls', { calls: [call('add_recalls', { recalls: [{ reason: 'Neck pain', dueDate: '2026-10-14' }] })] }, { content: 'Recall ready.' })
      // It sees the recall form open in CONTEXT and tries to put its diagnosis into it — then adds its own.
      .script('diagnoses', async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { calls: [call('fill_open_form', { description: 'Hypertension' })] };
      }, { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] }, { content: 'Diagnosis added.' })
      .script('tasks', async () => {
        await new Promise((r) => setTimeout(r, 90));
        return { calls: [call('save_open_form')] };
      }, { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] }, { content: 'The care plan is ready — please confirm.' });
    const { orchestrator, runtime } = setup(llm, { overrides: { fillOpenForm: vi.fn(async () => ok('filled')), saveOpenForm: vi.fn(async () => ok('saved')) } });
    await orchestrator.run('recall the patient for neck pain after two weeks, add hypertension and a task for blood pressure monitoring');
    const tasks = orchestrator.activeGraph!.tasks;
    // Every agent's records went up — none was held until the yes.
    expect((runtime.createRecords as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual(['diagnosis', 'recall', 'task']);
    expect(tasks.every((t) => t.status === 'WAITING_FOR_USER')).toBe(true);
    expect(tasks.filter((t) => !t.joinedInto)).toHaveLength(1);
    // The other agent's form was never touched.
    expect((runtime as unknown as { fillOpenForm: ReturnType<typeof vi.fn> }).fillOpenForm).not.toHaveBeenCalled();
    expect((runtime as unknown as { saveOpenForm: ReturnType<typeof vi.fn> }).saveOpenForm).not.toHaveBeenCalled();
  });

  it('the loop from testing: a select that ends "How would you like to proceed?" is done — and the next request goes to the master, not to the Patients Agent again and again', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'patients', instruction: 'Go to patients and select Luke King', execution: 'CONTEXT' }]))
      .script('patients', { calls: [call('select_patient', { patient: 'Luke King' })] }, { content: "I've found and selected Luke King. His summary is now open. How would you like to proceed?" });
    const { orchestrator, runtime } = setup(llm);
    await orchestrator.run('go to patiesnt and sleect luke king');
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('COMPLETED'); // not waiting on a question it did not need answered
    expect(orchestrator.holdsRequest).toBe(false);

    llm
      .script('master', assign([
        { agent: 'tasks', instruction: 'Create a task for BP monitoring', execution: 'WRITE' },
        { agent: 'recalls', instruction: 'Recall the patient for neck pain after two weeks', execution: 'WRITE' },
      ]))
      .script('tasks', { calls: [call('add_tasks', { tasks: [{ title: 'BP monitoring' }] })] }, { content: 'Task ready.' })
      .script('recalls', { calls: [call('add_recalls', { recalls: [{ reason: 'Neck pain', dueDate: '2026-10-21' }] })] }, { content: 'Recall ready — please confirm.' });
    await orchestrator.run('create a task for bp monitoring and recall a patient for neck pain after two weeks');
    expect(llm.calls('master')).toBe(2);
    expect(llm.calls('patients')).toBe(2); // its select and its reply — the second request never went to it
    expect((runtime.createRecords as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual(['recall', 'task']);
  });

  it('a task waiting on a question in words, given no answer (no tool used, the same question again): the master plans it — never a loop', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'patients', instruction: 'Select John', execution: 'CONTEXT' }]))
      .script('patients', { content: 'Which John do you mean?' });
    const { orchestrator } = setup(llm);
    await orchestrator.run('select john');
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('WAITING_FOR_USER'); // a real question: nothing done yet
    llm.script('patients', { content: 'Which John do you mean?' }).script('master', { content: 'Good morning!' });
    const outcome = await orchestrator.run('good morning');
    expect(outcome.reply).toBe('Good morning!');
    expect(llm.calls('master')).toBe(2);
  });

  it('a record agent whose task is not an addition does not join: it waits for the yes, then runs', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg twice daily', execution: 'WRITE' },
          { agent: 'patient_appointments', instruction: "Cancel John's appointment on Friday", execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Please confirm the medication.' });
    const { orchestrator, runtime } = setup(llm);
    await orchestrator.run("add metformin 500 mg twice daily and cancel john's appointment on friday");
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['WAITING_FOR_USER', 'PENDING']);
    expect(llm.calls('patient_appointments')).toBe(0);

    llm
      .script('medications', { calls: [call('confirm_pending_action')] }, { content: 'The medication is saved.' })
      .script('patient_appointments', { calls: [call('cancel_patient_appointment', { date: '2026-10-02' })] }, { content: 'Cancel it?' });
    const second = await orchestrator.run('yes');
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'WAITING_FOR_USER']);
    expect(runtime.cancelAppointment).toHaveBeenCalledTimes(1);
    expect(second.reply).toBe('The medication is saved. Cancel the appointment — please confirm or cancel.');
  });

  it('a joining agent that tries something else (a change, another patient) is stopped before acting, and runs after the yes', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg twice daily for John Ahmed', execution: 'WRITE' },
          { agent: 'tasks', instruction: 'Add a task for blood pressure monitoring for Tom Baker', execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { patient: 'John Ahmed', medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Please confirm the medication.' })
      // Tom Baker is not the patient of the open care plan: his task is never mixed into John's.
      .script('tasks', { calls: [call('add_tasks', { patient: 'Tom Baker', tasks: [{ title: 'Blood pressure monitoring' }] })] }, { content: 'It waits.' });
    const { orchestrator, runtime, ctx } = setup(llm);
    ctx.currentPatientId = 'pat-7';
    ctx.currentPatientName = 'John Ahmed';
    await orchestrator.run('add metformin for john ahmed and a bp task for tom baker');
    const [t1, t2] = orchestrator.activeGraph!.tasks;
    expect([t1.status, t2.status]).toEqual(['WAITING_FOR_USER', 'PENDING']);
    expect(t1.joinedInto).toBeUndefined();
    expect(runtime.createRecords).toHaveBeenCalledTimes(1);
  });

  it('a confirmation settled on screen (the dialog’s Confirm) completes the waiting task, and what waited behind it runs', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg', execution: 'WRITE' },
          { agent: 'patient_appointments', instruction: "Cancel John's appointment on Friday", execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg' }] })] }, { content: 'Ready.' })
      .script('patient_appointments', { calls: [call('cancel_patient_appointment', { date: '2026-10-02' })] }, { content: 'Cancel it?' });
    const { orchestrator, ctx } = setup(llm);
    await orchestrator.run("add metformin 500 mg and cancel john's appointment on friday");
    // Still open on screen: nothing to continue yet.
    expect(await orchestrator.continueAfterScreen(true)).toBeNull();
    ctx.pendingConfirmation = null; // the provider pressed Confirm; the runtime saved it
    const outcome = await orchestrator.continueAfterScreen(true);
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'WAITING_FOR_USER']);
    expect(outcome?.reply).toBe('Cancel the appointment — please confirm or cancel.');
    expect(llm.calls('master')).toBe(1);
  });

  it('a care plan confirmed on screen completes every task whose records are in it', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'medications', instruction: 'Add metformin 500 mg', execution: 'WRITE' },
          { agent: 'diagnoses', instruction: 'Add type 2 diabetes', execution: 'WRITE' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg' }] })] }, { content: 'Ready.' })
      .script('diagnoses', { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Type 2 diabetes' }] })] }, { content: 'Care plan ready.' });
    const { orchestrator, ctx } = setup(llm);
    await orchestrator.run('add metformin 500 mg and type 2 diabetes');
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['WAITING_FOR_USER', 'WAITING_FOR_USER']);
    ctx.pendingConfirmation = null;
    await orchestrator.continueAfterScreen(true);
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'COMPLETED']);
  });

  it('"no" cancels the waiting task, and whatever needed it is skipped', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'patients', instruction: 'Delete patient Tom Baker', execution: 'WRITE' },
          { agent: 'dashboard', instruction: 'Show my day', depends_on: ['t1'], execution: 'READ_ONLY' },
        ]),
      )
      .script('patients', { calls: [call('delete_patient', { patient: 'Tom Baker' })] });
    const { orchestrator } = setup(llm, { overrides: { deletePatient: vi.fn(async () => ({ ok: true, message: 'Delete Tom Baker? Please confirm or cancel.', awaitUser: true })) } });
    await orchestrator.run('delete tom baker and then show my day');
    llm.script('patients', { calls: [call('cancel_pending_action')] }, { content: 'Nothing was deleted.' });
    const outcome = await orchestrator.run('no, cancel');
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(outcome.reply).toMatch(/^Nothing was deleted\. Skipped: show my day/);
    expect(llm.calls('dashboard')).toBe(0);
  });

  it('a failed task is retried once with the error, then reported — and what depends on it is skipped; nothing loops', async () => {
    const failing = vi.fn(async () => ({ ok: false, message: 'No patient matches "Jon Amed". Try the full name or the MRN.' }));
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { agent: 'patients', instruction: 'Select Jon Amed', execution: 'CONTEXT' },
          { agent: 'summary', instruction: 'Show his summary', depends_on: ['t1'], execution: 'READ_ONLY' },
        ]),
      )
      .script('patients', { calls: [call('select_patient', { patient: 'Jon Amed' })] }, { content: 'I could not find him.' }, { calls: [call('select_patient', { patient: 'Jon Amed' })] }, { content: 'Still not found.' });
    const { orchestrator } = setup(llm, { overrides: { selectPatient: failing } });
    const outcome = await orchestrator.run('select Jon Amed and show his summary');
    const [t1, t2] = orchestrator.activeGraph!.tasks;
    expect(t1.status).toBe('FAILED');
    expect(t1.retryCount).toBe(1);
    expect(t1.error).toMatch(/No patient matches/);
    expect(t2.status).toBe('CANCELLED');
    expect(failing).toHaveBeenCalledTimes(2);
    expect(llm.calls('summary')).toBe(0);
    // The retry was told why the first attempt failed.
    const retry = String(llm.log.filter((l) => l.who === 'patients')[2].messages.at(-1)!.content);
    expect(retry).toContain('PREVIOUS ATTEMPT FAILED: No patient matches');
    expect(outcome.reply).toMatch(/Could not select Jon Amed: No patient matches/);
    expect(outcome.reply).toMatch(/Skipped: show his summary/);
  });

  it('a task given to the wrong specialist is handed back and reassigned to the one it belongs to', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'dashboard', instruction: 'Show my appointments today', execution: 'READ_ONLY' }]))
      .script('dashboard', { calls: [call('not_my_task', { reason: 'appointments are not mine', better_agent: 'appointments' })] })
      .script('appointments', { calls: [call('list_my_appointments', { when: 'today' })] }, { content: 'You have 2 appointments today.' });
    const { orchestrator } = setup(llm);
    const outcome = await orchestrator.run('show my appointments today');
    const [t1] = orchestrator.activeGraph!.tasks;
    expect(t1.agent).toBe('appointments');
    expect(t1.triedAgents).toEqual(['dashboard']);
    expect(t1.status).toBe('COMPLETED');
    expect(outcome.reply).toBe('You have 2 appointments today.');
  });

  it('a specialist never moves the screen on its own: no page, scroll, panel or "back" its task did not ask for', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'patients', instruction: 'Select Tom Baker', execution: 'CONTEXT' }]))
      // What qwen3.5:9b did on Kaggle after selecting the patient.
      .script('patients', { calls: [call('select_patient', { patient: 'Tom Baker' }), call('scroll_page', { direction: 'down' }), call('patient_summary_panel', { open: true }), call('go_back')] }, { content: 'Tom Baker is selected.' });
    const scroll = vi.fn(async () => ok('Scrolled.'));
    const panel = vi.fn(async () => ok('Opened.'));
    const back = vi.fn(async () => ok('Went back.'));
    const { orchestrator } = setup(llm, { overrides: { scrollPage: scroll, scroll, setPatientPanel: panel, goBack: back, back } });
    const outcome = await orchestrator.run('select tom baker');
    expect([scroll, panel, back].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('COMPLETED');
    expect(outcome.reply).toBe('Tom Baker is selected.');
  });

  it('the Summary Agent writes summaries with no tools and no tool-calling model: the app gathers the data, the panel shows it, the reply is one line', async () => {
    const llm = new RoutedLLM().script('master', assign([{ agent: 'summary', instruction: 'Summarize all inbox normal records', execution: 'READ_ONLY' }]));
    const { orchestrator, runtime } = setup(llm);
    const steps: string[] = [];
    const outcome = await orchestrator.run('Summarize all inbox normal records', { onStep: (s) => s.type === 'tool' && s.finishedAt && steps.push(`${s.agent}:${s.call.name}`) });
    expect(runtime.summaryOf).toHaveBeenCalledWith('Summarize all inbox normal records', expect.objectContaining({ llm }));
    expect(llm.calls('summary')).toBe(0); // the app chose what to summarize — the model was never asked to call a tool
    expect(steps.filter((x) => !x.startsWith('master:'))).toEqual(['summary:summarize']);
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('COMPLETED');
    expect(outcome).toMatchObject({ reply: 'The summary of normal Inbox records (All patients · 5 records) is open in the Summary panel.', awaitingUser: false });
  });

  it('a summary given to another agent ("give me an overview of Chloe Bell" to the Patients Agent, as qwen3.5:9b did) is the Summary Agent\'s', async () => {
    const llm = new RoutedLLM().script('master', assign([{ agent: 'patients', instruction: 'Give me an overview of Chloe Bell', execution: 'READ_ONLY' }]));
    const { orchestrator, runtime } = setup(llm);
    await orchestrator.run('Give me an overview of Chloe Bell');
    expect(orchestrator.activeGraph!.tasks[0]).toMatchObject({ agent: 'summary', triedAgents: ['patients'], status: 'COMPLETED' });
    expect(llm.calls('patients')).toBe(0);
    expect(runtime.summaryOf).toHaveBeenCalledWith('Give me an overview of Chloe Bell', expect.anything());
  });

  it('an action given to the Summary Agent goes to the agent that owns it — it only summarizes', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'summary', instruction: 'Add the medication metformin 500 mg twice daily', execution: 'WRITE' }]))
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] }, { content: 'Please confirm the medication.' });
    const { orchestrator, runtime } = setup(llm);
    await orchestrator.run('add metformin 500 mg twice daily');
    const [t1] = orchestrator.activeGraph!.tasks;
    expect(t1).toMatchObject({ agent: 'medications', triedAgents: ['summary'], status: 'WAITING_FOR_USER' });
    expect(runtime.summaryOf).not.toHaveBeenCalled();
  });

  it('parallel tasks: independent READ_ONLY tasks run together; the screen is still changed by one task at a time', async () => {
    const llm = new RoutedLLM(30)
      .script(
        'master',
        assign([
          { agent: 'dashboard', instruction: 'How busy am I today', execution: 'READ_ONLY' },
          { agent: 'inbox', instruction: 'Show the latest lab results', execution: 'READ_ONLY' },
          { agent: 'appointments', instruction: "Show today's appointments", execution: 'READ_ONLY' },
        ]),
      )
      .script('dashboard', { calls: [call('get_provider_overview')] }, { content: 'You have a light day.' })
      .script('inbox', { calls: [call('inbox_show', { category: 'lab' })] }, { content: '3 lab results.' })
      .script('appointments', { calls: [call('list_my_appointments', { when: 'today' })] }, { content: '2 appointments today.' });
    const order: string[] = [];
    const slow = (name: string, result: ToolResult) =>
      vi.fn(async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 40));
        order.push(`${name}:end`);
        return result;
      });
    const { orchestrator } = setup(llm, {
      overrides: { inboxShow: slow('inbox', ok('3 lab results.')), myAppointments: slow('appointments', ok('2 appointments.')) },
    });
    const outcome = await orchestrator.run("how busy am I today, show the latest lab results and today's appointments");
    expect(llm.maxActive).toBeGreaterThanOrEqual(2); // the specialists' model calls overlapped
    // The two tools that change the screen never overlapped.
    expect(order.join(' ')).toMatch(/^(inbox:start inbox:end appointments:start appointments:end|appointments:start appointments:end inbox:start inbox:end)$/);
    expect(orchestrator.activeGraph!.tasks.every((t) => t.status === 'COMPLETED')).toBe(true);
    expect(outcome.reply).toBe('You have a light day. 3 lab results. 2 appointments today.');
  });

  it('parallel tasks off: the same tasks run one after another', async () => {
    const llm = new RoutedLLM(10).script(
      'master',
      assign([
        { agent: 'dashboard', instruction: 'How busy am I', execution: 'READ_ONLY' },
        { agent: 'inbox', instruction: 'Show the Inbox', execution: 'READ_ONLY' },
      ]),
    );
    const { orchestrator } = setup(llm, { parallelReads: false });
    await orchestrator.run('how busy am I and show the inbox');
    expect(llm.maxActive).toBe(1);
  });

  it('a "read-only" task that writes beside another does it in its turn, and is scheduled as a WRITE from then on', async () => {
    const llm = new RoutedLLM(5)
      .script(
        'master',
        assign([
          { agent: 'dashboard', instruction: 'How busy am I', execution: 'READ_ONLY' },
          { agent: 'inbox', instruction: 'File the first lab result', execution: 'READ_ONLY' },
        ]),
      )
      .script('dashboard', { calls: [call('get_provider_overview')] }, { content: 'A light day.' })
      .script('inbox', { calls: [call('inbox_file_item', { file: true, target: 1 })] }, { content: 'File it?' });
    const inboxFile = vi.fn(() => ({ ok: true, message: 'File "HbA1c"? Please confirm or cancel.', awaitUser: true }));
    const { orchestrator } = setup(llm, { overrides: { inboxFile } });
    const outcome = await orchestrator.run('how busy am I and file the first lab result');
    const t2 = orchestrator.activeGraph!.tasks[1];
    expect(inboxFile).toHaveBeenCalledTimes(1);
    expect(t2.executionType).toBe('WRITE');
    expect(t2.declaredType).toBe('READ_ONLY');
    expect(t2.retryCount).toBe(0); // not a failure — a reclassification
    expect(t2.status).toBe('WAITING_FOR_USER');
    expect(outcome.reply).toBe('A light day. File "HbA1c"? Please confirm or cancel.');
  });

  it('"go to patients, select Tom Baker and add comment hello world to all patients normal inbox records": the Patients and Inbox Agents work at the same time — on every patient’s records', async () => {
    const llm = new RoutedLLM(40)
      .script(
        'master',
        assign([
          { id: 't1', agent: 'patients', instruction: 'Go to patients and select Tom Baker', execution: 'CONTEXT' },
          { id: 't2', agent: 'inbox', instruction: "Add comment hello world to all patients' normal inbox records", execution: 'WRITE' },
        ]),
      )
      .script('patients', { calls: [call('select_patient', { patient: 'Tom Baker' })] }, { content: 'Tom Baker is selected.' })
      .script('inbox', { calls: [call('inbox_add_comment', { text: 'hello world', which: 'normal', scope: 'all_patients' })] }, { content: 'Added hello world to 3 normal records.' });
    const order: string[] = [];
    const inboxAddComment = vi.fn(async () => {
      order.push('comment:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('comment:end');
      return ok('Comment "hello world" added to 3 normal records for all patients.', { speak: true });
    });
    const { orchestrator, ctx } = setup(llm, {
      overrides: {
        inboxAddComment,
        selectPatient: vi.fn(async () => {
          order.push('select:start');
          await new Promise((r) => setTimeout(r, 30));
          ctx.currentPatientId = 'pat-tb';
          ctx.currentPatientName = 'Tom Baker';
          order.push('select:end');
          return ok('Tom Baker is now the selected patient.');
        }),
      },
    });
    const outcome = await orchestrator.run('go to patients select Tom Baker and add comment hello world to all patients normal inbox records');
    const [t1, t2] = orchestrator.activeGraph!.tasks;
    // Independent: both agents were given their task at once and thought at the same time…
    expect(t2.dependsOn).toEqual([]);
    expect(llm.maxActive).toBe(2);
    // …while the screen changed one step at a time.
    expect(order.join(' ')).toMatch(/^(select:start select:end comment:start comment:end|comment:start comment:end select:start select:end)$/);
    expect([t1.status, t2.status]).toEqual(['COMPLETED', 'COMPLETED']);
    expect(inboxAddComment).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all_patients', which: 'normal', text: 'hello world' }));
    // The Inbox task did not choose the patient: it hands on none (the Patients task does).
    expect(t1.result?.patientName).toBe('Tom Baker');
    expect(t2.result?.patientId).toBeUndefined();
    expect(outcome.reply).toBe('Tom Baker is selected. Added hello world to 3 normal records.');
  });

  it('two writes take turns — one confirmation at a time, in the order said — while a read runs beside the first', async () => {
    const llm = new RoutedLLM(10)
      .script(
        'master',
        assign([
          { id: 't1', agent: 'medications', instruction: 'Add metformin 500 mg for John Ahmed', execution: 'WRITE' },
          { id: 't2', agent: 'patient_appointments', instruction: "Cancel John Ahmed's appointment next Tuesday", execution: 'WRITE' },
          { id: 't3', agent: 'dashboard', instruction: 'How busy am I today', execution: 'READ_ONLY' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { patient: 'John Ahmed', medications: [{ medicationName: 'Metformin', dosage: '500 mg' }] })] }, { content: 'Please confirm the medication.' })
      .script('dashboard', { calls: [call('get_provider_overview')] }, { content: 'A light day.' });
    const { orchestrator, runtime, ctx } = setup(llm);
    const first = await orchestrator.run("add metformin 500 mg for john ahmed, cancel his appointment next tuesday and how busy am I");
    let [t1, t2, t3] = orchestrator.activeGraph!.tasks;
    expect(llm.maxActive).toBe(2); // the medication and the overview at once
    expect(llm.calls('patient_appointments')).toBe(0); // the second write waits its turn: no thinking thrown away
    expect([t1.status, t2.status, t3.status]).toEqual(['WAITING_FOR_USER', 'PENDING', 'COMPLETED']);
    expect(runtime.createRecords).toHaveBeenCalledTimes(1);
    expect(first.reply).toBe('A light day. Please confirm the medication.');

    // "yes": the medication is saved, then the appointment task runs and asks its own question.
    llm
      .script('medications', { calls: [call('confirm_pending_action')] }, { content: 'The medication is saved.' })
      .script('patient_appointments', { calls: [call('cancel_patient_appointment', { patient: 'John Ahmed', date: '2026-10-06' })] }, { content: 'Cancel the follow-up?' });
    const second = await orchestrator.run('yes');
    [t1, t2] = orchestrator.activeGraph!.tasks;
    expect(t1.status).toBe('COMPLETED');
    expect(t2.status).toBe('WAITING_FOR_USER');
    expect(ctx.pendingConfirmation?.description).toBe('Cancel the appointment');
    expect(second.reply).toBe('The medication is saved. Cancel the appointment — please confirm or cancel.');
  });

  it('a task said to be read-only that asks the provider something beside a write that already asked: it stops before acting, and carries on after the answer', async () => {
    const llm = new RoutedLLM(10)
      .script(
        'master',
        assign([
          { id: 't1', agent: 'medications', instruction: 'Add metformin 500 mg', execution: 'WRITE' },
          { id: 't2', agent: 'inbox', instruction: 'File the first lab result', execution: 'READ_ONLY' },
        ]),
      )
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg' }] })] }, { content: 'Please confirm.' })
      // The Inbox Agent thinks as long again before acting: the medication's confirmation is on screen by then.
      .script('inbox', async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { calls: [call('inbox_file_item', { file: true, target: 1 })] };
      }, { content: 'It waits.' });
    const inboxFile = vi.fn(() => {
      ctx.pendingConfirmation = { kind: 'inbox_file', description: 'File HbA1c' };
      return { ok: true, message: 'File "HbA1c"? Please confirm or cancel.', awaitUser: true };
    });
    const { orchestrator, ctx } = setup(llm, { overrides: { inboxFile } });
    await orchestrator.run('add metformin 500 mg and file the first lab result');
    let [t1, t2] = orchestrator.activeGraph!.tasks;
    expect(llm.maxActive).toBe(2);
    expect([t1.status, t2.status]).toEqual(['WAITING_FOR_USER', 'PENDING']);
    expect(inboxFile).not.toHaveBeenCalled(); // never two confirmations at once
    expect(t2.retryCount).toBe(0); // not a failure

    llm
      .script('medications', { calls: [call('confirm_pending_action')] }, { content: 'Saved.' })
      .script('inbox', { calls: [call('inbox_file_item', { file: true, target: 1 })] }, { content: 'File it?' });
    await orchestrator.run('yes');
    [t1, t2] = orchestrator.activeGraph!.tasks;
    expect([t1.status, t2.status]).toEqual(['COMPLETED', 'WAITING_FOR_USER']);
    expect(inboxFile).toHaveBeenCalledTimes(1);
  });

  it('a task that does more than it was declared as is scheduled as what it really is', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'patients', instruction: 'Open John Ahmed', execution: 'READ_ONLY' }]))
      .script('patients', { calls: [call('select_patient', { patient: 'John Ahmed' })] }, { content: 'John Ahmed is selected.' });
    const { orchestrator } = setup(llm);
    await orchestrator.run('open john ahmed');
    expect(orchestrator.activeGraph!.tasks[0]).toMatchObject({ executionType: 'CONTEXT', declaredType: 'READ_ONLY', status: 'COMPLETED' });
  });

  it('an answer that is not an answer: the waiting task hands it back, and the master plans the new request', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ agent: 'patient_appointments', instruction: 'Book John tomorrow', execution: 'WRITE' }]))
      .script('patient_appointments', { calls: [call('add_appointments', { appointments: [{ patient: 'John Ahmed', date: '2026-10-01' }] })] }, { content: 'What time?' });
    const { orchestrator } = setup(llm, { overrides: { createRecords: vi.fn(async () => ({ ok: true, message: 'What time should it start?', awaitUser: true })) } });
    await orchestrator.run('book john tomorrow');
    llm
      .script('patient_appointments', { calls: [call('not_my_task', { reason: 'not an answer' })] })
      .script('master', assign([{ agent: 'inbox', instruction: 'Show my inbox', execution: 'READ_ONLY' }]))
      .script('inbox', { calls: [call('inbox_show', {})] }, { content: 'The Inbox is open.' });
    const outcome = await orchestrator.run('actually show my inbox');
    expect(outcome.reply).toBe('The Inbox is open.');
    expect(llm.calls('master')).toBe(2);
    expect(orchestrator.activeGraph!.tasks[0].agent).toBe('inbox');
  });

  it('the master’s tasks must keep every detail: a plan that drops one is sent back once', async () => {
    const llm = new RoutedLLM().script(
      'master',
      assign([
        { agent: 'medications', instruction: 'Add a medication', execution: 'WRITE' },
        { agent: 'patient_appointments', instruction: 'Book an appointment', execution: 'WRITE' },
      ]),
      assign([
        { agent: 'medications', instruction: 'Add metformin 500 mg twice daily', execution: 'WRITE' },
        { agent: 'patient_appointments', instruction: 'Book a follow-up next Tuesday at 3 pm', execution: 'WRITE' },
      ]),
    );
    const { orchestrator } = setup(llm);
    await orchestrator.run('add metformin 500 mg twice daily and book a follow-up next Tuesday at 3 pm');
    expect(llm.calls('master')).toBe(2);
    expect(orchestrator.activeGraph!.tasks.map((t) => t.instruction)).toEqual(['Add metformin 500 mg twice daily', 'Book a follow-up next Tuesday at 3 pm']);
  });

  it('a cancelled request (the provider stopped it) cancels what was left of its graph', async () => {
    const controller = new AbortController();
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { id: 't1', agent: 'dashboard', instruction: 'How busy am I', execution: 'CONTEXT' },
          { id: 't2', agent: 'inbox', instruction: 'Show the Inbox', execution: 'CONTEXT', depends_on: ['t1'] },
        ]),
      )
      .script('dashboard', () => {
        controller.abort();
        return { calls: [call('get_provider_overview')] };
      });
    const { orchestrator } = setup(llm);
    await expect(orchestrator.run('how busy am I and show the inbox', {}, controller.signal)).rejects.toThrow();
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });
});

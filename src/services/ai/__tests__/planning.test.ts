/**
 * The Planning Agent with the Safety Agent, in the multi-agent orchestrator: requirements are gathered before
 * anything runs — what is missing is asked for with a fixed question, what a model made up never gets through,
 * and the specialist receives exactly the approved values.
 */
import { describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import type { AgentName, AIContext, ToolCall, ToolResult } from '@/types/ai';
import type { ChatLLM, ChatMessage, ChatTurn, ToolSchema } from '../providers/llm';
import { MultiAgentOrchestrator, type MultiAgentHooks } from '../agents/master';
import { buildTools } from '../agent/tools';
import type { AppRuntime } from '../agent/runtime';
import { SafetyAgent } from '../safety/safetyAgent';
import { call } from './fakes';

type Who = 'master' | 'planning' | AgentName;
const WHO: Array<[RegExp, Who]> = [
  [/^You are the master agent/, 'master'],
  [/^You are the Planning Agent/, 'planning'],
  [/You are the Patients Agent/, 'patients'],
  [/You are the Summary Agent/, 'summary'],
  [/You are the My Appointment Agent/, 'appointments'],
  [/You are the Appointments Agent/, 'patient_appointments'],
  [/You are the Medication Agent/, 'medications'],
  [/You are the Diagnoses Agent/, 'diagnoses'],
  [/You are the Tasks Agent/, 'tasks'],
  [/You are the Recalls Agent/, 'recalls'],
  [/You are the Notes Agent/, 'notes'],
  [/You are the Dashboard Agent/, 'dashboard'],
  [/You are the Inbox Agent/, 'inbox'],
];

/** A model scripted per agent. */
class RoutedLLM implements ChatLLM {
  readonly name = 'routed';
  readonly log: Array<{ who: Who; messages: ChatMessage[] }> = [];
  private scripts = new Map<Who, Array<{ content?: string; calls?: ToolCall[] }>>();
  script(who: Who, ...turns: Array<{ content?: string; calls?: ToolCall[] }>) {
    this.scripts.set(who, [...(this.scripts.get(who) ?? []), ...turns]);
    return this;
  }
  async chat(messages: ChatMessage[], _tools: ToolSchema[]): Promise<ChatTurn> {
    const who = WHO.find(([re]) => re.test(String(messages[0]?.content ?? '')))?.[1];
    if (!who) throw new Error('unknown agent');
    this.log.push({ who, messages });
    const next = this.scripts.get(who)?.shift();
    return { content: next?.content ?? `${who} done.`, toolCalls: next?.calls ?? [] };
  }
  calls(who: Who) {
    return this.log.filter((l) => l.who === who).length;
  }
  /** The task message an agent was last given (after the system prompt and the SESSION exchange). */
  lastMessage(who: Who) {
    return String(this.log.filter((l) => l.who === who).at(-1)?.messages[3]?.content ?? '');
  }
}

const ok = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, message, ...extra });

function setup(llm: RoutedLLM) {
  const words: string[] = [];
  const ctx: AIContext = {
    today: '2026-10-01 (Thursday)', nextDays: '', laterDates: '', now: '10:00', providerName: 'Dr. Lucy White', currentPageId: 'dashboard', currentPageTitle: 'Dashboard',
    currentPatientId: null, currentPatientName: null, openForm: null, pendingQuestion: null, pendingConfirmation: null, inbox: null, patientSearch: null, list: null, extracted: null, carePlan: null,
  };
  const runtime = {
    beginTurn: vi.fn(),
    endTurn: vi.fn(),
    selectPatient: vi.fn(async ({ patient }: { patient?: string }) => {
      ctx.currentPatientId = 'p1';
      ctx.currentPatientName = patient ?? '';
      return ok(`${patient} is now the selected patient.`);
    }),
    addCarePlan: vi.fn(async () => ok('The care plan is ready — please confirm.', { awaitUser: true })),
    createRecords: vi.fn(async () => {
      staged = true;
      return ok('Ready — please confirm.', { awaitUser: true });
    }),
    // New records wait in a form for the provider's yes: another agent's records join them.
    recordsWaiting: vi.fn(() => staged),
  } as unknown as AppRuntime;
  let staged = false;
  const orchestrator = new MultiAgentOrchestrator(llm, runtime, () => ({ ...ctx }), { maxSteps: 6, planning: true, parallelReads: false });
  orchestrator.setTools(buildTools());
  orchestrator.setSafety(
    new SafetyAgent({
      utterances: () => words,
      today: () => dayjs('2026-10-01'),
      providerName: () => 'Dr. Lucy White',
      providers: () => ['Dr. Lucy White'],
      selectedPatient: () => (ctx.currentPatientId ? { id: ctx.currentPatientId, name: ctx.currentPatientName ?? '' } : null),
      patients: () => [
        { id: 'p1', fullName: 'James Ahmed', mrn: 'MRN1' },
        { id: 'p2', fullName: 'Harry White', mrn: 'MRN2' },
      ],
      known: () => [],
      recordLabel: () => undefined,
      openFormId: () => null,
      staged: () => [],
      discardStaged: () => undefined,
    }),
  );
  const reports: string[] = [];
  const hooks: MultiAgentHooks = { onPlanning: (r) => reports.push(r.type) };
  /** What the provider says next — as the voice controller keeps it for the Safety Agent. */
  const say = (said: string, continuing = false) => {
    if (!continuing) words.length = 0;
    words.push(said);
    return orchestrator.run(said, hooks);
  };
  return { orchestrator, runtime, ctx, reports, say };
}

const assign = (tasks: Array<Record<string, unknown>>) => ({ calls: [call('assign_tasks', { tasks })] });
const submit = (tasks: Array<Record<string, unknown>>) => ({ calls: [call('submit_requirements', { tasks })] });

describe('the Planning Agent gathers requirements before anything runs', () => {
  it('"go to patients and select patient": no patient is guessed — "Which patient would you like to select?" — then the one the provider names', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ id: 't1', agent: 'patients', instruction: 'Go to patients and select patient', execution: 'CONTEXT' }]))
      .script('planning', submit([{ task: 't1', action: 'select_patient' }]));
    const { orchestrator, runtime, reports, say } = setup(llm);

    const first = await say('go to patients and select patient');
    expect(first).toMatchObject({ reply: 'Which patient would you like to select?', awaitingUser: true, speak: true });
    expect(llm.calls('patients')).toBe(0); // nothing ran
    expect(runtime.selectPatient).not.toHaveBeenCalled();
    expect(orchestrator.holdsRequest).toBe(true);
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('PENDING');

    // The answer: the Planning Agent adds it; the Patients Agent gets it as an approved requirement.
    llm.script('planning', submit([{ task: 't1', action: 'select_patient', patient: 'James Ahmed' }])).script('patients', { calls: [call('select_patient', { patient: 'James Ahmed' })] }, { content: 'James Ahmed is selected.' });
    const second = await say('James Ahmed', true);
    expect(second.reply).toBe('James Ahmed is selected.');
    expect(runtime.selectPatient).toHaveBeenCalledWith(expect.objectContaining({ patient: 'James Ahmed' }));
    expect(llm.lastMessage('patients')).toContain('APPROVED REQUIREMENTS');
    expect(llm.lastMessage('patients')).toContain('- patient: James Ahmed');
    expect(orchestrator.holdsRequest).toBe(false);
    expect(reports).toEqual(['started', 'question', 'started', 'ready']);
  });

  it('"add medication and add diagnosis": the Panadol 500 mg twice daily and Hypertension a model made up are removed and asked for — then the provider\'s own values go through, each to its own agent, into one care plan', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ id: 't1', agent: 'summary', instruction: 'Add medication and add diagnosis', execution: 'WRITE' }]))
      // The model invents the values — exactly what happened in testing.
      .script('planning', submit([{ task: 't1', action: 'add_records', records: [{ kind: 'medication', values: { medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily' } }, { kind: 'diagnosis', values: { description: 'Hypertension' } }] }]));
    const { orchestrator, runtime, ctx, say } = setup(llm);
    ctx.currentPatientId = 'p1';
    ctx.currentPatientName = 'James Ahmed';

    const first = await say('add medication and add diagnosis');
    expect(first.reply).toBe('What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
    // Each kind of record is its own agent's: the medication the Medication Agent's, the diagnosis the Diagnoses Agent's.
    expect(orchestrator.activeGraph!.tasks.map((t) => [t.id, t.agent])).toEqual([
      ['t1', 'medications'],
      ['t2', 'diagnoses'],
    ]);
    expect(llm.calls('medications') + llm.calls('diagnoses') + llm.calls('summary')).toBe(0);
    expect(runtime.createRecords).not.toHaveBeenCalled();

    llm
      .script('planning', submit([{ task: 't1', action: 'add_records', records: [{ kind: 'medication', values: { medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' } }, { kind: 'diagnosis', values: { description: 'Diabetes' } }] }]))
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', route: 'Oral' }] })] }, { content: 'Please confirm the medication.' })
      .script('diagnoses', { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Diabetes' }] })] }, { content: 'Please review and confirm the care plan.' });
    // The route the planning model left out was said ("by mouth"): it is the provider's, so it goes on.
    const second = await say('metformin 500 mg by mouth twice a day and diabetes', true);
    expect(llm.lastMessage('medications')).toContain('medication 1: medicationName = Metformin, dosage = 500 mg, frequency = Twice daily, route = Oral');
    expect(llm.lastMessage('medications')).not.toContain('description = Diabetes');
    expect(llm.lastMessage('diagnoses')).toContain('diagnosis 1: description = Diabetes');
    expect(llm.lastMessage('medications') + llm.lastMessage('diagnoses')).not.toContain('Panadol');
    expect(orchestrator.activeGraph!.tasks).toHaveLength(2); // the answer went to the tasks there are — no second copy
    // The diagnosis joined the medication waiting for the provider's yes: one care plan, one confirmation.
    expect(runtime.createRecords).toHaveBeenCalledTimes(2);
    const [t1, t2] = orchestrator.activeGraph!.tasks;
    expect([t1.status, t2.status]).toEqual(['WAITING_FOR_USER', 'WAITING_FOR_USER']);
    expect(t1.joinedInto).toBe('t2');
    expect(second).toMatchObject({ awaitingUser: true, reply: 'Please review and confirm the care plan.' });
  });

  it('what qwen3.5:9b sent on Kaggle: a report item without its task id is the task in its place — and each task keeps only its own kind of record', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { id: 't1', agent: 'patients', instruction: 'Select patient Luke King.', execution: 'CONTEXT' },
          { id: 't2', agent: 'medications', instruction: "Add Panadol 500 mg twice daily for 5 days to Luke King's medications.", execution: 'WRITE' },
          { id: 't3', agent: 'diagnoses', instruction: "Add hypertension as a diagnosis to Luke King's problem list.", execution: 'WRITE' },
        ]),
      )
      .script('planning', submit([{ action: 'select_patient', patient: 'Luke King' }, { task: 't2', action: 'add_records', records: [{ kind: 'medication', values: { medicationName: 'Panadol', dosage: '500 mg', frequency: 'twice daily', duration: '5 days' } }] }, { task: 't3', action: 'add_records', records: [{ kind: 'diagnosis', values: { description: 'hypertension' } }] }]));
    const { orchestrator, say } = setup(llm);
    await say('For Luke King add Panadol 500 mg twice daily for 5 days and add hypertension as a diagnosis');
    const tasks = orchestrator.activeGraph!.tasks;
    expect(tasks.map((t) => t.agent)).toEqual(['patients', 'medications', 'diagnoses']); // no task split into every kind said
    expect(tasks[0].requirements).toEqual(['patient: Luke King']);
    expect(tasks[2].requirements?.join(' ')).not.toMatch(/medication/);
  });

  it('"add medication and diagnoses" with James Ahmed selected: the select the master added from CONTEXT is done already — never "Which patient would you like to select?"', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { id: 't1', agent: 'patients', instruction: 'Select patient James Ahmed.', execution: 'CONTEXT' },
          { id: 't2', agent: 'medications', instruction: 'Add medication', execution: 'WRITE', depends_on: ['t1'] },
          { id: 't3', agent: 'diagnoses', instruction: 'Add diagnoses', execution: 'WRITE', depends_on: ['t1'] },
        ]),
      )
      .script('planning', submit([{ task: 't1', action: 'select_patient' }, { task: 't2', action: 'add_records', records: [{ kind: 'medication' }] }, { task: 't3', action: 'add_records', records: [{ kind: 'diagnosis' }] }]));
    const { orchestrator, ctx, say } = setup(llm);
    ctx.currentPatientId = 'p1';
    ctx.currentPatientName = 'James Ahmed';
    const first = await say('add medication and diagnoses');
    expect(first.reply).toBe('What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
    expect(first.reply).not.toMatch(/Which patient/);
    expect(orchestrator.activeGraph!.tasks[0]).toMatchObject({ agent: 'patients', status: 'COMPLETED', result: { patientName: 'James Ahmed' } });
    expect(llm.calls('patients')).toBe(0);
  });

  it('…but "select Harry White and add medication" with James Ahmed selected: the select is the provider’s — it runs', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ id: 't1', agent: 'patients', instruction: 'Select Harry White', execution: 'CONTEXT' }]))
      .script('planning', submit([{ task: 't1', action: 'select_patient', patient: 'Harry White' }]))
      .script('patients', { calls: [call('select_patient', { patient: 'Harry White' })] }, { content: 'Harry White is selected.' });
    const { orchestrator, ctx, say } = setup(llm);
    ctx.currentPatientId = 'p1';
    ctx.currentPatientName = 'James Ahmed';
    await say('select harry white');
    expect(llm.calls('patients')).toBeGreaterThan(0);
    expect(orchestrator.activeGraph!.tasks[0].status).toBe('COMPLETED');
  });

  it('a complete request goes straight through — no question', async () => {
    const llm = new RoutedLLM()
      .script(
        'master',
        assign([
          { id: 't1', agent: 'patients', instruction: 'Select James Ahmed', execution: 'CONTEXT' },
          { id: 't2', agent: 'medications', instruction: 'Add metformin 500 mg orally twice daily', execution: 'WRITE', depends_on: ['t1'] },
        ]),
      )
      .script('planning', submit([{ task: 't1', action: 'select_patient', patient: 'James Ahmed' }, { task: 't2', action: 'add_records', records: [{ kind: 'medication', values: { medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency: 'Twice daily' } }] }]))
      .script('patients', { calls: [call('select_patient', { patient: 'James Ahmed' })] }, { content: 'James Ahmed is selected.' })
      .script('medications', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency: 'Twice daily' }] })] }, { content: 'Please confirm the medication.' });
    const { orchestrator, reports, say } = setup(llm);
    const outcome = await say('select james ahmed and add metformin 500 mg orally twice daily');
    expect(reports).toEqual(['started', 'ready']);
    expect(orchestrator.activeGraph!.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'WAITING_FOR_USER']);
    expect(outcome.awaitingUser).toBe(true);
  });

  it('the provider asks for something else instead of answering: the held request is dropped, the new one planned', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ id: 't1', agent: 'patients', instruction: 'Select patient', execution: 'CONTEXT' }]), assign([{ id: 't1', agent: 'dashboard', instruction: 'How busy am I', execution: 'READ_ONLY' }]))
      .script('planning', submit([{ task: 't1', action: 'select_patient' }]), { calls: [call('not_an_answer')] })
      .script('dashboard', { calls: [call('get_provider_overview')] }, { content: 'A light day.' });
    const { orchestrator, runtime, reports, say } = setup(llm);
    (runtime as unknown as { providerOverview: () => ToolResult }).providerOverview = () => ok('Schedule.', { data: {} });
    await say('select patient');
    const outcome = await say('how busy am I today', true);
    expect(outcome.reply).toBe('A light day.');
    expect(reports).toEqual(['started', 'question', 'started', 'dropped']);
    expect(orchestrator.holdsRequest).toBe(false);
    expect(runtime.selectPatient).not.toHaveBeenCalled();
  });

  it('with the Planning Agent asked to fill in a date nobody said: removed and asked for', async () => {
    const llm = new RoutedLLM()
      .script('master', assign([{ id: 't1', agent: 'appointments', instruction: 'Book a follow-up for James Ahmed', execution: 'WRITE' }]))
      .script('planning', submit([{ task: 't1', action: 'add_records', patient: 'James Ahmed', records: [{ kind: 'appointment', values: { date: '2026-10-06', startTime: '15:00', reason: 'Follow-up' } }] }]));
    const { say } = setup(llm);
    const first = await say('book a follow-up for james ahmed');
    expect(first.reply).toBe('What date and time should the appointment for James Ahmed be scheduled for?');
  });
});

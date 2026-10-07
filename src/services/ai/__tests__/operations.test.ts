/**
 * Requirements are ACTION-SPECIFIC: what an operation needs depends on the operation, never on the kind of
 * record alone. "Delete all medications for Tom Baker" needs nothing but the patient (and a yes) — it never
 * asks "Which medication, at what dose and how often?".
 */
import { describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import type { AIContext, ToolCall } from '@/types/ai';
import type { ChatLLM, ChatMessage, ChatTurn } from '../providers/llm';
import { PlanningAgent, type RequirementDraft } from '../agents/planning';
import { TaskGraph, type TaskRequest } from '../agents/taskGraph';
import { recordOwner } from '../agents/skills';
import type { AppRuntime } from '../agent/runtime';
import { SafetyAgent } from '../safety/safetyAgent';
import { detectOperation, missingFor, type OperationPlan } from '../safety/operations';
import { questionFor } from '../safety/requirements';
import { call } from './fakes';

/** The add-medication question that must never be asked of anything but an add. */
const ADD_MED_QUESTION = /which medication|at what dose|how often/i;

describe('1. the operation comes first — detected from the words', () => {
  it.each([
    ['Delete all medications for Tom Baker', 'delete_all', 'medication'],
    ['Delete Gabapentin for Tom Baker', 'delete_one', undefined],
    ['Add Gabapentin to Tom Baker', 'add', undefined],
    ['Change Gabapentin frequency for Tom Baker to twice daily', 'update', undefined],
    ['Show Tom Baker’s medications', 'view', 'medication'],
    ['Remove every diagnosis of Tom Baker', 'delete_all', 'diagnosis'],
    ['Delete all tasks for Tom Baker', 'delete_all', 'task'],
    ['Mark the blood pressure task as completed', 'update', 'task'],
    ['Delete the follow-up recall', 'delete_one', 'recall'],
    ['Clear out all appointments for Tom Baker', 'delete_all', 'appointment'],
    ['Set up an appointment next Tuesday', 'add', 'appointment'],
    ['Add a new patient Olivia Testcase', 'create_patient', 'patient'],
    ['Add medication to the patient', 'add', 'medication'],
    ['Select Tom Baker', 'select_patient', undefined],
  ])('"%s" → %s', (text, operation, kind) => {
    expect(detectOperation(text)).toEqual({ operation, kind });
  });
});

describe('2. what each operation needs — and only that', () => {
  const plan = (p: Partial<OperationPlan>): OperationPlan => ({ operation: 'other', records: [], changes: {}, patientDetails: {}, ...p });

  it('delete ALL: the patient — nothing else; no patient, only "for which patient"', () => {
    expect(missingFor(plan({ operation: 'delete_all', kind: 'medication', patient: 'Tom Baker' }), false)).toEqual([]);
    expect(missingFor(plan({ operation: 'delete_all', kind: 'medication' }), true)).toEqual([]);
    expect(questionFor(missingFor(plan({ operation: 'delete_all', kind: 'medication' }), false))).toBe('Which patient is this for?');
  });

  it('delete ONE: the patient and which record — no dose, route or frequency', () => {
    expect(missingFor(plan({ operation: 'delete_one', kind: 'medication', patient: 'Tom Baker', record: 'Gabapentin' }), false)).toEqual([]);
    expect(questionFor(missingFor(plan({ operation: 'delete_one', kind: 'medication', patient: 'Tom Baker' }), false))).toBe('Which medication would you like to delete for Tom Baker?');
  });

  it('ADD: the form\'s required fields (a drug: dose and frequency) — a diagnosis only its description', () => {
    const med = missingFor(plan({ operation: 'add', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin' } }] }), false);
    expect(questionFor(med)).toBe('I have the medication as Gabapentin. Please provide the missing information: dose and frequency.');
    expect(missingFor(plan({ operation: 'add', patient: 'Tom Baker', records: [{ kind: 'diagnosis', values: { description: 'Migraine' } }] }), false)).toEqual([]);
  });

  it('UPDATE: which record and what changes — only the fields being changed', () => {
    expect(missingFor(plan({ operation: 'update', kind: 'medication', patient: 'Tom Baker', record: 'Gabapentin', changes: { frequency: 'Twice daily' } }), false)).toEqual([]);
    expect(questionFor(missingFor(plan({ operation: 'update', kind: 'medication', patient: 'Tom Baker', record: 'Gabapentin' }), false))).toBe('What would you like to change for Gabapentin?');
  });

  it('VIEW: the patient — no clinical field', () => {
    expect(missingFor(plan({ operation: 'view', kind: 'medication', patient: 'Tom Baker' }), false)).toEqual([]);
    expect(questionFor(missingFor(plan({ operation: 'view', kind: 'medication' }), false))).toBe('Which patient is this for?');
  });

  it('patients: delete or change one needs the patient; a change also what changes', () => {
    expect(missingFor(plan({ operation: 'delete_one', kind: 'patient', patient: 'Tom Baker' }), false)).toEqual([]);
    expect(questionFor(missingFor(plan({ operation: 'delete_one', kind: 'patient' }), true))).toBe('Which patient would you like to delete?');
    expect(questionFor(missingFor(plan({ operation: 'update', kind: 'patient', patient: 'Tom Baker' }), true))).toBe('What would you like to change for Tom Baker?');
  });
});

// ---------------------------------------------------------------------------- 3. the Planning Agent

/** A planning model that reports what it is scripted to — right or wrong. */
class PlanningModel implements ChatLLM {
  readonly name = 'scripted:planning';
  constructor(private readonly report: Array<Record<string, unknown>> | null) {}
  async chat(_messages: ChatMessage[]): Promise<ChatTurn> {
    return this.report ? { content: '', toolCalls: [call('submit_requirements', { tasks: this.report })] } : { content: 'Nothing to report.', toolCalls: [] };
  }
}

const PATIENTS = [
  { id: 'p1', fullName: 'Tom Baker', mrn: 'MRN1' },
  { id: 'p2', fullName: 'Harry White', mrn: 'MRN2' },
  { id: 'p3', fullName: 'Luke King', mrn: 'MRN3' },
  { id: 'p4', fullName: 'Chloe Bell', mrn: 'MRN4' },
  { id: 'p5', fullName: 'Zoe Hill', mrn: 'MRN5' },
];

async function planFor(said: string, tasks: TaskRequest[], report: Array<Record<string, unknown>> | null, selected: string | null = null): Promise<RequirementDraft> {
  const ctx = { currentPatientId: selected, currentPatientName: selected ? PATIENTS.find((p) => p.id === selected)!.fullName : null } as AIContext;
  const runtime = { beginTurn: vi.fn(), endTurn: vi.fn() } as unknown as AppRuntime;
  const safety = new SafetyAgent({
    utterances: () => [said],
    today: () => dayjs('2026-10-02'),
    providerName: () => 'Dr. Lucy White',
    providers: () => ['Dr. Lucy White'],
    selectedPatient: () => (selected ? { id: selected, name: ctx.currentPatientName! } : null),
    patients: () => PATIENTS,
    known: (kind) => (kind === 'medication' ? ['Gabapentin', 'Metformin'] : []),
    recordLabel: () => undefined,
    openFormId: () => null,
    staged: () => [],
    discardStaged: () => undefined,
    findPatient: (raw) => {
      const words = raw.toLowerCase().trim().split(/\s+/);
      const hits = PATIENTS.filter((p) => words.every((w) => p.fullName.toLowerCase().split(' ').includes(w)));
      return hits.length === 1 ? { name: hits[0].fullName, options: [] } : { options: hits.map((p) => p.fullName) };
    },
  });
  const llm = new PlanningModel(report);
  const chat = vi.spyOn(llm, 'chat');
  const planner = new PlanningAgent(llm, runtime, () => ({ ...ctx }), 6, () => safety);
  const draft = await planner.plan(new TaskGraph(said, tasks), said, undefined, {});
  (draft as RequirementDraft & { modelAsked: number }).modelAsked = chat.mock.calls.length;
  return draft;
}
/** A task for a patient's records, given to the agent that owns their kind (one agent per kind). */
const summary = (instruction: string, execution: TaskRequest['executionType'] = 'WRITE'): TaskRequest[] => {
  const kind = detectOperation(instruction).kind;
  return [{ id: 't1', agent: (kind && kind !== 'patient' ? recordOwner(kind) : undefined) ?? 'medications', instruction, executionType: execution }];
};

describe('3. the Planning Agent: the operation decides the requirements', () => {
  it('Example 1 — "Delete all medications for Tom Baker": DELETE_ALL, patient Tom Baker, nothing missing, confirmation required', async () => {
    const said = 'Delete all medications for Tom Baker';
    // Exactly the bug: the planning model filed it as an add of a medication with nothing said.
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication' }] }]);
    expect(draft.question).toBeNull();
    expect(draft.missing).toEqual([]);
    expect(draft.actions[0]).toMatchObject({ action: 'delete_records', scope: 'all', kind: 'medication', patient: 'Tom Baker', records: [] });
    expect(draft.approved.t1).toEqual([
      "operation: delete ALL of the patient's medications — delete_record with all: true (no record, no field)",
      'patient: Tom Baker',
      'confirmation: required — the app shows what will be deleted and the provider confirms; never confirm it yourself',
    ]);
    expect(draft.findings).toContainEqual(expect.objectContaining({ field: 't1 · operation', value: 'add_records', corrected: 'delete_records (all)' }));
    expect(JSON.stringify(draft)).not.toMatch(ADD_MED_QUESTION);
  });

  it('Example 1, with a model that reports it right — and with one that reports nothing', async () => {
    const said = 'Delete all medications for Tom Baker';
    const right = await planFor(said, summary(said), [{ task: 't1', action: 'delete_records', kind: 'medication', scope: 'all', patient: 'Tom Baker' }]);
    expect(right).toMatchObject({ question: null, findings: [] });
    const silent = await planFor(said, summary(said), null, 'p1');
    expect(silent.question).toBeNull();
    expect(silent.actions[0]).toMatchObject({ action: 'delete_records', scope: 'all', kind: 'medication' });
  });

  it('Example 2 — "Delete Gabapentin for Tom Baker": DELETE_MEDICATION, record Gabapentin, nothing missing, confirmation required', async () => {
    const said = 'Delete Gabapentin for Tom Baker';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin' } }] }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0]).toMatchObject({ action: 'delete_records', scope: 'one', kind: 'medication', record: 'Gabapentin', patient: 'Tom Baker' });
    expect(draft.approved.t1).toEqual(['operation: delete one medication — record: Gabapentin', 'patient: Tom Baker', expect.stringMatching(/^confirmation: required/)]);
  });

  it('Example 3 — "Add Gabapentin to Tom Baker": ADD_MEDICATION, asks only what the medication form requires', async () => {
    const said = 'Add Gabapentin to Tom Baker';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin' } }] }]);
    expect(draft.actions[0]).toMatchObject({ action: 'add_records', patient: 'Tom Baker' });
    expect(draft.question).toBe('I have the medication as Gabapentin. Please provide the missing information: dose and frequency.');
  });

  it('Example 4 — "Change Gabapentin frequency for Tom Baker to twice daily": UPDATE_MEDICATION, frequency only — no dose, no route', async () => {
    const said = 'Change Gabapentin frequency for Tom Baker to twice daily';
    // The model files it as an add again: the name becomes the record, the rest the change.
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin', frequency: 'twice daily' } }] }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0]).toMatchObject({ action: 'update_record', kind: 'medication', record: 'Gabapentin', patient: 'Tom Baker', changes: { frequency: 'twice daily' } }); // the provider's words — the form makes it "Twice daily"
    expect(draft.approved.t1).toEqual(['operation: change one medication — record: Gabapentin — only the fields below; nothing else is asked or changed', 'patient: Tom Baker', 'change: frequency = twice daily']);
    expect(JSON.stringify(draft)).not.toMatch(/dosage|route/);
  });

  it('an update that says what to change nothing about asks what should change — never the add\'s fields', async () => {
    const said = 'Change Gabapentin for Tom Baker';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'update_record', kind: 'medication', record: 'Gabapentin', patient: 'Tom Baker' }]);
    expect(draft.question).toBe('What would you like to change for Gabapentin?');
  });

  it('a record the provider never named is not deleted on the model\'s word: "delete the medication" asks which', async () => {
    const said = 'Delete the medication for Tom Baker';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'delete_records', kind: 'medication', scope: 'one', record: 'Metformin', patient: 'Tom Baker' }]);
    expect(draft.question).toBe('Which medication would you like to delete for Tom Baker?');
  });

  it('a model that says "all" when the provider named one: the words win — one record', async () => {
    const said = 'Delete Gabapentin for Tom Baker';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'delete_records', kind: 'medication', scope: 'all', patient: 'Tom Baker' }]);
    expect(draft.actions[0]).toMatchObject({ action: 'delete_records', scope: 'one' });
    // The model did not report which — but the provider SAID it ("Gabapentin"): they are not asked again; the
    // specialist takes it from their words, and the Safety Agent checks it at delete_record.
    expect(draft.question).toBeNull();
    expect(draft.approved.t1[0]).toBe('operation: delete one medication');
    // Nothing named at all ("delete the medication"): asked which — never guessed.
    const vague = await planFor('Delete the medication for Tom Baker', summary('Delete the medication for Tom Baker'), [{ task: 't1', action: 'delete_records', kind: 'medication', scope: 'all', patient: 'Tom Baker' }]);
    expect(vague.question).toBe('Which medication would you like to delete for Tom Baker?');
  });

  it('VIEW: "Show Tom Baker\'s medications" needs only the patient — with one selected, no model is even asked', async () => {
    const said = "Show Tom Baker's medications";
    const draft = await planFor(said, summary(said, 'READ_ONLY'), [{ task: 't1', action: 'view_records', kind: 'medication', patient: 'Tom Baker' }]);
    expect(draft).toMatchObject({ question: null });
    expect(draft.actions[0]).toMatchObject({ action: 'view_records', kind: 'medication', patient: 'Tom Baker' });
    const selected = await planFor('show his medications', summary('Show the medications', 'READ_ONLY'), null, 'p1');
    expect(selected.question).toBeNull();
    expect((selected as RequirementDraft & { modelAsked: number }).modelAsked).toBe(0);
    const nobody = await planFor('show the medications', summary('Show the medications', 'READ_ONLY'), null);
    expect(nobody.question).toBe('Which patient is this for?');
  });

  describe('the same rules for every kind of record', () => {
    it.each([
      ['Delete all diagnoses for Tom Baker', 'diagnosis'],
      ['Delete all tasks for Tom Baker', 'task'],
      ['Delete all recalls for Tom Baker', 'recall'],
    ])('"%s": delete ALL — nothing asked', async (said, kind) => {
      const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind }] }]);
      expect(draft.question).toBeNull();
      expect(draft.actions[0]).toMatchObject({ action: 'delete_records', scope: 'all', kind });
    });

    it('"Delete all appointments for Tom Baker" (My Appointment Agent): delete ALL — no date, time or reason asked', async () => {
      const said = 'Delete all appointments for Tom Baker';
      const draft = await planFor(said, [{ id: 't1', agent: 'appointments', instruction: said, executionType: 'WRITE' }], [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'appointment' }] }]);
      expect(draft.question).toBeNull();
      expect(draft.actions[0]).toMatchObject({ action: 'delete_records', scope: 'all', kind: 'appointment' });
    });

    it('"Mark the blood pressure task as completed": update — the status only, no title or due date asked', async () => {
      const said = 'Mark the blood pressure task for Tom Baker as completed';
      const draft = await planFor(said, summary(said), [{ task: 't1', action: 'update_record', kind: 'task', record: 'blood pressure', patient: 'Tom Baker', changes: { status: 'Completed' } }]);
      expect(draft.question).toBeNull();
      expect(draft.approved.t1).toContain('change: status = Completed');
    });

    it('"Delete the hypertension diagnosis for Tom Baker": delete one — nothing clinical asked', async () => {
      const said = 'Delete the hypertension diagnosis for Tom Baker';
      const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'diagnosis', values: { description: 'Hypertension' } }] }]);
      expect(draft.question).toBeNull();
      expect(draft.actions[0]).toMatchObject({ action: 'delete_records', scope: 'one', kind: 'diagnosis', record: 'Hypertension' });
    });

    it('patients: "Delete patient Tom Baker" needs only the patient; "Change Tom Baker\'s phone to 0300 1234567" only the phone', async () => {
      const del = await planFor('Delete patient Tom Baker', [{ id: 't1', agent: 'patients', instruction: 'Delete patient Tom Baker', executionType: 'WRITE' }], [{ task: 't1', action: 'delete_records', kind: 'patient', patient: 'Tom Baker' }]);
      expect(del.question).toBeNull();
      expect(del.approved.t1).toContain('patient: Tom Baker');
      expect(del.approved.t1.at(-1)).toMatch(/^confirmation: required/);
      const said = "Change Tom Baker's phone to 0300 1234567";
      const edit = await planFor(said, [{ id: 't1', agent: 'patients', instruction: said, executionType: 'WRITE' }], [{ task: 't1', action: 'update_record', kind: 'patient', patient: 'Tom Baker', changes: { phone: '0300 1234567' } }]);
      expect(edit.question).toBeNull();
      expect(edit.approved.t1).toContain('change: phone = 0300 1234567');
      expect(JSON.stringify(edit)).not.toMatch(/date of birth|gender|first name/i);
    });
  });
});

// ---------------------------------------------------------------------------- 4. the Safety Agent at the call

describe('4. the Safety Agent validates the operation being performed', () => {
  const gate = (said: string) =>
    new SafetyAgent({
      utterances: () => [said],
      today: () => dayjs('2026-10-02'),
      providerName: () => 'Dr. Lucy White',
      providers: () => ['Dr. Lucy White'],
      selectedPatient: () => ({ id: 'p1', name: 'Tom Baker' }),
      patients: () => PATIENTS,
      known: () => ['Gabapentin'],
      recordLabel: () => undefined,
      openFormId: () => null,
      staged: () => [],
      discardStaged: () => undefined,
    });
  const c = (name: string, args: Record<string, unknown>): ToolCall => ({ name, arguments: args });

  it('"Delete all medications for Tom Baker": delete_record all — goes through; a record the model added to it is dropped', () => {
    const s = gate('Delete all medications for Tom Baker');
    expect(s.check(c('delete_record', { kind: 'medication', all: true, patient: 'Tom Baker' }))).toEqual({ kind: 'allow', findings: [] });
    expect(s.check(c('delete_record', { kind: 'medication', all: true, record: 'Metformin' }))).toMatchObject({ kind: 'rewrite', args: { kind: 'medication', all: true } });
  });

  it('…and an ADD for it is refused back to the agent — never "Which medication, at what dose…" to the provider', () => {
    const verdict = gate('Delete all medications for Tom Baker').check(c('add_medications', { medications: [{ medicationName: 'Medication' }] }));
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') return;
    expect(verdict.result.ok).toBe(false);
    expect(verdict.result.awaitUser).toBeUndefined(); // the agent corrects itself; the provider is not asked
    expect(verdict.result.message).toMatch(/asked to delete all of them, not to add anything\. Use delete_record with all: true/);
    expect(verdict.result.message).not.toMatch(ADD_MED_QUESTION);
  });

  it('"all" the provider did not say is never assumed: delete_record all for "delete the medication" asks which', () => {
    const verdict = gate('Delete the medication').check(c('delete_record', { kind: 'medication', all: true }));
    expect(verdict.kind).toBe('ask');
    if (verdict.kind === 'ask') expect(verdict.result.message).toBe('Which medication would you like to delete?');
  });

  it('"Change Gabapentin frequency to twice daily": update_record with the frequency only — allowed, nothing about dose or route', () => {
    const s = gate('Change Gabapentin frequency for Tom Baker to twice daily');
    expect(s.check(c('update_record', { kind: 'medication', record: 'Gabapentin', changes: { frequency: 'Twice daily' } })).kind).toBe('allow');
    expect(s.check(c('add_medications', { medications: [{ medicationName: 'Gabapentin', frequency: 'Twice daily' }] })).kind).toBe('refuse');
  });

  it('"Delete Gabapentin for Tom Baker": delete_record of the record named — allowed', () => {
    expect(gate('Delete Gabapentin for Tom Baker').check(c('delete_record', { kind: 'medication', record: 'Gabapentin' })).kind).toBe('allow');
  });

  it('a request that also adds ("stop aspirin and add metformin") is not refused for its add', () => {
    const verdict = gate('stop aspirin and add metformin 500 mg by mouth twice daily').check(c('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency: 'Twice daily' }] }));
    expect(verdict.kind).not.toBe('refuse');
  });
});

// ---------------------------------------------------------------------------- 5. the requests from testing

/**
 * The basic requests from testing, with the reports qwen3.5:9b ACTUALLY sent (Kaggle): it leaves values out,
 * puts them on the task instead of in records, sends the task to the wrong agent. A complete request still
 * goes through — what the provider said is never asked again, whatever the model reported.
 */
describe('5. complete requests go through, whatever the planning model left out', () => {
  const patientsTask = (instruction: string): TaskRequest[] => [{ id: 't1', agent: 'patients', instruction, executionType: 'WRITE' }];

  it('"Add Panadol 500 mg twice daily to Luke King" handed to the Patients Agent: a medication, not a new patient — moved to the Medication Agent, nothing asked', async () => {
    const said = 'Add Panadol 500 mg twice daily to Luke King.';
    const draft = await planFor(said, patientsTask(said), [{ task: 't1', action: 'add_records', kind: 'medication', patient: 'Luke King', records: [{ kind: 'medication', values: { dosage: '500 mg', frequency: 'twice daily', medicationName: 'Panadol' } }] }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0]).toMatchObject({ action: 'add_records', agent: 'medications', patient: 'Luke King' });
    expect(draft.findings).toContainEqual(expect.objectContaining({ field: 't1 · agent', value: 'patients', corrected: 'medications' }));
    expect(JSON.stringify(draft)).not.toMatch(/new patient|first name/i);
  });

  it('"Add Gabapentin 500 mg twice daily for 50 days by orally to Tom Baker" — the model left the drug out: not asked, it was said', async () => {
    const said = 'Add Gabapentin 500 mg twice daily for 50 days by orally to Tom Baker.';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { dosage: '500 mg', duration: '50 days', frequency: 'twice daily', route: 'orally' } }] }]);
    expect(draft.question).toBeNull();
  });

  it('"Add Metformin 500 mg once daily by oral to Chloe Bell" (to the Patients Agent): nothing asked', async () => {
    const said = 'Add Metformin 500 mg once daily by oral to Chloe Bell.';
    const draft = await planFor(said, patientsTask(said), [{ task: 't1', action: 'add_records', kind: 'medication', patient: 'Chloe Bell', records: [{ kind: 'medication', values: { dosage: '500 mg', frequency: 'once daily', medicationName: 'Metformin', route: 'oral' } }] }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0].agent).toBe('medications');
  });

  it('"Create a task for Zoe Hill to monitor blood pressure every morning" — values on the task, the patient as assignee: nothing asked', async () => {
    const said = 'Create a task for Zoe Hill to monitor blood pressure every morning.';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', kind: 'task', values: { assignedTo: 'Zoe Hill', title: 'monitor blood pressure every morning' } }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0].records[0].values).toMatchObject({ title: 'monitor blood pressure every morning' });
  });

  it('"create a task for blood pressure monitoring for tom baker": nothing asked', async () => {
    const said = 'create a task for blood pressure monitoring for tom baker';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'task', values: { title: 'blood pressure monitoring' } }] }]);
    expect(draft.question).toBeNull();
  });

  it('"Recall Luke King after two weeks" — the request itself as the reason: only what the recall is for is asked (the date and the patient were said)', async () => {
    const said = 'Recall Luke King after two weeks.';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', records: [{ kind: 'recall', values: { reason: 'Recall Luke King after two weeks' } }] }]);
    expect(draft.question).toBe('What is the reason for the recall for Luke King?');
  });

  it('"Schedule a follow-up appointment for Tom Baker next Tuesday at 3 PM" — a wrong date, "3 PM", values on the task: nothing asked', async () => {
    const said = 'Schedule a follow-up appointment for Tom Baker next Tuesday at 3 PM.';
    const draft = await planFor(said, [{ id: 't1', agent: 'appointments', instruction: said, executionType: 'WRITE' }], [{ task: 't1', action: 'add_records', kind: 'appointment', values: { date: '2026-10-05', providerName: 'Dr. Lucy White', reason: 'follow-up', startTime: '3 PM' } }]);
    expect(draft.question).toBeNull();
  });

  it('…and a request with nothing said still asks: "add medication and add diagnosis"', async () => {
    const said = 'add medication and add diagnosis';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', records: [{ kind: 'medication' }, { kind: 'diagnosis' }] }], 'p1');
    expect(draft.question).toBe('What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
  });
});

describe('6. several records of one kind in one report stay several', () => {
  it('"…add medication metformin, Panadol, gabapentin, rituximab 500 mg twice daily for 30 days…": four medications, nothing asked', async () => {
    const said = 'add medication metformin, Panadol, gabapentin, rituximab 500 mg twice daily for 30 days to Tom Baker';
    // What qwen3.5:4b reported: the dose only on the last one.
    const draft = await planFor(said, summary(said), [
      {
        task: 't1',
        action: 'add_records',
        patient: 'Tom Baker',
        records: [
          { kind: 'medication', values: { medicationName: 'metformin' } },
          { kind: 'medication', values: { medicationName: 'Panadol' } },
          { kind: 'medication', values: { medicationName: 'gabapentin' } },
          { kind: 'medication', values: { medicationName: 'rituximab', dosage: '500 mg', frequency: 'twice daily', duration: '30 days' } },
        ],
      },
    ]);
    expect(draft.actions[0].records.map((r) => r.values.medicationName)).toEqual(['metformin', 'Panadol', 'gabapentin', 'rituximab']);
    expect(draft.question).toBeNull(); // the dose and frequency said once are in the words — the specialist applies them to each
  });
});

describe('7. what qwen3.5:9b got wrong on Kaggle — put right from the provider\'s words', () => {
  it('"Create a task for Zoe Hill …" with Zoe Hill as the assignee: a patient is no provider — the task is FOR Zoe Hill', async () => {
    const said = 'Create a task for Zoe Hill to monitor blood pressure every morning.';
    const draft = await planFor(said, [{ id: 't1', agent: 'patients', instruction: said, executionType: 'WRITE' }], [{ task: 't1', action: 'add_records', kind: 'task', values: { assignedTo: 'Zoe Hill', title: 'monitor blood pressure every morning' } }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0]).toMatchObject({ agent: 'tasks', patient: 'Zoe Hill' });
    expect(draft.actions[0].records[0].values).toEqual({ title: 'monitor blood pressure every morning' }); // no "assignedTo: Zoe Hill"
  });

  it('…and at the tool: add_tasks with the patient as assignee and no patient — the patient said is put in, the assignee taken out', () => {
    const s = new SafetyAgent({
      utterances: () => ['Create a task for Zoe Hill to monitor blood pressure every morning.'],
      today: () => dayjs('2026-10-02'),
      providerName: () => 'Dr. Lucy White',
      providers: () => ['Dr. Lucy White', 'Dr. Ben Adams'],
      selectedPatient: () => null,
      patients: () => PATIENTS,
      known: () => [],
      recordLabel: () => undefined,
      openFormId: () => null,
      staged: () => [],
      discardStaged: () => undefined,
    });
    const verdict = s.check({ name: 'add_tasks', arguments: { tasks: [{ assignedTo: 'Zoe Hill', title: 'monitor blood pressure every morning' }] } });
    expect(verdict).toMatchObject({ kind: 'rewrite', args: { tasks: [{ title: 'monitor blood pressure every morning', patient: 'Zoe Hill' }] } });
    if (verdict.kind === 'rewrite') expect((verdict.args.tasks as Array<Record<string, unknown>>)[0].assignedTo).toBeUndefined();
  });

  it('"Find and select patient Chloe Bell, then add Metformin …" as ONE Patients task, reported as select + add: two tasks — the add is the Medication Agent\'s, after the select', async () => {
    const said = 'Add Metformin 500 mg twice daily by oral to Chloe Bell.';
    const instruction = 'Find and select patient Chloe Bell, then add Metformin 500 mg twice daily by oral to her medications.';
    const graph = new TaskGraph(said, [{ id: 't1', agent: 'patients', instruction, executionType: 'WRITE' }]);
    const runtime = { beginTurn: vi.fn(), endTurn: vi.fn() } as unknown as AppRuntime;
    const safety = new SafetyAgent({
      utterances: () => [said],
      today: () => dayjs('2026-10-02'),
      providerName: () => 'Dr. Lucy White',
      providers: () => ['Dr. Lucy White'],
      selectedPatient: () => null,
      patients: () => PATIENTS,
      known: () => ['Metformin'],
      recordLabel: () => undefined,
      openFormId: () => null,
      staged: () => [],
      discardStaged: () => undefined,
    });
    const report = [
      { action: 'select_patient', patient: 'Chloe Bell', task: 't1' },
      { action: 'add_records', records: [{ kind: 'medication', values: { dosage: '500 mg', frequency: 'twice daily', route: 'oral' } }], task: 't1' },
    ];
    const planner = new PlanningAgent(new PlanningModel(report), runtime, () => ({ currentPatientId: null, currentPatientName: null }) as AIContext, 6, () => safety);
    const draft = await planner.plan(graph, said, undefined, {});
    expect(draft.question).toBeNull(); // Metformin was said: not asked again
    expect(graph.tasks.map((t) => [t.id, t.agent, t.dependsOn])).toEqual([
      ['t1', 'patients', []],
      ['t2', 'medications', ['t1']],
    ]);
    expect(draft.approved.t1).toEqual(['patient: Chloe Bell', expect.stringMatching(/^only the select patient part: the add records part is task t2 \(the medications agent's\)/)]);
    expect(draft.approved.t2).toEqual(expect.arrayContaining(['medication 1: dosage = 500 mg, frequency = twice daily, route = oral']));
  });
});

describe('8. a dose said once after a list of drugs is each drug\'s', () => {
  const gate = (said: string) =>
    new SafetyAgent({
      utterances: () => [said],
      today: () => dayjs('2026-10-02'),
      providerName: () => 'Dr. Lucy White',
      providers: () => ['Dr. Lucy White'],
      selectedPatient: () => ({ id: 'p1', name: 'Tom Baker' }),
      patients: () => PATIENTS,
      known: () => [],
      recordLabel: () => undefined,
      openFormId: () => null,
      staged: () => [],
      discardStaged: () => undefined,
    });

  it('"metformin, Panadol, gabapentin, rituximab 500 mg twice daily for 30 days": the call that gives it to one gives it to all four', () => {
    const s = gate('add medication metformin, Panadol, gabapentin, rituximab 500 mg twice daily for 30 days');
    // What qwen3.5:9b sent on Kaggle, after being sent back once.
    const verdict = s.check({ name: 'add_care_plan', arguments: { medications: [{ medicationName: 'metformin' }, { medicationName: 'Panadol' }, { medicationName: 'gabapentin', dosage: '500 mg', frequency: 'Twice daily', duration: '30 days' }, { medicationName: 'rituximab' }] } });
    expect(verdict.kind).toBe('rewrite');
    if (verdict.kind !== 'rewrite') return;
    for (const med of verdict.args.medications as Array<Record<string, unknown>>) expect(med).toMatchObject({ dosage: '500 mg', frequency: 'Twice daily', duration: '30 days' });
  });

  it('"metformin 500 mg twice daily and Panadol": Panadol comes after the dose — it gets nothing; its dose is asked', () => {
    const verdict = gate('add metformin 500 mg twice daily and panadol').check({ name: 'add_medications', arguments: { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }, { medicationName: 'Panadol' }] } });
    expect(verdict.kind).toBe('ask');
    if (verdict.kind === 'ask') expect(verdict.result.message).toBe('I have the medication as Panadol. Please provide the missing information: dose and frequency.');
  });

  it('two different doses said: nothing is shared', () => {
    const verdict = gate('add metformin 500 mg and amlodipine 5 mg once daily').check({ name: 'add_medications', arguments: { medications: [{ medicationName: 'Metformin', dosage: '500 mg' }, { medicationName: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily' }] } });
    if (verdict.kind === 'rewrite') expect((verdict.args.medications as Array<Record<string, unknown>>)[0].frequency).toBeUndefined();
  });
});

describe('9. what small models send is read for what it means — its shape mended, nothing added', () => {
  it('one task on its own, its records as JSON text (qwen3.5:4b): the report it meant', async () => {
    const { normalizeReport } = await import('../agents/planning');
    const sent = { task: 't1', action: 'add_records', patient: 'Tom Baker', records: '[{"kind": "medication", "values": {"medicationName": "Gabapentin", "dosage": "500 mg"}}]' };
    expect(normalizeReport(sent)).toEqual({ tasks: [{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin', dosage: '500 mg' } }] }] });
    expect(normalizeReport({ tasks: '[{"task":"t1","action":"select_patient","patient":"Luke King"}]' })).toEqual({ tasks: [{ task: 't1', action: 'select_patient', patient: 'Luke King' }] });
    expect(normalizeReport({})).toEqual({ tasks: [] });
  });

  it('…and the Planning Agent takes it: "Add Gabapentin … to Tom Baker" goes through', async () => {
    const said = 'Add Gabapentin 500 mg twice daily for 50 days by orally to Tom Baker.';
    class FlatModel extends PlanningModel {
      async chat() {
        return { content: '', toolCalls: [call('submit_requirements', { task: 't1', action: 'add_records', patient: 'Tom Baker', records: '[{"kind": "medication", "values": {"medicationName": "Gabapentin", "dosage": "500 mg", "frequency": "twice daily"}}]' })] };
      }
    }
    const runtime = { beginTurn: vi.fn(), endTurn: vi.fn() } as unknown as AppRuntime;
    const planner = new PlanningAgent(new FlatModel(null), runtime, () => ({ currentPatientId: null, currentPatientName: null }) as AIContext, 6, () => null);
    const draft = await planner.plan(new TaskGraph(said, summary(said)), said, undefined, {});
    expect(draft.actions[0]).toMatchObject({ action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin', dosage: '500 mg', frequency: 'twice daily' } }] });
    expect(draft.question).toBeNull();
  });
});

describe('10. a "new patient" reported with records is an add for the patient named (qwen3.5:4b, multi-agent)', () => {
  it('"Add Metformin 500 mg once daily by oral to Chloe Bell" reported as create_patient: the medication for Chloe Bell — nobody new', async () => {
    const said = 'Add Metformin 500 mg once daily by oral to Chloe Bell.';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'create_patient', patient_details: { firstName: 'Chloe', lastName: 'Bell' }, records: [{ kind: 'medication', values: { medicationName: 'Metformin', dosage: '500 mg', frequency: 'once daily' } }] }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0]).toMatchObject({ action: 'add_records', patient: 'Chloe Bell', patientDetails: {} });
  });
});

describe('11. an add_* call as small models send it', () => {
  it('one record on its own, or as JSON text: the list it means', async () => {
    const { listShaped } = await import('../agent/tools');
    const fields = ['date', 'startTime', 'reason', 'patient'];
    expect(listShaped({ date: '2026-10-06', startTime: '15:00', reason: 'Follow-up', patient: 'Tom Baker' }, 'appointments', fields)).toEqual({ appointments: [{ date: '2026-10-06', startTime: '15:00', reason: 'Follow-up' }], patient: 'Tom Baker' });
    expect(listShaped({ appointments: { date: '2026-10-06' } }, 'appointments', fields)).toEqual({ appointments: [{ date: '2026-10-06' }] });
    expect(listShaped({ appointments: '[{"date": "2026-10-06"}]', for_patients: '["Tom Baker"]' }, 'appointments', fields)).toEqual({ appointments: [{ date: '2026-10-06' }], for_patients: ['Tom Baker'] });
  });
});

describe('12. what qwen3.5:9b reported on Kaggle (single and multi-agent) — read right', () => {
  it('"Create a task for Luke King" reported as a NEW patient Luke King — he is on file: only what the task is, is asked', async () => {
    const said = 'Create a task for Luke King.';
    const draft = await planFor(said, summary(said), [{ action: 'create_patient', kind: 'patient', patient_details: { firstName: 'Luke', lastName: 'King' }, task: 't1' }]);
    expect(draft.question).toBe('What task would you like to create for Luke King?');
  });

  it('four patients sent as one ("Luke King, Tom Baker, Chloe Bell, and Zoe Hill"): each of them — nothing asked', async () => {
    const said = 'Add Panadol 500 mg twice daily to Luke King, Tom Baker, Chloe Bell, and Zoe Hill.';
    const draft = await planFor(said, summary(said), [{ task: 't1', action: 'add_records', patient: 'Luke King, Tom Baker, Chloe Bell, and Zoe Hill', records: [{ kind: 'medication', values: { medicationName: 'Panadol', dosage: '500 mg', frequency: 'twice daily' } }] }]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0].forPatients).toEqual(['Luke King', 'Tom Baker', 'Chloe Bell', 'Zoe Hill']);
  });

  it('one task reported twice, each for another patient: each record keeps its own patient — nothing asked', async () => {
    const said = 'For Luke King add Panadol 500 mg twice daily. For Tom Baker add Gabapentin 500 mg once daily. Do not change anything for the other patients.';
    const draft = await planFor(said, summary(said), [
      { task: 't1', action: 'add_records', patient: 'Luke King', records: [{ kind: 'medication', values: { medicationName: 'Panadol', dosage: '500 mg', frequency: 'twice daily' } }] },
      { task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin', dosage: '500 mg', frequency: 'once daily' } }] },
    ]);
    expect(draft.question).toBeNull();
    expect(draft.actions[0].records.map((r) => [r.values.medicationName, r.values.patient])).toEqual([
      ['Panadol', 'Luke King'],
      ['Gabapentin', 'Tom Baker'],
    ]);
  });

  it('"… recall him after two weeks …" with the drug left out of the report: "gabapentin" is no reason for the recall — the reason is asked', async () => {
    const said = 'Select Tom Baker, add Gabapentin 500 mg twice daily for 50 days, create a blood pressure monitoring task, recall him after two weeks, and schedule a follow-up appointment next Tuesday at 3 PM.';
    const draft = await planFor(said, summary(said), [
      { action: 'select_patient', patient: 'Tom Baker', task: 't1' },
      { action: 'add_records', task: 't1', records: [{ kind: 'medication', values: { dosage: '500 mg', duration: '50 days', frequency: 'twice daily' } }, { kind: 'task', values: { title: 'blood pressure monitoring' } }, { kind: 'recall', values: { dueDate: 'after two weeks' } }, { kind: 'appointment', values: { date: 'next Tuesday', startTime: '3 PM' } }] },
    ]);
    expect(draft.question).toMatch(/reason for the recall/);
    expect(draft.question).not.toMatch(/dose|medication|visit/);
  });

  it('"Remove the patient\'s diagnosis and replace it with a more appropriate diagnosis": "replace" names no diagnosis — asked which', async () => {
    const said = "Remove the patient's diagnosis and replace it with a more appropriate diagnosis.";
    const draft = await planFor(said, summary(said), [
      { action: 'update_record', changes: { description: 'more appropriate diagnosis' }, kind: 'diagnosis', record: 'the current one (to be removed)', task: 't1' },
      { action: 'delete_records', kind: 'diagnosis', record: 'the current one', scope: 'one', task: 't1' },
    ], 'p1');
    expect(draft.question).toMatch(/Which diagnosis would you like to (change|delete)/);
  });
});

describe('13. more of what qwen3.5:9b sent', () => {
  it('"update Tom Baker\'s meds, gabapentin 500, twice a day": 500 what? — the dose is asked, never taken as 500 mg', async () => {
    const said = "I need you to update Tom Baker's meds, gabapentin 500, twice a day, you know the usual duration.";
    const draft = await planFor(said, summary(said), [{ action: 'update_record', changes: { dosage: '500', frequency: 'twice a day' }, kind: 'medication', patient: 'Tom Baker', record: 'Gabapentin', task: 't1' }]);
    expect(draft.question).toBe('What dose should be prescribed for Gabapentin?');
  });

  it('the report as "{…}, {…}" text, "add metformin" with no "medication" said: read — and the dose and the booking time are asked', async () => {
    const said = 'Go to patients, find Chloe Bell, add metformin, make a blood pressure task, and book him for next Tuesday afternoon.';
    const report = '{"task": "t1", "action": "select_patient", "patient": "Chloe Bell"}, {"task": "t1", "action": "add_records", "records": [{"kind": "medication", "values": {"medicationName": "metformin"}}]}';
    const { normalizeReport } = await import('../agents/planning');
    expect((normalizeReport({ tasks: report }) as { tasks: unknown[] }).tasks).toHaveLength(2);
    const draft = await planFor(said, summary(said), null);
    // Each kind its own agent's task, side by side: medication, task and appointment — none lost.
    expect(draft.actions.map((a) => [a.agent, a.records.map((r) => r.kind)])).toHaveLength(3);
    expect(draft.actions.map((a) => [a.agent, a.records.map((r) => r.kind)])).toEqual(
      expect.arrayContaining([
        ['medications', ['medication']],
        ['tasks', ['task']],
        ['patient_appointments', ['appointment']],
      ]),
    );
    expect(draft.question).toMatch(/dose|how often/);
    expect(draft.question).toMatch(/time/);
  });
});

describe('14. what a record is for comes from its own part of the request', () => {
  it('the model reported nothing: "…create a task for blood pressure monitoring, recall him in two weeks…" — the recall\'s reason is asked, not the task\'s title', async () => {
    const said = 'Go to the patients section and find Luke King. Add Panadol to his medications, use a normal adult dose and whatever frequency makes sense, then add Gabapentin 500 mg twice daily for 30 days. Also create a task for blood pressure monitoring, recall him in two weeks, and schedule a follow-up next Tuesday at 3 PM. If anything is missing, just use the most appropriate value.';
    const draft = await planFor(said, summary(said), [{ action: 'other', task: 't1' }]);
    expect(draft.question).toMatch(/reason for the recall/);
    expect(draft.question).not.toMatch(/What task/);
  });

  it('a select reported WITH the records: they are added for that patient', async () => {
    const said = 'Select Tom Baker, add Gabapentin 500 mg twice daily for 50 days, create a blood pressure monitoring task, recall him after two weeks, and schedule a follow-up appointment next Tuesday at 3 PM.';
    const draft = await planFor(said, summary(said), [{ action: 'select_patient', patient: 'Tom Baker', task: 't1', records: [{ kind: 'medication', values: { medicationName: 'Gabapentin', dosage: '500 mg', frequency: 'twice daily' } }, { kind: 'recall', values: { dueDate: '2 weeks' } }] }]);
    expect(draft.actions[0]).toMatchObject({ action: 'add_records', patient: 'Tom Baker' });
    expect(draft.question).toMatch(/reason for the recall/);
  });
});

/**
 * The two cases the Safety and Planning Agents exist for, against the real application (real runtime, forms,
 * store and screen) — with a model that does what a small model did in testing: it fills in what nobody said.
 *
 *   "add medication and add diagnosis"     → no Panadol, no 500 mg, no Hypertension: the provider is asked
 *   "go to patients and select patient"    → no patient picked: "Which patient would you like to select?"
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import { recordSlices } from '@/store/slices/recordSlices';
import { voiceActions } from '@/store/slices/voiceSlice';
import { RECORD_KINDS, type RecordKind } from '@/types/records';
import type { ToolCall } from '@/types/ai';
import { getVoiceController } from '@/services/ai/voiceController';
import { router } from '@/app/router';
import type { ChatLLM, ChatMessage, ChatTurn } from '@/services/ai/providers/llm';
import { call, FakeMic, type ScriptedLLM } from '@/services/ai/__tests__/fakes';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, useScriptedModel, waitUntil } from './harness';

const TIMEOUT = 60000;

beforeAll(installBrowserStubs);

beforeEach(async () => {
  store.dispatch(voiceActions.resetVoice());
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchProviders()).unwrap();
  for (const kind of RECORD_KINDS) await store.dispatch((recordSlices[kind] as (typeof recordSlices)['medication']).fetchAll()).unwrap();
});

afterEach(async () => {
  await unmountApp();
});

const harry = () => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Harry White')!;
const owned = (kind: RecordKind, patientId: string) => (recordSlices[kind].selectors.selectAll(store.getState()) as Array<{ patientId: string }>).filter((r) => r.patientId === patientId).length;
const safetyEvents = () => store.getState().monitor.events.filter((e) => e.type.startsWith('safety.'));

describe('single-agent mode: the Safety Agent between the assistant and its tools', () => {
  let model: ScriptedLLM;
  beforeEach(() => {
    model = useScriptedModel();
  });

  it('"add medication and add diagnosis": the model\'s Panadol 500 mg twice daily and Hypertension never reach the app — the provider is asked, and their own words are used', async () => {
    store.dispatch(setCurrentPatient(harry().id));
    await renderAppAt('/summary');
    const before = { medication: owned('medication', harry().id), diagnosis: owned('diagnosis', harry().id) };
    model.then({
      calls: [
        call('add_care_plan', {
          medications: [{ medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily', duration: '5 days' }],
          diagnoses: [{ description: 'Hypertension' }],
        }),
      ],
    });
    await say('add medication and add diagnosis');

    // Nothing opened, nothing filled — the provider is asked what they want, with a fixed question.
    expect(store.getState().voice.response).toBe('What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
    expect(document.querySelector('.care-plan-modal')).toBeNull(); // no care plan opened, nothing filled in
    expect(pageText()).not.toContain('Care plan (');
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    const blocked = safetyEvents().find((e) => e.type === 'safety.blocked')!;
    expect(blocked.findings!.map((f) => f.value)).toEqual(['Panadol', '500 mg', 'Twice daily', '5 days', 'Hypertension']);

    // The provider says what they want: that — and only that — goes into the care plan.
    model.then(
      { calls: [call('add_care_plan', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }], diagnoses: [{ description: 'Type 2 diabetes mellitus' }] })] },
      { content: 'Please review and confirm the care plan.' },
    );
    // The route the model left out was said: it is the provider's, so it goes on.
    await say('metformin 500 milligrams by mouth twice a day and type 2 diabetes');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'care_plan');
    const values = (field: string) => [...document.querySelectorAll<HTMLInputElement>(`.care-plan-modal [id$="_${field}"]`)].map((el) => el.value);
    expect(values('medicationName')).toEqual(['Metformin']);
    expect(values('dosage')).toEqual(['500 mg']);
    const route = safetyEvents().flatMap((e) => e.findings ?? []).find((f) => f.field.endsWith('route'));
    expect(route).toMatchObject({ action: 'corrected', corrected: 'Oral' }); // from "by mouth"
    expect(owned('medication', harry().id)).toBe(before.medication); // saved only on the provider's yes
  }, TIMEOUT);

  it('"go to patients and select patient": the patient the model picked is not selected — "Which patient would you like to select?" — then the one named is', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/patients');
    model.then({ calls: [call('select_patient', { patient: 'Harry White' })] });
    await say('go to patients and select patient');
    expect(store.getState().voice.response).toBe('Which patient would you like to select?');
    expect(store.getState().patients.currentPatientId).toBeNull();

    model.then({ calls: [call('select_patient', { patient: 'Harry White' })] }, { content: 'Harry White is selected.' });
    await say('Harry White');
    await waitUntil(() => store.getState().patients.currentPatientId === harry().id);
    expect(store.getState().patients.currentPatientId).toBe(harry().id);
  }, TIMEOUT);

  it('a value said with nothing else: kept; the made-up dose is removed and the app asks for it', async () => {
    store.dispatch(setCurrentPatient(harry().id));
    await renderAppAt('/summary/medication');
    model.then({ calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '850 mg', frequency: 'Twice daily' }] })] }, { content: 'What dose?' });
    await say('add metformin twice daily');
    await waitUntil(() => store.getState().voice.pendingSlot?.field === 'dosage');
    expect(store.getState().voice.pendingSlot?.field).toBe('dosage'); // asked, not "850 mg"
    expect(safetyEvents().some((e) => e.findings?.some((f) => f.value === '850 mg' && f.action === 'removed'))).toBe(true);
  }, TIMEOUT);
});

/** A model scripted per agent (the multi-agent mode with the Planning Agent). */
class RoutedChat implements ChatLLM {
  readonly name = 'routed';
  private scripts = new Map<string, Array<{ content?: string; calls?: ToolCall[] }>>();
  script(agent: string, ...turns: Array<{ content?: string; calls?: ToolCall[] }>) {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), ...turns]);
    return this;
  }
  async chat(messages: ChatMessage[]): Promise<ChatTurn> {
    const system = String(messages[0]?.content ?? '');
    const who = /^You are the master agent/.test(system) ? 'master' : /^You are the Planning Agent/.test(system) ? 'planning' : (system.match(/You are the (Patients|Summary|My Appointment|Appointments|Medication|Diagnoses|Tasks|Recalls|Notes|Dashboard|Inbox) Agent/)?.[1] ?? '?');
    const next = this.scripts.get(who)?.shift();
    return { content: next?.content ?? `${who} done.`, toolCalls: next?.calls ?? [] };
  }
}

describe('multi-agent mode: the Planning Agent gathers what is missing before anything runs', () => {
  it('"goto patients and select patient": the Planning Agent asks which patient; the Patients Agent selects the one named', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/dashboard');
    const llm = new RoutedChat()
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'patients', instruction: 'Go to patients and select patient', execution: 'CONTEXT' }] })] })
      .script('planning', { calls: [call('submit_requirements', { tasks: [{ task: 't1', action: 'select_patient' }] })] });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true, planning: true, parallelReads: true });

    await say('goto patients and select patient');
    expect(store.getState().voice.response).toBe('Which patient would you like to select?');
    expect(store.getState().patients.currentPatientId).toBeNull();
    expect(store.getState().monitor.agents.planning.status).toBe('waiting');

    llm
      .script('planning', { calls: [call('submit_requirements', { tasks: [{ task: 't1', action: 'select_patient', patient: 'Harry White' }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Harry White' })] }, { content: 'Harry White is selected.' });
    await say('Harry White');
    await waitUntil(() => store.getState().patients.currentPatientId === harry().id);
    expect(store.getState().voice.taskGraph?.tasks[0]).toMatchObject({ status: 'COMPLETED', requirements: ['patient: Harry White'] });
    expect(store.getState().monitor.events.map((e) => e.type)).toEqual(expect.arrayContaining(['planning.started', 'planning.question', 'planning.ready']));
  }, TIMEOUT);

  /** The master opening a specialist's page itself, as qwen3.5:9b did — refused: nothing moves before the request is complete. */
  const refusedOpen = () => store.getState().monitor.toolCalls.filter((c) => c.tool === 'open_page').at(-1);

  it('Issue 1 — on Configuration, "add medication and add diagnoses": stays on Configuration; everything missing (the route too) is asked first', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/configuration');
    const llm = new RoutedChat()
      .script('master', { calls: [call('open_page', { page: 'summary' })] }, { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'summary', instruction: 'Add medication and add diagnoses', execution: 'WRITE' }] })] })
      .script('planning', { calls: [call('submit_requirements', { tasks: [{ task: 't1', action: 'add_records', records: [{ kind: 'medication', values: { medicationName: 'Medication', dosage: '500 mg' } }, { kind: 'diagnosis', values: { description: 'Diagnoses' } }] }] })] });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true, planning: true, parallelReads: true });

    await say('add medication and add diagnoses');
    expect(store.getState().voice.response).toBe('Which patient should these records be added to? What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
    expect(router.state.location.pathname).toBe('/configuration');
    expect(refusedOpen()).toMatchObject({ status: 'failed' });
    expect(pageText()).not.toContain('Care plan (');
  }, TIMEOUT);

  it('Issues 3 and 4 — on Configuration, "go to pateint and select pateint" with a patient already selected: no page change, no "already selected" — "Which patient would you like to select?"', async () => {
    store.dispatch(setCurrentPatient(harry().id));
    await renderAppAt('/configuration');
    const llm = new RoutedChat()
      // The master opens Patients itself, then answers from CONTEXT — what happened in testing.
      .script('master', { calls: [call('open_page', { page: 'patients' })] }, { content: 'Harry White is already selected.' })
      // The planning model takes the patient on screen for the one asked for.
      .script('planning', { calls: [call('submit_requirements', { tasks: [{ task: 't1', action: 'select_patient', patient: 'Harry White' }] })] });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true, planning: true, parallelReads: true });

    await say('go to pateint and select pateint');
    expect(store.getState().voice.response).toBe('Which patient would you like to select?');
    expect(router.state.location.pathname).toBe('/configuration');
    expect(refusedOpen()).toMatchObject({ status: 'failed' });
    expect(store.getState().voice.taskGraph?.tasks[0]).toMatchObject({ agent: 'patients', status: 'PENDING' });
  }, TIMEOUT);
});

/** The add-medication question that must never be asked of a delete. */
const ADD_MED_QUESTION = /which medication|at what dose|how often/i;
const tom = () => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;

describe('"Delete all medications for Tom Baker" — the operation decides what is asked, in the real application', () => {
  it('single-agent mode: the add the model tried is refused back to it; delete ALL is confirmed first, then every medication goes', async () => {
    const model = useScriptedModel();
    store.dispatch(setCurrentPatient(harry().id));
    await renderAppAt('/dashboard');
    const before = owned('medication', tom().id);
    expect(before).toBeGreaterThan(0);
    model.then(
      { calls: [call('add_medications', { medications: [{ medicationName: 'Medication' }] })] }, // the model's mistake
      { calls: [call('delete_record', { kind: 'medication', all: true, patient: 'Tom Baker' })] },
    );
    await say('Delete all medications for Tom Baker');

    const reply = store.getState().voice.response ?? '';
    expect(reply).toMatch(new RegExp(`^This will delete all ${before} medications? for Tom Baker \\(.+\\)\\. This cannot be undone\\. Do you want to continue\\?$`));
    expect(reply).not.toMatch(ADD_MED_QUESTION);
    expect(store.getState().patients.currentPatientId).toBe(tom().id); // Tom Baker's — never Harry White's
    expect(store.getState().voice.pendingConfirmation).toMatchObject({ kind: 'delete', recordKind: 'medication' });
    expect(store.getState().voice.pendingConfirmation?.recordIds).toHaveLength(before);
    expect(owned('medication', tom().id)).toBe(before); // nothing deleted before the yes
    expect(safetyEvents().flatMap((e) => e.findings ?? [])).toContainEqual(expect.objectContaining({ field: 'operation', value: 'add_medications' }));

    model.calls([call('confirm_pending_action')], 'Deleted.');
    await say('yes');
    await waitUntil(() => owned('medication', tom().id) === 0);
    expect(owned('medication', harry().id)).toBeGreaterThan(0);
  }, TIMEOUT);

  it('multi-agent mode with the Planning Agent: "Delete all diagnoses for Tom Baker" filed as add_records is corrected to DELETE ALL — no question, only the confirmation', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/configuration');
    const before = owned('diagnosis', tom().id);
    expect(before).toBeGreaterThan(0);
    const llm = new RoutedChat()
      .script('master', {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'patients', instruction: 'Select Tom Baker', execution: 'CONTEXT' },
              { id: 't2', agent: 'summary', instruction: 'Delete all diagnoses for Tom Baker', execution: 'WRITE', depends_on: ['t1'] },
            ],
          }),
        ],
      })
      // The bug as it happened: the planning model filed the delete as an add of a medication.
      .script('planning', { calls: [call('submit_requirements', { tasks: [{ task: 't1', action: 'select_patient', patient: 'Tom Baker' }, { task: 't2', action: 'add_records', records: [{ kind: 'diagnosis' }] }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Tom Baker' })] }, { content: 'Tom Baker is selected.' })
      .script('Diagnoses', { calls: [call('delete_record', { kind: 'diagnosis', all: true })] });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true, planning: true, parallelReads: true });

    const from = store.getState().monitor.events.length;
    await say('Delete all diagnoses for Tom Baker');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'delete');
    const reply = store.getState().voice.response ?? '';
    expect(reply).toMatch(new RegExp(`This will delete all ${before} diagnos(is|es) for Tom Baker .*Do you want to continue\\?`));
    expect(reply).not.toMatch(/which diagnosis|which medication|at what dose/i);
    const events = store.getState().monitor.events.slice(from).map((e) => e.type);
    expect(events).toContain('planning.ready');
    expect(events).not.toContain('planning.question');
    expect(store.getState().voice.taskGraph?.tasks[1]).toMatchObject({ status: 'WAITING_FOR_USER', requirements: expect.arrayContaining([expect.stringMatching(/^operation: delete ALL/), expect.stringMatching(/^confirmation: required/)]) });
    expect(owned('diagnosis', tom().id)).toBe(before);

    llm.script('Diagnoses', { calls: [call('confirm_pending_action')] }, { content: 'All of Tom Baker’s diagnoses were deleted.' });
    await say('yes');
    await waitUntil(() => owned('diagnosis', tom().id) === 0);
  }, TIMEOUT);
});

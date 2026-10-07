/**
 * The assistant → real UI → stored data.
 *
 * A scripted model stands in for Qwen and makes the tool calls; everything
 * after that is the real application: the tools open the real Ant Design
 * dialogs, fill the real fields, and only a confirmation from the user (in a
 * later turn, or the button) writes to the store. The safety rules are proven
 * end to end — no patient, no write; no confirmation, no save or delete; and
 * the model cannot confirm on the user's behalf.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import dayjs from 'dayjs';
import { appointmentsSlice, diagnosesSlice, recordSlices } from '@/store/slices/recordSlices';
import { RECORD_KINDS } from '@/types/records';
import { appointmentService, diagnosisService, medicationService } from '@/services/api';
import { voiceActions } from '@/store/slices/voiceSlice';
import { RecordRegistry } from '@/registry/recordRegistry';
import { FormRegistry } from '@/registry/formRegistry';
import { getVoiceController } from '@/services/ai/voiceController';
import { router } from '@/app/router';
import { call, type ScriptedLLM } from '@/services/ai/__tests__/fakes';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, useScriptedModel, waitUntil } from './harness';

const TIMEOUT = 30000;
let model: ScriptedLLM;

beforeAll(installBrowserStubs);

const patientDiagnoses = () => {
  const patientId = store.getState().patients.currentPatientId;
  return diagnosesSlice.selectors.selectAll(store.getState()).filter((d) => d.patientId === patientId);
};
/** Wait for something only a service call can tell (saved records). */
async function pollUntil(check: () => Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  expect(await check(), 'timed out waiting').toBe(true);
}
const inputValue = (id: string) => (document.querySelector(`#${id}`) as HTMLInputElement | null)?.value;

beforeEach(async () => {
  store.dispatch(voiceActions.resetVoice());
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchProviders()).unwrap();
  await store.dispatch(diagnosesSlice.fetchAll()).unwrap();
  store.dispatch(setCurrentPatient(patientSelectors.selectAll(store.getState())[0].id));
  model = useScriptedModel();
});

afterEach(unmountApp);

describe('the assistant against the real application', () => {
  it('opens the real diagnosis form from a tool call, and saves only on the user’s later "yes"', async () => {
    await renderAppAt('/summary/diagnosis');
    await waitUntil(() => !!RecordRegistry.get('diagnosis'));
    const before = patientDiagnoses().length;

    // The model asks for the form AND tries to confirm in the same turn: the confirm is refused.
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension', status: 'Active' }] })] });
    await say('add hypertension as a diagnosis');
    expect(pageText()).toContain('Add Diagnosis');
    expect(inputValue('description')).toBe('Hypertension');
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');
    expect(store.getState().voice.response).toMatch(/confirm/i);
    expect(patientDiagnoses()).toHaveLength(before);

    model.calls([call('confirm_pending_action')], 'Saved.');
    await say('yes save it');
    await waitUntil(() => patientDiagnoses().length === before + 1);
    expect(patientDiagnoses().some((d) => d.description === 'Hypertension')).toBe(true);
    expect(store.getState().voice.pendingConfirmation).toBeNull();
  }, TIMEOUT);

  it('a model that tries to save in the same turn it filled the form never gets to — the turn waits for the user', async () => {
    await renderAppAt('/summary/diagnosis');
    await waitUntil(() => !!RecordRegistry.get('diagnosis'));
    const before = patientDiagnoses().length;
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Asthma' }] }), call('confirm_pending_action')] });
    await say('add asthma');
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');
    expect(model.requests).toHaveLength(2); // its own confirm was refused; the model was asked once more, and nothing saved
    expect(patientDiagnoses()).toHaveLength(before);
  }, TIMEOUT);

  it('stages a deletion, shows it, and removes the record only after confirmation', async () => {
    await renderAppAt('/summary/diagnosis');
    await waitUntil(() => !!RecordRegistry.get('diagnosis'));
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Dictated Condition' }] })] });
    await say('add dictated condition');
    model.calls([call('confirm_pending_action')], 'Saved.');
    await say('yes');
    await waitUntil(() => patientDiagnoses().some((d) => d.description === 'Dictated Condition'));
    const before = patientDiagnoses().length;

    model.then({ calls: [call('delete_record', { kind: 'diagnosis', record: 'dictated condition' })] });
    await say('delete the dictated condition');
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('delete');
    expect(pageText()).toContain('will be permanently deleted');
    expect(patientDiagnoses()).toHaveLength(before);

    model.calls([call('cancel_pending_action')], 'Kept it.');
    await say('no keep it');
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    expect(patientDiagnoses()).toHaveLength(before);

    model.then({ calls: [call('delete_record', { kind: 'diagnosis', record: 'Dictated Condition' })] });
    await say('delete it');
    model.calls([call('confirm_pending_action')], 'Deleted.');
    await say('yes delete it');
    await waitUntil(() => patientDiagnoses().length === before - 1);
    expect(patientDiagnoses().some((d) => d.description === 'Dictated Condition')).toBe(false);
  }, TIMEOUT);

  it('arguments that break the schema never reach the app — the error goes back and the model corrects itself', async () => {
    await renderAppAt('/summary/medication');
    await waitUntil(() => !!RecordRegistry.get('medication'));
    const med = { medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency: 'Twice daily' };
    model.then({ calls: [call('add_medications', { medications: [{ ...med, startDate: 'tomorrow' }] })] }, { calls: [call('add_medications', { medications: [{ ...med, startDate: '2026-09-25' }] })] });
    await say('metformin 500 mg by mouth twice daily starting tomorrow');
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1].filter((m) => m.role === 'tool')[0].content).toMatch(/startDate: use YYYY-MM-DD/);
    expect(inputValue('medicationName')).toBe('Metformin');
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');
  }, TIMEOUT);

  it('creates, edits and deletes a patient with the real patient form — each write waits for a yes', async () => {
    await renderAppAt('/patients');
    await waitUntil(() => !!RecordRegistry.get('patient'));
    const findOlivia = () => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Olivia Testcase');

    model.then({ calls: [call('create_patient', { firstName: 'Olivia', lastName: 'Testcase', dateOfBirth: '1990-01-10', gender: 'Female', phone: '0300 1234567' })] });
    await say('new patient Olivia Testcase, born 10 January 1990, female, phone 0300 1234567');
    expect(pageText()).toContain('Add Patient');
    expect(inputValue('firstName')).toBe('Olivia');
    expect(findOlivia()).toBeUndefined();
    model.calls([call('confirm_pending_action')], 'Saved.');
    await say('save');
    await waitUntil(() => !!findOlivia());
    expect(findOlivia()).toMatchObject({ dateOfBirth: '1990-01-10', gender: 'Female', phone: '0300 1234567' });

    model.then({ calls: [call('edit_patient', { patient: 'Olivia Testcase', changes: { phone: '0311 7654321' } })] });
    await say("change Olivia Testcase's phone to 0311 7654321");
    expect(pageText()).toContain('Edit Patient');
    expect(findOlivia()!.phone).toBe('0300 1234567');
    model.calls([call('confirm_pending_action')], 'Saved.');
    await say('yes');
    await waitUntil(() => findOlivia()?.phone === '0311 7654321');

    model.then({ calls: [call('delete_patient', { patient: 'Olivia Testcase' })] });
    await say('delete Olivia Testcase');
    expect(store.getState().voice.pendingConfirmation?.recordKind).toBe('patient');
    model.calls([call('confirm_pending_action')], 'Deleted.');
    await say('yes delete');
    await waitUntil(() => !findOlivia());
  }, TIMEOUT);

  it('no patient selected, away from Summary: nothing opens — the patient and everything missing are asked for at once', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/dashboard');
    model.calls([call('add_medications', { medications: [{ medicationName: 'Aspirin' }] })], 'Please select a patient first.');
    await say('add aspirin');
    expect(store.getState().voice.response).toBe('Which patient should this medication be added to? I have the medication as Aspirin. Please provide the missing information: dose and frequency.');
    expect(router.state.location.pathname).toBe('/dashboard');
    expect(pageText()).not.toContain('Add Medication');
    // Told to the app directly (not the provider's words): the app itself refuses — no patient is selected.
    const direct = await getVoiceController().runAction((r) => r.createRecords('medication', [{ medicationName: 'Aspirin' }]));
    expect(direct).toMatchObject({ ok: false });
    expect(direct.message).toMatch(/no patient is selected/i);
  }, TIMEOUT);

  it('selecting a patient opens their Summary', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/dashboard');
    const target = patientSelectors.selectAll(store.getState())[5];
    model.calls([call('select_patient', { patient: target.mrn, open_tab: 'summary-medication' })], `Opened ${target.fullName}.`);
    await say(`open ${target.fullName}'s medications`);
    await waitUntil(() => router.state.location.pathname === '/summary/medication');
    expect(store.getState().patients.currentPatientId).toBe(target.id);
  }, TIMEOUT);

  it('answers about the signed-in provider’s own day from their real schedule', async () => {
    await store.dispatch(appointmentsSlice.fetchAll()).unwrap();
    await renderAppAt('/dashboard');
    model.calls([call('get_provider_overview')], 'You have a full day.');
    await say('what does my day look like');
    const result = model.lastToolResults()[0];
    const providerId = store.getState().auth.user!.providerId;
    const mine = appointmentsSlice.selectors.selectAll(store.getState()).filter((a) => a.providerId === providerId);
    expect(result.ok).toBe(true);
    const data = result.data as { provider: string; today: Array<{ id: string }> };
    expect(data.provider).toBe(store.getState().auth.user!.fullName);
    expect(data.today.every((a) => mine.some((m) => m.id === a.id))).toBe(true);
  }, TIMEOUT);

  it('a dictated note lands in the AI Summary and its extracted items are listed for review', async () => {
    await renderAppAt('/summary');
    const note = 'Start amlodipine 5 mg once daily and add hypertension.';
    model
      .calls([call('take_clinical_note', { note })], 'Extracting your note.')
      .then({ calls: [call('record_note_findings', { medications: [{ medicationName: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily', quote: 'Start amlodipine 5 mg once daily' }], diagnoses: [{ description: 'Hypertension' }] })] });
    await say(note);
    await waitUntil(() => router.state.location.pathname === '/summary/ai-summary');
    await waitUntil(() => pageText().includes('Amlodipine'));
    expect(pageText()).toContain('Amlodipine');
    expect(pageText()).toContain('Hypertension');
  }, TIMEOUT);

  it('"give me my dashboard summary" opens the summary beside the Dashboard; the reply stays one line', async () => {
    await store.dispatch(appointmentsSlice.fetchAll()).unwrap();
    await renderAppAt('/patients');
    model.calls([call('dashboard_summary_panel', { open: true })], 'Your summary is on the right.');
    await say('give me my dashboard summary');
    await waitUntil(() => !!document.querySelector('aside[aria-label="Dashboard summary"]'));
    expect(router.state.location.pathname).toBe('/dashboard');
    const panel = document.querySelector('aside[aria-label="Dashboard summary"]')!;
    expect(panel.textContent).toContain("Today's schedule");
    expect(panel.textContent).toContain('Your day');
    expect(model.lastToolResults()[0].message).toBe('Your dashboard summary is open on the right.');
    expect(store.getState().voice.response).toBe('Your summary is on the right.');
    expect(document.querySelector('.app-shell')!.className).toContain('has-right-dock');
  }, TIMEOUT);

  it('"go to patients and select harry white and create a task for blood pressure monitoring" — one step after another', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/dashboard');
    model.then(
      { calls: [call('open_page', { page: 'patients' })] },
      { calls: [call('select_patient', { patient: 'Harry White' })] },
      { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] },
    );
    await say('go to patients and select harry white and create a task for blood pressure monitoring');
    await waitUntil(() => pageText().includes('Add Task'));
    const selected = patientSelectors.selectById(store.getState(), store.getState().patients.currentPatientId ?? '');
    expect(selected?.fullName).toBe('Harry White');
    expect(router.state.location.pathname).toBe('/summary/task');
    expect(inputValue('title')).toBe('Blood pressure monitoring');
    // Nothing is saved until the provider confirms.
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');
    expect(model.requests).toHaveLength(4);
  }, TIMEOUT);

  it('one request with medications, a diagnosis, a task, a recall and an appointment fills one care plan, saved together on "yes"', async () => {
    store.dispatch(setCurrentPatient(null));
    for (const kind of RECORD_KINDS) await store.dispatch((recordSlices[kind] as (typeof recordSlices)['medication']).fetchAll()).unwrap();
    await renderAppAt('/patients');
    const med = { dosage: '500 mg', frequency: 'Twice daily', duration: '30 days' };
    const tuesday = dayjs().day() < 2 ? dayjs().day(2) : dayjs().add(1, 'week').day(2);
    const plan = (recallReason: string) =>
      call('add_care_plan', {
        patient: 'Harry White',
        medications: ['Metformin', 'Panadol', 'Gabapentin', 'Rituximab'].map((medicationName) => ({ medicationName, ...med })),
        diagnoses: [{ description: 'Hypertension' }],
        tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }],
        recalls: [{ reason: recallReason, dueDate: dayjs().add(2, 'week').format('YYYY-MM-DD') }],
        appointments: [{ date: tuesday.format('YYYY-MM-DD'), startTime: '15:00', type: 'Follow-up', reason: 'Follow-up' }],
      });
    model.then({ calls: [plan('Follow-up review')] });
    await say('goto patients select Harry White and add medication metformin, panadol, gabapentin, rituximab 500 mg by mouth twice daily for 30 days, add hypertension as a diagnosis, create a task for blood pressure monitoring, recall the patient after two weeks, and schedule a follow-up appointment next Tuesday at 3 pm');

    // The recall's reason was never said ("recall the patient after two weeks"): the Safety Agent removed the
    // model's "Follow-up review" — and away from Summary nothing opens until the provider has said it.
    expect(store.getState().voice.response).toBe('What is the reason for the recall?');
    expect(router.state.location.pathname).toBe('/patients');
    expect(pageText()).not.toContain('Care plan (');
    const asked = store.getState().monitor.events.filter((e) => e.type === 'safety.blocked').flatMap((e) => e.findings ?? []);
    expect(asked.map((f) => [f.field, f.value, f.action])).toContainEqual(['recall 1 · reason', 'Follow-up review', 'asked']);

    // The provider says it: the whole care plan opens, complete, and waits for their yes.
    model.then({ calls: [plan('Blood pressure review')] }, { content: 'Please review and confirm the care plan.' });
    await say('blood pressure review');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'care_plan');
    const patient = patientSelectors.selectById(store.getState(), store.getState().patients.currentPatientId ?? '')!;
    expect(patient.fullName).toBe('Harry White');
    expect(router.state.location.pathname.startsWith('/summary')).toBe(true);
    const values = (field: string) => [...document.querySelectorAll<HTMLInputElement>(`.care-plan-modal [id$="_${field}"]`)].map((el) => el.value);
    expect(values('medicationName')).toEqual(['Metformin', 'Panadol', 'Gabapentin', 'Rituximab']);
    expect(values('dosage')).toEqual(['500 mg', '500 mg', '500 mg', '500 mg']);
    expect(values('duration')).toEqual(['30 days', '30 days', '30 days', '30 days']);
    expect(values('description')).toContain('Hypertension');
    expect(values('title')).toEqual(['Blood pressure monitoring']);
    expect(values('reason')).toEqual(['Blood pressure review', 'Follow-up']);
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Medication4', 'Diagnosis1', 'Task1', 'Recall1', 'Appointment1']);

    const owned = (kind: (typeof RECORD_KINDS)[number]) => (recordSlices[kind].selectors.selectAll(store.getState()) as Array<{ patientId: string }>).filter((r) => r.patientId === patient.id).length;
    const before = Object.fromEntries(RECORD_KINDS.map((k) => [k, owned(k)]));
    model.calls([call('confirm_pending_action')], 'Saved.');
    await say('yes save it');
    await waitUntil(() => owned('appointment') === before.appointment + 1);
    expect(owned('medication')).toBe(before.medication + 4);
    expect(owned('diagnosis')).toBe(before.diagnosis + 1);
    expect(owned('task')).toBe(before.task + 1);
    expect(owned('recall')).toBe(before.recall + 1);
    const appt = (appointmentsSlice.selectors.selectAll(store.getState()) as Array<{ patientId: string; date: string; startTime: string }>).filter((a) => a.patientId === patient.id);
    expect(appt.some((a) => a.date === tuesday.format('YYYY-MM-DD') && a.startTime === '15:00')).toBe(true);
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    expect(pageText()).not.toContain('Care plan (');
  }, TIMEOUT);

  it('medications first, then a task and an appointment in the same request: nothing is lost — they meet in one care plan', async () => {
    await renderAppAt('/summary/medication');
    const tuesday = dayjs().day() < 2 ? dayjs().day(2) : dayjs().add(1, 'week').day(2);
    model.then(
      // The model adds the medications on their own first; Panadol has no dose, so the form asks for it…
      { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }, { medicationName: 'Panadol' }] })] },
      // …it must not answer that question itself…
      { calls: [call('fill_open_form', { dosage: '1000 mg' })] },
      // …and the rest of what was said still gets done.
      { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] },
      { calls: [call('add_appointments', { appointments: [{ date: tuesday.format('YYYY-MM-DD'), startTime: '16:45', type: 'Follow-up', reason: 'Follow-up' }] })] },
      { content: 'Care plan ready.' },
    );
    await say('add metformin 500 mg twice daily and panadol, create a task for blood pressure monitoring and a follow-up next Tuesday at 4:45 pm');
    await waitUntil(() => pageText().includes('Care plan (4)'));
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Medication2', 'Task1', 'Appointment1']);
    const values = (field: string) => [...document.querySelectorAll<HTMLInputElement>(`.care-plan-modal [id$="_${field}"]`)].map((el) => el.value);
    expect(values('medicationName')).toEqual(['Metformin', 'Panadol']);
    expect(values('dosage')).not.toContain('1000 mg'); // nobody said a dose for Panadol
    expect(values('title')).toEqual(['Blood pressure monitoring']);
  }, TIMEOUT);

  it('a long request is split into steps, done one by one — they meet in one care plan, and the steps show as progress', async () => {
    model = useScriptedModel({ planSteps: true });
    await renderAppAt('/summary/medication');
    const tuesday = dayjs().day() < 2 ? dayjs().day(2) : dayjs().add(1, 'week').day(2);
    model.then(
      { calls: [call('plan_steps', { steps: ['Add metformin 500 mg twice daily and Panadol', 'Create a task for blood pressure monitoring', 'Book a follow-up next Tuesday at 5:15 pm'] })] },
      { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }, { medicationName: 'Panadol' }] })] },
      { content: 'Medications added.' },
      { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] },
      { content: 'Task added.' },
      { calls: [call('add_appointments', { appointments: [{ date: tuesday.format('YYYY-MM-DD'), startTime: '17:15', type: 'Follow-up', reason: 'Follow-up' }] })] },
      { content: 'Appointment added.' },
    );
    await say('add metformin 500 mg twice daily and panadol, create a task for blood pressure monitoring and a follow-up next Tuesday at 5:15 pm');
    await waitUntil(() => pageText().includes('Care plan (4)'));
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Medication2', 'Task1', 'Appointment1']);
    // Each step was its own request, told which step it is.
    const stepSaid = model.requests.map((m) => String(m.at(-1)?.content ?? '')).filter((c) => c.includes('request: step')).map((c) => c.match(/SAID: (.*)/)?.[1]);
    expect(stepSaid).toEqual(['Add metformin 500 mg twice daily and Panadol', 'Create a task for blood pressure monitoring', 'Book a follow-up next Tuesday at 5:15 pm']);
    // Progress only — every step finished, nothing for the provider to tick.
    const plan = store.getState().voice.plan!;
    expect(plan.map((s) => s.status).every((s) => s === 'done' || s === 'waiting')).toBe(true);
    expect(document.querySelectorAll('.va-plan li')).toHaveLength(3);
    expect(document.querySelector('.va-plan input')).toBeNull();
    // Nothing was saved: that still waits for the provider.
    expect(store.getState().voice.pendingSlot ?? store.getState().voice.pendingConfirmation).not.toBeNull();
  }, TIMEOUT);

  it('"create four appointments … Liam Martin, Harry White, Lucas Martin, Lily Martin" at the SAME time with one provider: never booked — no double booking', async () => {
    store.dispatch(setCurrentPatient(null)); // said from anywhere, with nobody selected
    await renderAppAt('/dashboard');
    const today = dayjs().format('YYYY-MM-DD');
    const names = ['Liam Martin', 'Harry White', 'Lucas Martin', 'Lily Martin'];
    const reason = 'Blood Pressure monitoring';
    const bookedToday = async () => (await appointmentService.byDate(today)).filter((a) => a.reason === reason && a.startTime === '18:00');
    const before = (await bookedToday()).length;

    model.then({
      calls: [call('add_appointments', { appointments: names.map((patient) => ({ patient, providerName: 'Dr Lucy White', date: today, startTime: '18:00', reason })) })],
    });
    await say('crate four appointments against Dr Lucy White appointment is for Blood Pressure monitoring add appoint ment for today after 6 pm Liam Martin, Harry White, Lucas Martin, Lily Martin');
    await waitUntil(() => pageText().includes('Add Appointment (4)'));
    // One numbered tab per patient, each holding its patient…
    const tabs = [...document.querySelectorAll('.entry-patient-tabs .ant-tabs-tab')].map((t) => t.textContent?.trim() ?? '');
    expect(tabs).toEqual(['Tab 1', 'Tab 2', 'Tab 3', 'Tab 4']);
    expect(FormRegistry.get('appointment')!.entries!.getAll().map((v) => String(v.patient).replace(/\s*\(.*\)$/, ''))).toEqual(names);
    // …but one provider cannot see four patients at 18:00: nothing is offered for saving, and the model is told why.
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    expect(model.lastToolResults()[0].message).toMatch(/^Not bookable: .*Dr\. Lucy White is already booked/);

    // A "yes" now saves nothing; and the Save button refuses too.
    model.calls([call('confirm_pending_action')], 'Nothing to confirm.');
    await say('yes');
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Book Appointment')!.click();
    await new Promise((r) => setTimeout(r, 500));
    expect((await bookedToday()).length).toBe(before);
  }, TIMEOUT);

  describe('several patients in one request — no patient selected first', () => {
    const FOUR = ['Liam Martin', 'Harry White', 'Lucas Martin', 'Lily Martin'];
    /** The numbered main tabs (Tab 1, Tab 2…), one patient each. */
    const patientTabs = () => [...document.querySelectorAll('.entry-patient-tabs .ant-tabs-tab')].map((t) => t.textContent?.trim() ?? '');
    const tabsFor = (n: number) => Array.from({ length: n }, (_, i) => `Tab ${i + 1}`);
    /** The record tabs inside the main tab that is open (none when it holds a single record). */
    const recordTabs = () => [...document.querySelectorAll('.entry-record-tabs .ant-tabs-tab')].map((t) => t.textContent?.trim() ?? '');
    const openTab = async (n: number) => {
      const tab = [...document.querySelectorAll('.entry-patient-tabs .ant-tabs-tab')].find((t) => t.textContent?.trim() === `Tab ${n}`)!;
      (tab.querySelector('.ant-tabs-tab-btn') as HTMLElement).click();
      await waitUntil(() => document.querySelector('.entry-patient-tabs .ant-tabs-tab-active')?.textContent?.trim() === `Tab ${n}`);
    };
    /** The patient of the tab on screen, and the chart shown for them. */
    const tabPatient = (kind: string) => String(FormRegistry.get(kind)!.getValues().patient ?? '').replace(/\s*\(.*\)$/, '');
    const glance = () => document.querySelector('.patient-glance')?.textContent ?? '';
    /** Every entry of the open form, as the store behind the tabs holds it. */
    const entriesOf = (kind: string) => FormRegistry.get(kind)!.entries!.getAll();
    const whose = (v: Record<string, unknown>) => String(v.patient ?? '').replace(/\s*\(.*\)$/, '');

    beforeEach(() => {
      store.dispatch(setCurrentPatient(null));
    });

    it('Example 1: the same three medications for each of four patients — the dose said after the list is each drug\'s, even when the model gives it to one; nothing is asked', async () => {
      await renderAppAt('/dashboard');
      const each = { dosage: '500 mg', frequency: 'Twice daily', duration: '50 days' };
      // The model leaves the list's dose off Panadol and Paracetamol: the Safety Agent gives it to them, from
      // where the provider put it (after the list) — the model is not asked again, nor the provider.
      model.then({ calls: [call('add_medications', { for_patients: FOUR, medications: [{ medicationName: 'Panadol' }, { medicationName: 'Paracetamol' }, { medicationName: 'Gabapentin', ...each }] })] });
      await say('Add the following medications to each of the four patients Liam Martin, Harry White, Lucas Martin and Lily Martin: Panadol, Paracetamol, Gabapentin 500 mg twice daily for 50 days');
      await waitUntil(() => pageText().includes('Add Medication (12)'));
      expect(model.lastToolResults()[0].ok).toBe(true);
      expect(store.getState().voice.response ?? '').not.toMatch(/at what dose|how often|which medication/i); // the provider was asked nothing
      expect(patientTabs()).toEqual(tabsFor(4));
      for (let n = 1; n <= 4; n++) {
        await openTab(n);
        expect(tabPatient('medication')).toBe(FOUR[n - 1]);
        expect(recordTabs()).toEqual(['Panadol', 'Paracetamol', 'Gabapentin']);
        expect(glance()).toContain(`${FOUR[n - 1]}'s records`); // that patient's chart, nobody else's
      }
      const all = entriesOf('medication');
      for (const name of FOUR) {
        const mine = all.filter((v) => whose(v) === name);
        expect(mine.map((v) => v.medicationName)).toEqual(['Panadol', 'Paracetamol', 'Gabapentin']);
        for (const drug of mine) expect(drug).toMatchObject({ dosage: '500 mg', frequency: 'Twice daily', duration: '50 days' });
      }
      expect(pageText()).toContain('12 medications will be saved for 4 patients');
      // Complete — and still not saved: it waits for the provider's yes.
      expect(store.getState().voice.pendingSlot).toBeNull();
      expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');
    }, TIMEOUT);

    it('Example 2: a different time for each patient — each appointment stays with its patient, and is saved for them after "yes"', async () => {
      await renderAppAt('/dashboard');
      const today = dayjs().format('YYYY-MM-DD');
      const times = ['18:00', '19:00', '20:00', '21:00'];
      const reason = 'Blood pressure monitoring (per patient)';
      model.then({
        calls: [call('add_appointments', { appointments: FOUR.map((patient, i) => ({ patient, providerName: 'Dr. Lucy White', date: today, startTime: times[i], reason })) })],
      });
      await say('Create four appointments with Dr. Lucy White for today for blood pressure monitoring: Liam Martin 6 pm, Harry White 7 pm, Lucas Martin 8 pm, Lily Martin 9 pm');
      await waitUntil(() => pageText().includes('Add Appointment (4)'));
      expect(patientTabs()).toEqual(tabsFor(4));
      await openTab(3);
      expect(tabPatient('appointment')).toBe('Lucas Martin');
      expect(recordTabs()).toEqual([]); // one appointment in this tab
      expect(FormRegistry.get('appointment')!.getValues()).toMatchObject({ startTime: expect.anything() });
      const all = entriesOf('appointment');
      const hhmm = (v: unknown) => (dayjs.isDayjs(v) ? v.format('HH:mm') : String(v));
      FOUR.forEach((name, i) => expect(hhmm(all.find((v) => whose(v) === name)?.startTime)).toBe(times[i]));
      expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');

      model.calls([call('confirm_pending_action')], 'Booked.');
      await say('yes');
      await pollUntil(async () => (await appointmentService.byDate(today)).filter((a) => a.reason === reason).length === 4);
      const saved = (await appointmentService.byDate(today)).filter((a) => a.reason === reason);
      FOUR.forEach((name, i) => expect(saved.find((a) => a.patientName === name)?.startTime).toBe(times[i]));
    }, TIMEOUT);

    it('Example 4: three diagnoses for each of four patients', async () => {
      await renderAppAt('/dashboard');
      model.then({ calls: [call('add_diagnoses', { for_patients: FOUR, diagnoses: [{ description: 'Hypertension' }, { description: 'Type 2 Diabetes' }, { description: 'Migraine' }] })] });
      await say('Add hypertension, type 2 diabetes and migraine to each of Liam Martin, Harry White, Lucas Martin and Lily Martin');
      await waitUntil(() => pageText().includes('Add Diagnosis (12)'));
      expect(patientTabs()).toEqual(tabsFor(4));
      await openTab(4);
      expect(tabPatient('diagnosis')).toBe('Lily Martin');
      expect(recordTabs()).toEqual(['Hypertension', 'Type 2 Diabetes', 'Migraine']);
      expect(store.getState().voice.pendingConfirmation?.kind).toBe('form'); // saved only after the provider's yes
    }, TIMEOUT);

    /** Pick patients in an antd multi-select by typing each name and clicking its option. */
    const pickPatients = async (selectClass: string, names: string[]) => {
      for (const name of names) {
        const box = document.querySelector(`.${selectClass} .ant-select-selector`) as HTMLElement;
        box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        const input = document.querySelector(`.${selectClass} input`) as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await waitUntil(() => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].some((o) => o.textContent?.startsWith(name)));
        const option = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.textContent?.startsWith(name)) as HTMLElement;
        option.click();
        await waitUntil(() => document.querySelector(`.${selectClass}`)!.textContent!.includes(name));
      }
    };
    const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;

    it('by mouse, with no patient selected: "Records for several patients" opens the form with a tab per patient', async () => {
      await renderAppAt('/patients', () => pageText().includes('Records for several patients'));
      button('Records for several patients').click();
      await waitUntil(() => !!document.querySelector('.multi-patient-select'));
      (document.querySelector('.multi-patient-launcher input[type="radio"][value="task"]') as HTMLInputElement).click();
      await pickPatients('multi-patient-select', ['Liam Martin', 'Lily Martin']);
      button('Open form').click();
      await waitUntil(() => pageText().includes('Add Task (2)'));
      await waitUntil(() => patientTabs().length === 2);
      expect(patientTabs()).toEqual(tabsFor(2));
      expect(entriesOf('task').map(whose)).toEqual(['Liam Martin', 'Lily Martin']);
      expect(store.getState().voice.pendingConfirmation).toBeNull(); // nothing to confirm until the provider fills it in
    }, TIMEOUT);

    it('by mouse: + opens an empty tab — no patient, nothing inherited — and nothing is saved until it has one', async () => {
      const harry = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Harry White')!;
      store.dispatch(setCurrentPatient(harry.id));
      await renderAppAt('/summary/medication');
      await getVoiceController().runAction((r) => r.createRecords('medication', [{ medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily' }]));
      await waitUntil(() => pageText().includes('Add Medication'));
      // Tab 1 is the selected patient's, with their chart.
      expect(patientTabs()).toEqual(tabsFor(1));
      expect(tabPatient('medication')).toBe('Harry White');
      expect(glance()).toContain("Harry White's records");

      (document.querySelector('.entry-patient-tabs .ant-tabs-nav-add') as HTMLElement).click();
      await waitUntil(() => patientTabs().length === 2);
      expect(document.querySelector('.entry-patient-tabs .ant-tabs-tab-active')?.textContent?.trim()).toBe('Tab 2');
      expect(tabPatient('medication')).toBe(''); // empty — not Harry
      expect(glance()).toContain("Choose this tab's patient");
      expect(pageText()).toContain('Choose the patient for Tab 2');

      const before = (await medicationService.byPatient(harry.id)).length;
      button('Save Medication').click();
      await new Promise((r) => setTimeout(r, 400));
      expect((await medicationService.byPatient(harry.id)).length).toBe(before); // nothing saved, not even Tab 1's
      await openTab(1);
      expect(tabPatient('medication')).toBe('Harry White');
    }, TIMEOUT);

    it('the call qwen3.5:9b actually made — add_care_plan with "name" for the drug and for_patients — opens all twelve, each with its patient', async () => {
      // From the provider's trace: the model named the drug in "name" (not medicationName) and cut one
      // patient's name short ("Lily Mart"). Nothing was added then; now the alias is understood.
      store.dispatch(setCurrentPatient(patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Harry White')!.id));
      await renderAppAt('/summary/medication');
      const med = (name: string) => ({ dosage: '500 mg', duration: '50 days', frequency: 'Twice daily', name });
      model.then({
        calls: [call('add_care_plan', { medications: [med('Panadol'), med('Paracetamol'), med('Gabapentin')], for_patients: ['Liam Martin', 'Harry White', 'Lucas Martin', 'Lily Mart'] })],
      });
      await say('Add the following medications to each of the four patients: Liam Martin, Harry White, Lucas Martin, and Lily Martin. Panadol 500 mg twice daily for 50 days, Paracetamol 500 mg twice daily for 50 days, Gabapentin 500 mg twice daily for 50 days');
      await waitUntil(() => pageText().includes('Care plan (12)'));
      const tabs = [...document.querySelectorAll('.care-plan-modal .ant-tabs-tab')].map((t) => t.textContent?.trim() ?? '');
      for (const who of FOUR) for (const drug of ['Panadol', 'Paracetamol', 'Gabapentin']) expect(tabs.some((t) => t.includes(drug) && t.includes(who))).toBe(true);
    }, TIMEOUT);

    it('Example 5: different medications for different patients are never mixed', async () => {
      await renderAppAt('/dashboard');
      model.then({
        calls: [
          call('add_medications', {
            medications: [
              { patient: 'Liam Martin', medicationName: 'Panadol', dosage: '1000 mg', frequency: 'Three times daily' },
              { patient: 'Harry White', medicationName: 'Metformin', dosage: '850 mg', frequency: 'Once daily' },
              { patient: 'Lucas Martin', medicationName: 'Gabapentin', dosage: '500 mg', frequency: 'Twice daily', duration: '30 days' },
            ],
          }),
        ],
      });
      await say('All by mouth: Panadol 1000 mg three times a day to Liam Martin, Metformin 850 mg once a day to Harry White, and Gabapentin 500 mg twice daily for 30 days to Lucas Martin');
      await waitUntil(() => pageText().includes('Add Medication (3)'));
      expect(patientTabs()).toEqual(tabsFor(3));
      const all = entriesOf('medication');
      expect(all.map((v) => [whose(v), v.medicationName])).toEqual([
        ['Liam Martin', 'Panadol'],
        ['Harry White', 'Metformin'],
        ['Lucas Martin', 'Gabapentin'],
      ]);
      expect(all[2]).toMatchObject({ dosage: '500 mg', frequency: 'Twice daily', duration: '30 days' });
    }, TIMEOUT);
  });

  it('a patient name that matches nobody for certain opens nothing — no record falls back to another patient', async () => {
    await renderAppAt('/summary/task');
    model.then({ calls: [call('add_tasks', { tasks: [{ title: 'BP check', patient: 'Harry White' }, { title: 'BP check', patient: 'Zzyzx Qwerty' }] })] });
    await say('create a task bp check for harry white and zzyzx qwerty');
    // Asked before anything is searched or opened — the patient said is nobody on file.
    expect(store.getState().voice.response).toBe('I couldn\'t find a patient named "Zzyzx Qwerty". Which patient do you mean?');
    expect(pageText()).not.toContain('Add Task');
  }, TIMEOUT);

  it('a record named for another patient is saved for that patient, not the selected one', async () => {
    await renderAppAt('/summary/diagnosis');
    await waitUntil(() => !!RecordRegistry.get('diagnosis'));
    const selected = store.getState().patients.currentPatientId;
    const other = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Lily Martin')!;
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Migraine', patient: 'Lily Martin' }] })] });
    await say('add migraine for lily martin');
    await waitUntil(() => pageText().includes('will be saved for Lily Martin'));
    expect(other.id).not.toBe(selected);
    model.calls([call('confirm_pending_action')], 'Saved.');
    await say('yes');
    await pollUntil(async () => (await diagnosisService.byPatient(other.id)).some((d) => d.description === 'Migraine'));
    expect((await diagnosisService.byPatient(selected!)).some((d) => d.description === 'Migraine')).toBe(false);
  }, TIMEOUT);

  it('the model sending the whole plan again adds only what is new — nothing twice', async () => {
    await renderAppAt('/summary/medication');
    model.then(
      { calls: [call('add_care_plan', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })] },
      { calls: [call('add_care_plan', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }], recalls: [{ reason: 'Review', dueDate: dayjs().add(2, 'week').format('YYYY-MM-DD') }] })] },
      { content: 'Care plan ready.' },
    );
    await say('add metformin 500 mg twice daily and recall him in two weeks');
    await waitUntil(() => pageText().includes('Care plan (2)'));
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Medication1', 'Recall1']);
  }, TIMEOUT);

  it('a record the model adds while the care plan is open joins it as a new tab', async () => {
    await renderAppAt('/summary/medication');
    model.then({ calls: [call('add_care_plan', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency: 'Twice daily' }], tasks: [{ title: 'Blood pressure monitoring' }] })] });
    await say('add metformin 500 mg orally twice daily and a task for blood pressure monitoring');
    await waitUntil(() => pageText().includes('Care plan (2)'));
    const kindTabs = () => [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    // Only the kinds that were said get a tab.
    expect(kindTabs()).toEqual(['Medication1', 'Task1']);
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] });
    await say('also add hypertension as a diagnosis');
    await waitUntil(() => pageText().includes('Care plan (3)'));
    expect(kindTabs()).toEqual(['Medication1', 'Diagnosis1', 'Task1']);
    const values = (field: string) => [...document.querySelectorAll<HTMLInputElement>(`.care-plan-modal [id$="_${field}"]`)].map((el) => el.value);
    expect(values('medicationName')).toEqual(['Metformin']);
    expect(values('description')).toContain('Hypertension');
    expect(store.getState().voice.pendingConfirmation?.formId).toBe('care_plan');
  }, TIMEOUT);

  it('a diagnosis added while the medications form is open turns it into the care plan — the dialog never leaves the screen', async () => {
    await renderAppAt('/summary/medication');
    model.then({ calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }, { medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily' }] })] });
    await say('add metformin and panadol 500 mg twice daily');
    const medications = FormRegistry.get('medication')!;
    await waitUntil(() => medications.isOpen() && !!document.querySelector('.ant-modal [id$="_medicationName"]'));
    // The plan must be on screen while the medications form is still open under it — the form closing
    // first (and the plan zooming in after) is what looks like the dialog closing and reopening.
    let formOpenWhenPlanCame: boolean | null = null;
    const watcher = new MutationObserver(() => {
      if (formOpenWhenPlanCame === null && document.querySelector('.care-plan-modal')) formOpenWhenPlanCame = medications.isOpen();
    });
    watcher.observe(document.body, { subtree: true, childList: true });
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] });
    await say('add hypertension as a diagnosis');
    await waitUntil(() => pageText().includes('Care plan (3)'));
    watcher.disconnect();
    expect(formOpenWhenPlanCame).toBe(true);
    expect(medications.isOpen()).toBe(false); // …and then it is gone, behind the plan
    expect([...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim())).toEqual(['Medication2', 'Diagnosis1']);
    expect([...document.querySelectorAll<HTMLInputElement>('.care-plan-modal [id$="_medicationName"]')].map((el) => el.value)).toEqual(['Metformin', 'Panadol']);
  }, TIMEOUT);

  it('filters and pages the real patient list by voice', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/patients', () => pageText().includes('Add patient'));
    const rows = () => document.querySelectorAll('.mobile-card, .table-row-clickable').length;
    await waitUntil(() => rows() > 0);
    model.calls([call('control_list', { filter: 'Gender', value: 'male' })], 'Showing male patients.');
    await say('show only male patients');
    const males = patientSelectors.selectAll(store.getState()).filter((p) => p.gender === 'Male').length;
    await waitUntil(() => pageText().includes(`${males} result`) || pageText().includes(`${males} of`));
    expect(model.lastToolResults()[0].message).toMatch(new RegExp(`patients list shows ${males} of \\d+ \\(Gender: Male\\), page 1 of`));
    model.calls([call('control_list', { page: 'next' })], 'Page 2.');
    await say('next page');
    expect(model.lastToolResults()[0].message).toMatch(/page 2 of/);
    model.calls([call('control_list', { filter: 'Gender', value: 'purple' })], 'Gender can only be Male, Female, Other or Unknown.');
    await say('show only purple patients');
    expect(model.lastToolResults()[0].message).toMatch(/Gender can be: Male, Female, Other, Unknown/);
  }, TIMEOUT);
});

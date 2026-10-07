/**
 * The flows from the provider's test sheet, single-agent mode, against the real application — with a scripted
 * model that does what qwen3.5:9b did (it reports too little, picks values, names patients who do not exist).
 *
 *   An incomplete request asks ONE polite question and nothing else happens: no page change, no search, no
 *   patient selected, no form. The answer completes it; only then does the assistant run.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import { recordSlices } from '@/store/slices/recordSlices';
import { voiceActions } from '@/store/slices/voiceSlice';
import { RECORD_KINDS } from '@/types/records';
import { getVoiceController } from '@/services/ai/voiceController';
import { router } from '@/app/router';
import { call, FakeMic, ScriptedLLM } from '@/services/ai/__tests__/fakes';
import { questionFor } from '@/services/ai/safety/requirements';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, waitUntil } from './harness';

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

const id = (name: string) => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === name)!.id;
const submit = (tasks: Array<Record<string, unknown>>) => ({ calls: [call('submit_requirements', { tasks })] });

/** The single assistant with requirement gathering on, as the app runs it — on a scripted model. */
async function single(from = '/configuration', selected: string | null = null) {
  store.dispatch(setCurrentPatient(selected ? id(selected) : null));
  await renderAppAt(from);
  const llm = new ScriptedLLM();
  getVoiceController().reconfigure({ llm, stt: new FakeMic(), planning: true, safety: true });
  return { llm }; // (not the model itself: it has a then() — awaiting it would never end)
}

/** Nothing happened: the same page, the same patient, nothing waiting, no dialog. */
function nothingHappened(path: string, patient: string | null) {
  expect(router.state.location.pathname).toBe(path);
  expect(store.getState().patients.currentPatientId).toBe(patient ? id(patient) : null);
  expect(store.getState().voice.pendingConfirmation).toBeNull();
  expect(document.querySelector('.ant-modal')).toBeNull();
}

describe('the questions are polite, and ask only what is missing', () => {
  it('the wording the provider asked for', () => {
    expect(questionFor([{ kind: 'medication', fields: ['medicationName'] }])).toBe('What medication would you like to add?');
    expect(questionFor([{ kind: 'medication', name: 'Gabapentin', fields: ['dosage'] }])).toBe('What dose should be prescribed for Gabapentin?');
    expect(questionFor([{ kind: 'medication', name: 'Gabapentin', fields: ['frequency'] }])).toBe('How often should Gabapentin be taken?');
    expect(questionFor([{ kind: 'medication', name: 'Gabapentin', fields: ['duration'] }])).toBe('How many days should Gabapentin be prescribed for?');
    expect(questionFor([{ kind: 'medication', name: 'Gabapentin', fields: ['route'] }])).toBe('What route should be used for Gabapentin? For example, Oral.');
    expect(questionFor([{ kind: 'record_patient', of: ['medication'] }])).toBe('Which patient should this medication be added to?');
    expect(questionFor([{ kind: 'medication', name: 'Gabapentin', have: 'Gabapentin 500 mg', fields: ['frequency', 'route'] }])).toBe(
      'I have the medication as Gabapentin 500 mg. Please provide the missing information: frequency and route of administration.',
    );
    expect(questionFor([{ kind: 'task', fields: ['title'], patient: 'Luke King' }])).toBe('What task would you like to create for Luke King?');
    expect(questionFor([{ kind: 'recall', fields: ['reason', 'dueDate'], patient: 'Zoe Hill' }])).toBe('What is the recall for Zoe Hill for, and when should it be due?');
    expect(questionFor([{ kind: 'appointment', fields: ['date', 'startTime', 'reason'], patient: 'Tom Baker' }])).toBe(
      'What date and time should the appointment for Tom Baker be scheduled for, and what is the reason for the visit?',
    );
    expect(questionFor([{ kind: 'which_patient', said: 'John', options: ['Josh Clarke (MRN-1)'], close: true }])).toBe('I couldn\'t find a patient named "John". Did you mean Josh Clarke (MRN-1)?');
  });
});

describe('single-agent mode: requirements first — nothing runs until the request is complete', () => {
  it('"Add Panadol to Tom Baker" (on Configuration): one polite question, nothing moves — the answer completes it, then the form opens', async () => {
    const { llm } = await single();
    llm.then(submit([{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'medication', values: { medicationName: 'Panadol' } }] }]));
    await say('Add Panadol to Tom Baker.');
    expect(store.getState().voice.response).toBe('I have the medication as Panadol. Please provide the missing information: dose and frequency.');
    nothingHappened('/configuration', null);
    expect(llm.requests).toHaveLength(1); // only the Planning Agent thought — the assistant never ran

    llm.then(
      submit([{ task: 't1', action: 'add_records', records: [{ kind: 'medication', values: { dosage: '500 mg', frequency: 'twice daily' } }] }]),
      { calls: [call('add_medications', { medications: [{ medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily', patient: 'Tom Baker' }] })] },
      { content: 'The Panadol form for Tom Baker is ready — please review and confirm.' },
    );
    await say('500 mg twice a day');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    expect(pageText()).toContain('Panadol');
    // The assistant got the whole request, the answer included, and the approved requirements.
    const sent = String(llm.requests[2].at(-1)?.content ?? '');
    expect(sent).toContain('Add Panadol to Tom Baker. — 500 mg twice a day');
    expect(sent).toContain('APPROVED REQUIREMENTS');
  }, TIMEOUT);

  it('"Add the appropriate antibiotic to Chloe Bell and choose the dose yourself": the model\'s "antibiotic" is no drug — asked which, nothing chosen', async () => {
    const { llm } = await single();
    llm.then(submit([{ task: 't1', action: 'add_records', patient: 'Chloe Bell', records: [{ kind: 'medication', values: { medicationName: 'antibiotic' } }] }]));
    await say('Add the appropriate antibiotic to Chloe Bell and choose the dose yourself.');
    expect(store.getState().voice.response).toBe('What medication would you like to add for Chloe Bell? Please also tell me the dose and how often it should be taken.');
    nothingHappened('/configuration', null);
  }, TIMEOUT);

  it('"Give Luke King whatever medication is normally used for his condition": asked which — the assistant never reads his chart', async () => {
    const { llm } = await single();
    llm.then(submit([{ task: 't1', action: 'add_records', patient: 'Luke King', records: [{ kind: 'medication', values: {} }] }]));
    await say('Give Luke King whatever medication is normally used for his condition.');
    expect(store.getState().voice.response).toBe('What medication would you like to add for Luke King? Please also tell me the dose and how often it should be taken.');
    nothingHappened('/configuration', null);
    expect(llm.requests).toHaveLength(1);
  }, TIMEOUT);

  it('"Select John": nobody is called John — asked, with the names spelled like it; no search on screen', async () => {
    const { llm } = await single();
    llm.then(submit([{ task: 't1', action: 'select_patient', patient: 'John' }]));
    await say('Select John.');
    expect(store.getState().voice.response).toMatch(/^I couldn't find a patient named "John"\. (Did you mean .+|Which patient do you mean)\?$/);
    nothingHappened('/configuration', null);
  }, TIMEOUT);

  it('"Recall Luke King after two weeks": only what the recall is for — the date and the patient were said', async () => {
    const { llm } = await single();
    llm.then(submit([{ task: 't1', action: 'add_records', patient: 'Luke King', records: [{ kind: 'recall', values: { reason: 'Recall Luke King after two weeks' } }] }]));
    await say('Recall Luke King after two weeks.');
    expect(store.getState().voice.response).toBe('What is the reason for the recall for Luke King?');
    nothingHappened('/configuration', null);
  }, TIMEOUT);

  it('"Schedule a follow-up with the patient next week": "next week" is no day — asked which day and time', async () => {
    const { llm } = await single('/configuration', 'Tom Baker');
    llm.then(submit([{ task: 't1', action: 'add_records', records: [{ kind: 'appointment', values: { date: '2026-10-09', reason: 'follow-up' } }] }]));
    await say('Schedule a follow-up with the patient next week.');
    expect(store.getState().voice.response).toBe('What date and time should the appointment be scheduled for?');
    nothingHappened('/configuration', 'Tom Baker');
  }, TIMEOUT);

  it('a complete request goes straight through — and an appointment is with the signed-in provider (never "What provider?")', async () => {
    const { llm } = await single();
    llm.then(
      submit([{ task: 't1', action: 'add_records', patient: 'Tom Baker', records: [{ kind: 'appointment', values: { date: 'next Tuesday', startTime: '3 PM', reason: 'follow-up' } }] }]),
      { calls: [call('add_appointments', { appointments: [{ patient: 'Tom Baker', date: '2026-10-06', startTime: '15:00', reason: 'Follow-up' }] })] },
      { content: 'The appointment is ready — please confirm.' },
    );
    await say('Schedule a follow-up appointment for Tom Baker next Tuesday at 3 PM.');
    await waitUntil(() => !!store.getState().voice.pendingConfirmation || !!store.getState().voice.pendingSlot);
    expect(store.getState().voice.pendingSlot).toBeNull();
    expect(store.getState().voice.pendingConfirmation?.summary.find((s) => /provider/i.test(s.label))?.value).toBe('Dr. Lucy White');
  }, TIMEOUT);
});

describe('a new request while an unsaved form waits replaces it', () => {
  it('"Add Metformin 500 mg twice daily …" then "… once daily …" for Chloe Bell: the first is closed unsaved, the second prepared', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/configuration');
    const llm = new ScriptedLLM();
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), safety: true });
    const med = (frequency: string) => ({ calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency, patient: 'Chloe Bell' }] })] });
    llm.then(med('Twice daily'), { content: 'Ready — please confirm.' });
    await say('Add Metformin 500 mg twice daily by oral to Chloe Bell.');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    llm.then(med('Once daily'), { content: 'The Metformin once daily form is ready — please confirm.' });
    await say('Add Metformin 500 mg once daily by oral to Chloe Bell.');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.summary.some((s) => s.value === 'Once daily') ?? false);
    expect(store.getState().voice.response).toMatch(/^The earlier unsaved medication was closed without saving\. /);
    expect(store.getState().voice.response).not.toMatch(/waiting|answer it/i);
  }, TIMEOUT);
});

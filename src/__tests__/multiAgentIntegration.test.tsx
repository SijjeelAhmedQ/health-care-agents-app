/**
 * The multi-agent mode against the real application: the master's task graph carried out by the
 * specialists through the real tools, runtime, forms and store — with the same confirmations. Records of
 * several agents (a medication, a task, a follow-up) are one care plan with one confirmation; the graph waits
 * across turns and resumes. The Summary Agent writes summaries with no tools, into the Summary panel.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import { appointmentsSlice, recordSlices } from '@/store/slices/recordSlices';
import { voiceActions } from '@/store/slices/voiceSlice';
import { RECORD_KINDS } from '@/types/records';
import { getVoiceController } from '@/services/ai/voiceController';
import { call, FakeMic, type ScriptedLLM } from '@/services/ai/__tests__/fakes';
import type { ChatLLM, ChatMessage, ChatTurn } from '@/services/ai/providers/llm';
import type { ToolCall } from '@/types/ai';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, useScriptedModel, waitUntil } from './harness';

const TIMEOUT = 40000;
let model: ScriptedLLM;

beforeAll(installBrowserStubs);

beforeEach(async () => {
  store.dispatch(voiceActions.resetVoice());
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchProviders()).unwrap();
  for (const kind of RECORD_KINDS) await store.dispatch((recordSlices[kind] as (typeof recordSlices)['medication']).fetchAll()).unwrap();
  model = useScriptedModel({ multiAgent: true });
});

afterEach(async () => {
  await unmountApp();
});

/** Which agent a model request was for, from its system prompt. */
const agentOf = (messages: ScriptedLLM['requests'][number]) => {
  const system = String(messages[0]?.content ?? '');
  return /^You are the master agent/.test(system) ? 'master' : (system.match(/You are the (Patients|Dashboard|My Appointment|Appointments|Medication|Diagnoses|Tasks|Recalls|Notes|Summary|Inbox) Agent/)?.[1] ?? '?');
};

describe('multi-agent mode in the real application', () => {
  it('select a patient, then a medication, a task and a follow-up — three agents, ONE care plan, ONE confirmation, resumed across turns', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/patients');
    expect(getVoiceController().isMultiAgent).toBe(true);
    const tuesday = dayjs().day() < 2 ? dayjs().day(2) : dayjs().add(1, 'week').day(2);
    const owned = (kind: (typeof RECORD_KINDS)[number], patientId: string) => (recordSlices[kind].selectors.selectAll(store.getState()) as Array<{ patientId: string }>).filter((r) => r.patientId === patientId).length;
    const harry = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Harry White')!;
    const before = Object.fromEntries(RECORD_KINDS.map((k) => [k, owned(k, harry.id)]));

    const llm = new RoutedChat()
      .script('master', {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'patients', instruction: 'Select Harry White', execution: 'CONTEXT' },
              { id: 't2', agent: 'medications', instruction: 'Add metformin 500 mg by mouth twice daily for 30 days', depends_on: ['t1'], execution: 'WRITE' },
              { id: 't3', agent: 'tasks', instruction: 'Add a task for blood pressure monitoring', depends_on: ['t1'], execution: 'WRITE' },
              { id: 't4', agent: 'patient_appointments', instruction: 'Schedule a follow-up next Tuesday at 3 pm', depends_on: ['t1'], execution: 'WRITE' },
            ],
          }),
        ],
      })
      .script('Patients', { calls: [call('select_patient', { patient: 'Harry White' })] }, { content: 'Harry White is selected.' })
      .script('Medication', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', route: 'Oral', frequency: 'Twice daily', duration: '30 days' }] })] }, { content: 'The medication is ready.' })
      .script('Tasks', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }] })] }, { content: 'The task is in the care plan.' })
      .script('Appointments', { calls: [call('add_appointments', { appointments: [{ date: tuesday.format('YYYY-MM-DD'), startTime: '15:00', type: 'Follow-up', reason: 'Follow-up' }] })] }, { content: 'The care plan is ready — please review and confirm.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });

    await say('select harry white, add metformin 500 mg by mouth twice daily for 30 days and a task for blood pressure monitoring, and schedule a follow-up next Tuesday at 3 pm');
    await waitUntil(() => store.getState().voice.taskGraph?.tasks.slice(1).every((t) => t.status === 'WAITING_FOR_USER') ?? false, 20000);
    await waitUntil(() => pageText().includes('Care plan (3)'));

    // One care plan holds every agent's records — the medication, the task and the follow-up.
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Medication1', 'Task1', 'Appointment1']);
    expect(store.getState().voice.pendingConfirmation?.formId).toBe('care_plan');
    let graph = store.getState().voice.taskGraph!;
    expect(graph.tasks.map((t) => [t.agent, t.status, t.joinedInto])).toEqual([
      ['patients', 'COMPLETED', undefined],
      ['medications', 'WAITING_FOR_USER', 't4'],
      ['tasks', 'WAITING_FOR_USER', 't4'],
      ['patient_appointments', 'WAITING_FOR_USER', undefined],
    ]);
    expect(graph.tasks[0].result).toMatchObject({ patientId: harry.id, patientName: 'Harry White' });
    // The steps show in the assistant panel, each with its agent.
    expect([...document.querySelectorAll('.va-plan .va-plan-agent')].map((e) => e.textContent)).toEqual(['Patients Agent', 'Medication Agent', 'Tasks Agent', 'Appointments Agent']);
    // Nothing is saved before the provider says so.
    expect(owned('medication', harry.id)).toBe(before.medication);

    // One "yes" saves all three — no master call, no second confirmation.
    llm.script('Appointments', { calls: [call('confirm_pending_action')] }, { content: 'The care plan is saved.' });
    await say('yes save it');
    await waitUntil(() => owned('appointment', harry.id) === before.appointment + 1);
    expect(owned('medication', harry.id)).toBe(before.medication + 1);
    expect(owned('task', harry.id)).toBe(before.task + 1);
    const appt = (appointmentsSlice.selectors.selectAll(store.getState()) as Array<{ patientId: string; date: string; startTime: string }>).filter((a) => a.patientId === harry.id);
    expect(appt.some((a) => a.date === tuesday.format('YYYY-MM-DD') && a.startTime === '15:00')).toBe(true);
    await waitUntil(() => store.getState().voice.taskGraph!.tasks.every((t) => t.status === 'COMPLETED'));
    graph = store.getState().voice.taskGraph!;
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    // The debug trace holds the task graph.
    expect(store.getState().voice.trace?.graph?.tasks).toHaveLength(4);
  }, TIMEOUT);

  it('"Summarize all inbox normal records": the Inbox opens on the normal records first, then the Summary Agent\'s summary (written with no tools) beside it', async () => {
    await renderAppAt('/dashboard');
    const normal = store.getState().inbox.items.filter((i) => i.status === 'Normal');
    model.then(
      { calls: [call('assign_tasks', { tasks: [{ agent: 'summary', instruction: 'Summarize all inbox normal records', execution: 'READ_ONLY' }] })] },
      { content: `**Summary:** ${normal.length} normal Inbox records, none needing attention.` },
    );
    await say('Summarize all inbox normal records');
    await waitUntil(() => store.getState().ui.summary?.status === 'ready');
    // The Summary Agent's model was offered no tools at all — MedGemma can write it.
    expect(model.tools).toEqual([]);
    const summary = store.getState().ui.summary!;
    expect(summary.facts.title).toBe('Normal Inbox records');
    expect(summary.facts.scope).toBe(`All patients · ${normal.length} records`);
    expect(summary.text).toBe(`Summary: ${normal.length} normal Inbox records, none needing attention.`); // markdown taken out
    expect(summary.source).toBe('model');
    // The Inbox first — every category, only the normal records — and the summary beside it.
    await waitUntil(() => !!document.querySelector('.sum-dock'));
    expect(document.querySelector('.sum-dock')!.textContent).toContain(`${normal.length} normal Inbox records`);
    expect(store.getState().navigation.currentPageId).toBe('inbox-all');
    expect(pageText()).toContain('Status: Normal');
    expect(document.querySelector('.sum-dock .dash-dock-foot')!.textContent).not.toContain('Open the Inbox'); // it is on screen
    // One line from the assistant.
    expect(store.getState().voice.response).toBe(`Here's the summary — Normal Inbox records, All patients · ${normal.length} records. It's open in the Summary panel.`);
  }, TIMEOUT);

  it('"Go to inbox and open all abnormal records summary" on Configuration — the master’s task lost "inbox": still the Inbox’s abnormal records, never the Configuration page', async () => {
    await renderAppAt('/configuration');
    const abnormal = store.getState().inbox.items.filter((i) => i.status === 'Abnormal');
    model.then(
      // What qwen3.5:9b may send: the Inbox part as its own task, the summary without the word "inbox".
      { calls: [call('assign_tasks', { tasks: [{ agent: 'summary', instruction: 'Open all abnormal records summary', execution: 'READ_ONLY' }] })] },
      { content: `${abnormal.length} abnormal records need review.` },
    );
    await say('Go to inbox and open all abnormal records summary');
    await waitUntil(() => store.getState().ui.summary?.status === 'ready');
    expect(store.getState().ui.summary!.facts.title).toBe('Abnormal Inbox records');
    expect(store.getState().navigation.currentPageId).toBe('inbox-all');
    expect(pageText()).toContain('Status: Abnormal');
    expect(store.getState().voice.response).toBe(`Here's the summary — Abnormal Inbox records, All patients · ${abnormal.length} records. It's open in the Summary panel.`);
  }, TIMEOUT);

  it('a summary with no model answering is still written — from the records alone', async () => {
    const harry = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Harry White')!;
    store.dispatch(setCurrentPatient(harry.id));
    await renderAppAt('/summary/medication');
    model.then({ calls: [call('assign_tasks', { tasks: [{ agent: 'summary', instruction: 'Summarize this page', execution: 'READ_ONLY' }] })] }, { content: '' });
    await say('summarize this page');
    await waitUntil(() => store.getState().ui.summary?.status === 'ready');
    const summary = store.getState().ui.summary!;
    expect(summary.facts.title).toBe('Medications');
    expect(summary.facts.scope).toMatch(/^Harry White · /);
    expect(store.getState().navigation.currentPageId).toBe('summary-medication'); // "this page": it stays
    expect(summary.source).toBe('rules');
    expect(summary.text).toMatch(/Medications — Harry White/);
  }, TIMEOUT);
});

/** A model scripted per agent, that answers every agent at once (the multi-agent mode's parallel tasks). */
class RoutedChat implements ChatLLM {
  readonly name = 'routed';
  private scripts = new Map<string, Array<{ content?: string; calls?: ToolCall[] }>>();
  active = 0;
  maxActive = 0;
  script(agent: string, ...turns: Array<{ content?: string; calls?: ToolCall[] }>) {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), ...turns]);
    return this;
  }
  async chat(messages: ChatMessage[]): Promise<ChatTurn> {
    const who = agentOf(messages);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((r) => setTimeout(r, 60)); // every model call takes a while, as on a GPU
      const next = this.scripts.get(who)?.shift();
      return { content: next?.content ?? `${who} done.`, toolCalls: next?.calls ?? [] };
    } finally {
      this.active--;
    }
  }
}

describe('the record agents of one request work at the same time', () => {
  it('Tom Baker: medications, a diagnosis, a task, a recall and a follow-up — five agents think at once, one care plan, one "yes" saves all', async () => {
    const tom = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;
    store.dispatch(setCurrentPatient(tom.id));
    await renderAppAt('/summary');
    const tuesday = dayjs().day() < 2 ? dayjs().day(2) : dayjs().add(1, 'week').day(2);
    const owned = (kind: (typeof RECORD_KINDS)[number]) => (recordSlices[kind].selectors.selectAll(store.getState()) as Array<{ patientId: string }>).filter((r) => r.patientId === tom.id).length;
    const before = Object.fromEntries(RECORD_KINDS.map((k) => [k, owned(k)]));
    const llm = new RoutedChat()
      .script('master', {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'medications', instruction: 'Add metformin and Panadol 500 mg twice daily for 30 days for Tom Baker', execution: 'WRITE' },
              { id: 't2', agent: 'diagnoses', instruction: 'Add hypertension as a diagnosis for Tom Baker', execution: 'WRITE' },
              { id: 't3', agent: 'tasks', instruction: 'Create a task for blood pressure monitoring for Tom Baker', execution: 'WRITE' },
              { id: 't4', agent: 'recalls', instruction: 'Recall Tom Baker for neck pain after two weeks', execution: 'WRITE' },
              { id: 't5', agent: 'patient_appointments', instruction: 'Schedule a follow-up for Tom Baker next Tuesday at 4:30 pm', execution: 'WRITE' },
            ],
          }),
        ],
      })
      .script('Medication', { calls: [call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', duration: '30 days', route: 'Oral' }, { medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily', duration: '30 days', route: 'Oral' }] })] }, { content: 'Medications added.' })
      .script('Diagnoses', { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] }, { content: 'Diagnosis added.' })
      .script('Tasks', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }] })] }, { content: 'Task added.' })
      .script('Recalls', { calls: [call('add_recalls', { recalls: [{ reason: 'Neck pain', dueDate: dayjs().add(14, 'day').format('YYYY-MM-DD') }] })] }, { content: 'Recall added.' })
      .script('Appointments', { calls: [call('add_appointments', { appointments: [{ date: tuesday.format('YYYY-MM-DD'), startTime: '16:30', type: 'Follow-up', reason: 'Follow-up' }] })] }, { content: 'Follow-up added.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });

    await say('select tom baker and add metformin, panadol 500 mg twice daily for 30 days, hypertension as a diagnosis, a task for blood pressure monitoring, recall him for neck pain after two weeks and a follow-up next tuesday at 4:30 pm');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'care_plan');
    // All five agents' models were working at the same time.
    expect(llm.maxActive).toBeGreaterThanOrEqual(5);
    await waitUntil(() => pageText().includes('Care plan (6)'));
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Medication2', 'Diagnosis1', 'Task1', 'Recall1', 'Appointment1']);
    const tasks = store.getState().voice.taskGraph!.tasks;
    expect(tasks.every((t) => t.status === 'WAITING_FOR_USER')).toBe(true);
    expect(tasks.filter((t) => !t.joinedInto)).toHaveLength(1); // one care plan, one confirmation

    const lead = tasks.find((t) => !t.joinedInto)!;
    const agentName = { medications: 'Medication', diagnoses: 'Diagnoses', tasks: 'Tasks', recalls: 'Recalls', patient_appointments: 'Appointments' }[lead.agent as 'tasks']!;
    llm.script(agentName, { calls: [call('confirm_pending_action')] }, { content: 'The care plan is saved — 6 records.' });
    await say('yes');
    // One "yes" saves all six — the care plan saves them one after another.
    await waitUntil(() => RECORD_KINDS.every((k) => owned(k) > before[k]), 15000);
    expect([owned('medication') - before.medication, owned('diagnosis') - before.diagnosis, owned('task') - before.task, owned('recall') - before.recall]).toEqual([2, 1, 1, 1]);
    await waitUntil(() => store.getState().voice.taskGraph!.tasks.every((t) => t.status === 'COMPLETED'));
  }, TIMEOUT);
});

describe('agents that reach for another agent’s open form', () => {
  it('the recall form opens first; the Diagnoses and Tasks Agents try to fill or save it — told to add their own, all three end in one care plan', async () => {
    const tom = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;
    store.dispatch(setCurrentPatient(tom.id));
    await renderAppAt('/summary');
    const llm = new RoutedChat()
      .script('master', {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'recalls', instruction: 'Recall Tom Baker for neck pain after two weeks', execution: 'WRITE' },
              { id: 't2', agent: 'diagnoses', instruction: 'Add hypertension as a diagnosis for Tom Baker', execution: 'WRITE' },
              { id: 't3', agent: 'tasks', instruction: 'Create a task for blood pressure monitoring for Tom Baker', execution: 'WRITE' },
            ],
          }),
        ],
      })
      .script('Recalls', { calls: [call('add_recalls', { recalls: [{ reason: 'Neck pain', dueDate: dayjs().add(14, 'day').format('YYYY-MM-DD') }] })] }, { content: 'Recall ready.' })
      .script('Diagnoses', { calls: [call('fill_open_form', { description: 'Hypertension' })] }, { calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] }, { content: 'Diagnosis added.' })
      .script('Tasks', { calls: [call('save_open_form')] }, { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }] })] }, { content: 'Task added.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });
    await say('recall tom baker for neck pain after two weeks, add hypertension and a task for blood pressure monitoring');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'care_plan');
    await waitUntil(() => pageText().includes('Care plan (3)'));
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Diagnosis1', 'Task1', 'Recall1']);
    expect(store.getState().voice.taskGraph!.tasks.filter((t) => !t.joinedInto)).toHaveLength(1);
    expect(store.getState().voice.pendingConfirmation?.summary.find((x) => /reason/i.test(x.label) && /hypertension/i.test(x.value))).toBeUndefined(); // the recall was never filled with the diagnosis
  }, TIMEOUT);
});

describe('the provider saves on screen instead of saying yes', () => {
  it('"Change the frequency of Tom Baker\'s Gabapentin to once daily" → the form\'s own Update: the assistant and the agent stop waiting — and the next request is a new one', async () => {
    const tom = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;
    store.dispatch(setCurrentPatient(tom.id));
    await renderAppAt('/summary/medication');
    const gabapentin = () => (recordSlices.medication.selectors.selectAll(store.getState()) as Array<{ patientId: string; name: string; frequency: string }>).find((m) => m.patientId === tom.id && /gabapentin/i.test(m.name));
    expect(gabapentin()).toBeDefined();
    const llm = new RoutedChat()
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'medications', instruction: "Change the frequency of Tom Baker's Gabapentin to once daily.", execution: 'WRITE' }] })] })
      .script('Medication', { calls: [call('update_record', { kind: 'medication', record: 'Gabapentin', changes: { frequency: 'Once daily' }, patient: 'Tom Baker' })] }, { content: 'Please review and confirm to save this change.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });

    await say("Change the frequency of Tom Baker's Gabapentin to once daily.");
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    expect(store.getState().voice.taskGraph!.tasks[0].status).toBe('WAITING_FOR_USER');

    // The provider clicks the form's own Update — not the assistant's Confirm, not "yes".
    const update = [...document.querySelectorAll('.ant-modal-footer button.ant-btn-primary')].at(-1) as HTMLButtonElement;
    update.click();
    await waitUntil(() => gabapentin()!.frequency === 'Once daily');
    await waitUntil(() => store.getState().voice.taskGraph?.tasks[0].status === 'COMPLETED');
    const voice = store.getState().voice;
    expect(voice.pendingConfirmation).toBeNull();
    expect(voice.pendingSlot).toBeNull();
    expect(voice.status).not.toBe('confirmation_required');
    expect(voice.response).toMatch(/saved/i);
    expect(store.getState().monitor.agents.medications.status).not.toBe('waiting');

    // What the provider says next is a new request for the master — never "an answer" to what was saved.
    llm
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'patients', instruction: 'Go to patients and select Tom Baker', execution: 'CONTEXT' }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Tom Baker' })] }, { content: 'Tom Baker is selected.' });
    await say('go to patients and sleect tom baker');
    await waitUntil(() => store.getState().voice.taskGraph?.tasks[0].agent === 'patients');
    expect(store.getState().voice.response).toBe('Tom Baker is selected.');
  }, TIMEOUT);

  it('a form the assistant prepared, closed with its own Cancel: nothing saved, nothing left waiting', async () => {
    const tom = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;
    store.dispatch(setCurrentPatient(tom.id));
    await renderAppAt('/summary/medication');
    const llm = new RoutedChat()
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'medications', instruction: "Change the frequency of Tom Baker's Gabapentin to once daily.", execution: 'WRITE' }] })] })
      .script('Medication', { calls: [call('update_record', { kind: 'medication', record: 'Gabapentin', changes: { frequency: 'Once daily' }, patient: 'Tom Baker' })] }, { content: 'Please review and confirm.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });
    await say("Change the frequency of Tom Baker's Gabapentin to once daily.");
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    const cancel = [...document.querySelectorAll('.ant-modal-footer button')].find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement;
    cancel.click();
    // If the form asks before discarding, the provider says Discard.
    await new Promise((r) => setTimeout(r, 300));
    ([...document.querySelectorAll('.ant-modal-confirm-btns button')].find((b) => b.textContent?.includes('Discard')) as HTMLButtonElement | undefined)?.click();
    await waitUntil(() => store.getState().voice.taskGraph?.tasks[0].status === 'CANCELLED');
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    expect(store.getState().voice.response).toMatch(/nothing was saved/i);
  }, TIMEOUT);
});

describe('a draft waits for its yes, and the provider asks for something else', () => {
  const tom = () => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;
  const luke = () => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Luke King')!;
  const tasksOf = (id: string) => (recordSlices.task.selectors.selectAll(store.getState()) as Array<{ patientId: string; title: string }>).filter((t) => t.patientId === id && /blood pressure/i.test(t.title)).length;

  async function draftForTom(llm: RoutedChat) {
    store.dispatch(setCurrentPatient(tom().id));
    await renderAppAt('/summary/task');
    llm
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'tasks', instruction: 'Create a task for blood pressure monitoring', execution: 'WRITE' }] })] })
      .script('Tasks', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }] })] }, { content: 'The task is ready — please confirm.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });
    await say('crate task for blood pressure monitoring');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
  }

  it('"go to patients and sleect luke king": held — never applied to Tom Baker\'s task; "discard" closes it, then Luke King is selected', async () => {
    const llm = new RoutedChat();
    await draftForTom(llm);
    const before = { tom: tasksOf(tom().id), luke: tasksOf(luke().id) };

    llm
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'patients', instruction: 'Go to patients and select Luke King', execution: 'CONTEXT' }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Luke King' })] }, { content: 'Luke King is selected.' });
    await say('go to patients and sleect luke king');
    // One question — nothing else happened: Tom Baker is still selected, his task still his, nothing ran.
    expect(store.getState().voice.response).toBe('The task for Tom Baker isn\'t saved yet. Should I save it first, or discard it? Then I\'ll go on with “go to patients and sleect luke king”.');
    expect(store.getState().patients.currentPatientId).toBe(tom().id);
    expect(String(store.getState().voice.pendingConfirmation?.summary.find((x) => x.label === 'Patient')?.value)).toMatch(/Tom Baker/);

    await say('discard');
    await waitUntil(() => store.getState().patients.currentPatientId === luke().id);
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    expect([tasksOf(tom().id), tasksOf(luke().id)]).toEqual([before.tom, before.luke]); // nothing saved, for anyone
    expect(store.getState().voice.response).toBe('The task for Tom Baker was discarded — nothing was saved. Luke King is selected.');
  }, TIMEOUT);

  it('…or "save it first": Tom Baker\'s task is saved for Tom Baker, then Luke King is selected', async () => {
    const llm = new RoutedChat();
    await draftForTom(llm);
    const before = { tom: tasksOf(tom().id), luke: tasksOf(luke().id) };
    llm
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'patients', instruction: 'Go to patients and select Luke King', execution: 'CONTEXT' }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Luke King' })] }, { content: 'Luke King is selected.' });
    await say('go to patients and sleect luke king');
    await say('save it first');
    await waitUntil(() => store.getState().patients.currentPatientId === luke().id);
    expect([tasksOf(tom().id), tasksOf(luke().id)]).toEqual([before.tom + 1, before.luke]);
    expect(store.getState().voice.response).toMatch(/saved\. Luke King is selected\.$/);
    expect(store.getState().voice.taskGraph!.tasks.every((t) => t.status === 'COMPLETED')).toBe(true);
  }, TIMEOUT);

  it('…or the form\'s own Save Task: the held request runs at once', async () => {
    const llm = new RoutedChat();
    await draftForTom(llm);
    const before = tasksOf(tom().id);
    llm
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'patients', instruction: 'Go to patients and select Luke King', execution: 'CONTEXT' }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Luke King' })] }, { content: 'Luke King is selected.' });
    await say('go to patients and sleect luke king');
    ([...document.querySelectorAll('.ant-modal-footer button.ant-btn-primary')].at(-1) as HTMLButtonElement).click();
    await waitUntil(() => store.getState().patients.currentPatientId === luke().id);
    expect(tasksOf(tom().id)).toBe(before + 1);
    expect(store.getState().voice.pendingConfirmation).toBeNull();
  }, TIMEOUT);

  it('single-agent mode too: held, asked, then "discard" — and Luke King is selected, never given Tom Baker’s task', async () => {
    store.dispatch(setCurrentPatient(tom().id));
    await renderAppAt('/summary/task');
    const before = { tom: tasksOf(tom().id), luke: tasksOf(luke().id) };
    // The single assistant's prompt carries no agent name: its script is "?".
    const llm = new RoutedChat()
      .script('?', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }] })] }, { content: 'The task is ready — please confirm.' })
      .script('?', { calls: [call('select_patient', { patient: 'Luke King' })] }, { content: 'Luke King is selected.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: false });
    await say('crate task for blood pressure monitoring');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    await say('go to patients and sleect luke king');
    expect(store.getState().voice.response).toMatch(/^The task for Tom Baker isn't saved yet\. Should I save it first, or discard it\?/);
    expect(store.getState().patients.currentPatientId).toBe(tom().id);
    await say('discard it');
    await waitUntil(() => store.getState().patients.currentPatientId === luke().id);
    expect([tasksOf(tom().id), tasksOf(luke().id)]).toEqual([before.tom, before.luke]);
    expect(store.getState().voice.pendingConfirmation).toBeNull();
  }, TIMEOUT);

  it('the sequence from testing: discard, select Luke King ("How would you like to proceed?"), then "create a task … and recall …" — done for Luke King, never stuck', async () => {
    const llm = new RoutedChat();
    await draftForTom(llm);
    await say('go to patiesnt and sleect luke king');
    llm
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'patients', instruction: 'Go to patients and select Luke King', execution: 'CONTEXT' }] })] })
      .script('Patients', { calls: [call('select_patient', { patient: 'Luke King' })] }, { content: "I've found and selected Luke King (MRN: MRN-104512). His summary is now open. How would you like to proceed?" });
    await say('discard');
    await waitUntil(() => store.getState().patients.currentPatientId === luke().id);
    expect(store.getState().voice.taskGraph!.tasks[0].status).toBe('COMPLETED');

    llm
      .script('master', {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'tasks', instruction: 'Create a task for BP monitoring', execution: 'WRITE' },
              { id: 't2', agent: 'recalls', instruction: 'Recall the patient for neck pain after two weeks', execution: 'WRITE' },
            ],
          }),
        ],
      })
      .script('Tasks', { calls: [call('add_tasks', { tasks: [{ title: 'BP monitoring', category: 'Monitoring' }] })] }, { content: 'Task ready.' })
      .script('Recalls', { calls: [call('add_recalls', { recalls: [{ reason: 'Neck pain', dueDate: dayjs().add(14, 'day').format('YYYY-MM-DD') }] })] }, { content: 'Recall ready.' });
    await say('create a task for bp monitoring and recall a patient for neck pain after two weeks');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'care_plan');
    const kindTabs = [...document.querySelectorAll('.care-plan-kinds > .ant-tabs-nav .ant-tabs-tab')].map((t) => t.textContent?.trim());
    expect(kindTabs).toEqual(['Task1', 'Recall1']);
    expect(store.getState().voice.response).not.toMatch(/What task and recall would you like to add/);
  }, TIMEOUT);

  it('…or "keep it": the task stays open for Tom Baker, and nothing else is done', async () => {
    const llm = new RoutedChat();
    await draftForTom(llm);
    await say('go to patients and sleect luke king');
    await say('keep it');
    expect(store.getState().voice.response).toMatch(/^Okay — the task for Tom Baker stays open, and I won't do “go to patients and sleect luke king”\./);
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('form');
    expect(store.getState().patients.currentPatientId).toBe(tom().id);
  }, TIMEOUT);
});

describe('the Safety Agent checks every reply before it is shown', () => {
  it('a model claiming "The task has been created" while it waits for the yes: corrected before the provider sees it — and every request shows the Safety Agent at work', async () => {
    const tom = patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Tom Baker')!;
    store.dispatch(setCurrentPatient(tom.id));
    await renderAppAt('/summary/task');
    const llm = new RoutedChat()
      .script('master', { calls: [call('assign_tasks', { tasks: [{ id: 't1', agent: 'tasks', instruction: 'Create a task for blood pressure monitoring', execution: 'WRITE' }] })] })
      .script('Tasks', { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring', category: 'Monitoring' }] })] }, { content: 'Ready.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });
    await say('crate task for blood pressure monitoring');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    // Asked about it, the waiting agent claims what has not happened.
    llm.script('Tasks', { content: 'Yes — the task has been created for Tom Baker. Category: Monitoring.' });
    const from = store.getState().monitor.events.length;
    await say('did you add it');
    expect(store.getState().voice.response).toBe('Category: Monitoring. Nothing is saved yet — review it, then say “save it” to confirm, or cancel.');
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('form'); // still waiting, as the reply now says
    const safety = store.getState().monitor.events.slice(from).filter((e) => e.type === 'safety.reviewed');
    expect(safety.at(-1)!.summary).toMatch(/^Safety Agent: corrected the response before it was shown — it said something was saved that still waits for the yes/);
    expect(store.getState().monitor.agents.safety.status).toBe('completed');

    // A reply with nothing to correct: the Safety Agent still checked it.
    llm.script('master', { content: 'Good morning!' });
    const next = store.getState().monitor.events.length;
    await say('good morning');
    expect(store.getState().monitor.events.slice(next).some((e) => e.type === 'safety.reviewed' && /response checked before it was shown/.test(e.summary))).toBe(true);
  }, TIMEOUT);
});

describe('independent tasks run at the same time in the real application', () => {
  /** Every Inbox record carrying the comment. */
  const commented = (text: string) => Object.entries(store.getState().inbox.comments).filter(([, list]) => list.some((c) => c.text === text)).map(([id]) => id).sort();

  it('"go to patients select <patient> and add comment hello world to all patients normal inbox records": two agents at once — the comment on EVERY patient\'s normal records, not only the selected one\'s', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/dashboard');
    const items = store.getState().inbox.items;
    const tom = items.find((i) => i.status === 'Normal')!;
    const name = tom.patientName;
    const allNormal = items.filter((i) => i.status === 'Normal').map((i) => i.id).sort();
    expect(new Set(items.filter((i) => i.status === 'Normal').map((i) => i.patientId)).size).toBeGreaterThan(1); // more patients than the selected one
    const llm = new RoutedChat()
      .script('master', {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'patients', instruction: `Go to patients and select ${name}`, execution: 'CONTEXT' },
              { id: 't2', agent: 'inbox', instruction: 'Add comment hello world to all patients normal inbox records', execution: 'WRITE' },
            ],
          }),
        ],
      })
      .script('Patients', { calls: [call('select_patient', { patient: name })] }, { content: `${name} is selected.` })
      // The worst case: the model says which records but forgets whose. What was SAID decides: all patients.
      .script('Inbox', { calls: [call('inbox_add_comment', { text: 'hello world', which: 'normal' })] }, { content: 'Comment added.' });
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true, parallelReads: true });

    await say(`go to patients select ${name} and add comment hello world to all patients normal inbox records`);
    await waitUntil(() => store.getState().voice.taskGraph?.tasks.every((t) => t.status === 'COMPLETED') ?? false);

    const graph = store.getState().voice.taskGraph!;
    expect(graph.tasks.map((t) => [t.agent, t.status, t.dependsOn.length])).toEqual([
      ['patients', 'COMPLETED', 0],
      ['inbox', 'COMPLETED', 0],
    ]);
    expect(llm.maxActive).toBe(2); // the two specialists thought at the same time
    expect(commented('hello world')).toEqual(allNormal); // every patient's normal records — and nothing else
    expect(store.getState().patients.currentPatientId).toBe(tom.patientId); // and the patient is selected
    const request = store.getState().monitor.requests[0].id;
    const toolCall = store.getState().monitor.toolCalls.find((c) => c.requestId === request && c.tool === 'inbox_add_comment')!;
    expect(toolCall.response).toMatch(new RegExp(`${allNormal.length} normal .*for all patients`));
    // The monitor saw both agents start before either finished.
    const lifecycle = store.getState().monitor.events.filter((e) => e.requestId === request && (e.type === 'task.accepted' || e.type === 'task.completed')).map((e) => e.type);
    expect(lifecycle.slice(0, 2)).toEqual(['task.accepted', 'task.accepted']);
  }, TIMEOUT);

  it('"comment ok on the normal records" with no Inbox on screen and nobody named: the tool asks whose — it never takes the selected patient by itself', async () => {
    const someone = store.getState().inbox.items.find((i) => i.status === 'Normal')!;
    store.dispatch(setCurrentPatient(someone.patientId));
    await renderAppAt('/dashboard');
    const mine = store.getState().inbox.items.filter((i) => i.patientId === someone.patientId && i.status === 'Normal').map((i) => i.id).sort();
    const llm = new RoutedChat()
      .script('master', { calls: [call('assign_tasks', { tasks: [{ agent: 'inbox', instruction: 'Comment ok on his normal records', execution: 'WRITE' }] })] })
      .script(
        'Inbox',
        { calls: [call('inbox_add_comment', { text: 'ok then', which: 'normal' })] }, // whose? not said in the call
        { calls: [call('inbox_add_comment', { text: 'ok then', which: 'normal', scope: 'selected_patient' })] }, // "his": the selected patient
        { content: 'Added.' },
      );
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true, parallelReads: true });
    await say('comment ok then on his normal records');
    await waitUntil(() => store.getState().voice.taskGraph?.tasks[0]?.status === 'COMPLETED');
    const request = store.getState().monitor.requests[0].id;
    const calls = store.getState().monitor.toolCalls.filter((c) => c.requestId === request && c.tool === 'inbox_add_comment');
    expect(calls.map((c) => c.status)).toEqual(['failed', 'ok']);
    expect(calls[0].error).toMatch(/Whose normal records\?/);
    expect(commented('ok then')).toEqual(mine);
  }, TIMEOUT);
});

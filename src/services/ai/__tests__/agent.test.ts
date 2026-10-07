import { describe, expect, it, vi } from 'vitest';
import { Agent, planCovers } from '../agent/agent';
import { AppRuntime } from '../agent/runtime';
import { buildTools } from '../agent/tools';
import { parseArgs, toToolSchema } from '../agent/tool';
import { SYSTEM_PROMPT } from '../agent/prompt';
import { FieldRegistry } from '@/registry/fieldRegistry';
import { PageRegistry } from '@/registry/pageRegistry';
import type { AIContext, ToolResult } from '@/types/ai';
import { ScriptedLLM, call } from './fakes';

const context: AIContext = {
  today: '2026-09-24 (Thursday)',
  nextDays: 'Fri 2026-09-25, Sat 2026-09-26',
  laterDates: '1 week 2026-10-01',
  now: '10:30',
  providerName: 'Dr. Lucy White',
  currentPageId: 'summary',
  currentPageTitle: 'Summary',
  currentPatientId: 'pat-1',
  currentPatientName: 'Liam Thompson',
  openForm: null,
  pendingQuestion: null,
  pendingConfirmation: null,
  inbox: null,
  patientSearch: null,
  list: null,
  extracted: null,
  carePlan: null,
};

/** A runtime whose actions are spies, so the loop can be tested on its own. */
function makeAgent(llm: ScriptedLLM, overrides: Partial<Record<keyof AppRuntime, unknown>> = {}) {
  const runtime = {
    beginTurn: vi.fn(),
    endTurn: vi.fn(),
    openPage: vi.fn(async (page: string): Promise<ToolResult> => ({ ok: true, message: `Opened ${page}.` })),
    createRecords: vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: 'Medication form ready. Review it, then confirm.', awaitUser: true })),
    patientSummary: vi.fn((): ToolResult => ({ ok: true, message: 'Liam Thompson, 42.', speak: true })),
    listRecords: vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: '2 medications.', data: [{ id: 'med-1', label: 'Metformin' }] })),
    ...overrides,
  } as unknown as AppRuntime;
  const agent = new Agent(llm, runtime, () => context, 6);
  agent.setTools(buildTools());
  return { agent, runtime };
}

describe('tool schemas come from the registries', () => {
  const tools = buildTools();
  const schema = (name: string) => toToolSchema(tools.find((t) => t.name === name)!).function.parameters as Record<string, any>;

  it('every page in the registry is a choice of open_page, and nothing else is', () => {
    expect(schema('open_page').properties.page.enum).toEqual(PageRegistry.all().map((p) => p.id));
  });

  it('record fields and select options are generated, not written out', () => {
    const med = schema('add_medications').properties.medications.items;
    const fields = FieldRegistry.getForm('medication')!.fields.map((f) => f.name);
    expect(Object.keys(med.properties)).toEqual(fields);
    expect(med.properties.frequency.enum).toEqual(FieldRegistry.resolveField('medication', 'frequency')!.options);
    expect(med.properties.startDate.description).toMatch(/YYYY-MM-DD/);
  });

  it('the tool list is identical on every build (so the runtime can cache it)', () => {
    expect(JSON.stringify(buildTools().map(toToolSchema))).toBe(JSON.stringify(tools.map(toToolSchema)));
  });

  it('schemas are inlined — no $ref for a small model to follow', () => {
    expect(JSON.stringify(tools.map(toToolSchema))).not.toContain('$ref');
  });

  it('arguments are validated: options match in any letter case, nulls count as omitted, bad values are explained', () => {
    const add = tools.find((t) => t.name === 'add_medications')!;
    const good = parseArgs(add, { medications: [{ medicationName: 'Aspirin', frequency: 'ONCE DAILY', route: null }] });
    expect(good).toEqual({ ok: true, args: { medications: [{ medicationName: 'Aspirin', frequency: 'Once daily' }] } });
    const bad = parseArgs(add, { medications: [{ medicationName: 'Aspirin', startDate: 'next week' }] });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/startDate: use YYYY-MM-DD/);
  });

  it('the system prompt is static (cacheable): no dates, names or page state in it', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).not.toContain('Liam Thompson');
  });
});

describe('agent loop', () => {
  it('runs the tools the model calls, feeds the results back, and returns the model reply', async () => {
    const llm = new ScriptedLLM().calls([call('list_records', { kind: 'medication' })], 'He takes Metformin.');
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('what medications is he on');
    expect(runtime.listRecords).toHaveBeenCalledWith('medication', undefined, undefined, undefined);
    expect(outcome.reply).toBe('He takes Metformin.');
    expect(llm.lastToolResults()).toEqual([{ name: 'list_records', ok: true, message: '2 medications.', data: [{ id: 'med-1', label: 'Metformin' }] }]);
    // The model saw the CONTEXT block and the utterance.
    expect(llm.requests[0].at(-1)?.content).toMatch(/CONTEXT[\s\S]*selected patient: Liam Thompson[\s\S]*SAID: what medications is he on/);
  });

  it('after an action the model decides whether the request has more parts — here it is done', async () => {
    const llm = new ScriptedLLM().calls([call('open_page', { page: 'dashboard' })], 'Your dashboard is open.');
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('go to my dashboard');
    expect(runtime.openPage).toHaveBeenCalledWith('dashboard');
    expect(llm.requests).toHaveLength(2);
    expect(outcome.reply).toBe('Your dashboard is open.');
  });

  it('a multi-part request is carried out step by step: page, patient, then the form', async () => {
    const llm = new ScriptedLLM().then(
      { calls: [call('open_page', { page: 'patients' })] },
      { calls: [call('select_patient', { patient: 'Harry White' })] },
      { calls: [call('add_tasks', { tasks: [{ title: 'Blood pressure monitoring' }] })] },
    );
    const { agent, runtime } = makeAgent(llm, {
      selectPatient: vi.fn(async () => ({ ok: true, message: 'Harry White is selected; their Summary is open.' })),
      createRecords: vi.fn(async () => ({ ok: true, message: 'The task form is open — confirm to save.', awaitUser: true })),
    });
    const outcome = await agent.run('go to patients and select harry white and create a task for blood pressure monitoring');
    expect(runtime.openPage).toHaveBeenCalledWith('patients');
    expect(runtime.selectPatient).toHaveBeenCalledWith(expect.objectContaining({ patient: 'Harry White' }));
    expect(runtime.createRecords).toHaveBeenCalledWith('task', [{ title: 'Blood pressure monitoring' }], undefined); // no for_patients: the selected patient
    expect(llm.requests).toHaveLength(4); // after the form: the model checks the request is complete
    expect(outcome.awaitingUser).toBe(true);
  });

  it('a batch that mixes an action with a lookup goes back to the model', async () => {
    const llm = new ScriptedLLM().calls([call('open_page', { page: 'summary' }), call('list_records', { kind: 'medication' })], 'Two medications.');
    const { agent } = makeAgent(llm);
    const outcome = await agent.run('open his chart and tell me his meds');
    expect(llm.requests).toHaveLength(2);
    expect(outcome.reply).toBe('Two medications.');
  });

  it('a failed action is never the answer: the model sees the error', async () => {
    const llm = new ScriptedLLM().calls([call('open_page', { page: 'summary' })], 'Please select a patient first.');
    const { agent } = makeAgent(llm, { openPage: vi.fn(async () => ({ ok: false, message: 'No patient is selected.' })) });
    const outcome = await agent.run('open the summary');
    expect(llm.requests).toHaveLength(2);
    expect(outcome.reply).toBe('Please select a patient first.');
  });

  it('a call that keeps giving the same result is a loop: the model is told once, then the turn ends', async () => {
    const search = call('open_page', { page: 'patients' });
    const llm = new ScriptedLLM().then({ calls: [search] }, { calls: [search] }, { calls: [search] }, { calls: [search] }, { content: 'never reached' });
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('find hary wt');
    expect(runtime.openPage).toHaveBeenCalledTimes(3);
    expect(llm.requests[2].at(-1)?.content).toMatch(/Same call, same result as before/);
    expect(outcome.reply).toBe('Opened patients.');
    expect(outcome.speak).toBe(true);
  });

  it('repeating a call whose result changes is progress, not a loop ("next page" twice)', async () => {
    let page = 1;
    const next = call('control_list', { page: 'next' });
    const llm = new ScriptedLLM().then({ calls: [next] }, { calls: [next] }, { calls: [next] }, { content: 'On page 4.' });
    const { agent } = makeAgent(llm, { controlList: vi.fn(async () => ({ ok: true, message: `Page ${++page}.` })) });
    expect((await agent.run('three pages forward')).reply).toBe('On page 4.');
  });

  it('invalid arguments go back to the model as an error it can correct — nothing runs', async () => {
    const llm = new ScriptedLLM().then({ calls: [call('open_page', { page: 'the moon' })] }, { calls: [call('open_page', { page: 'patients' })] }, { content: 'The patient list is open.' });
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('show patients');
    expect(runtime.openPage).toHaveBeenCalledTimes(1);
    expect(runtime.openPage).toHaveBeenCalledWith('patients');
    const firstResults = llm.requests[1].filter((m) => m.role === 'tool');
    expect(firstResults[0].content).toMatch(/Invalid arguments for open_page/);
    expect(outcome.reply).toBe('The patient list is open.');
  });

  it('an unknown tool is reported back, not crashed on', async () => {
    const llm = new ScriptedLLM().calls([call('launch_rockets')], 'Sorry, I cannot do that.');
    const { agent } = makeAgent(llm);
    await agent.run('launch');
    expect(llm.lastToolResults()[0].message).toMatch(/There is no tool "launch_rockets"/);
  });

  it('a question or confirmation does not drop the rest of the request — it is asked once the rest is done', async () => {
    const llm = new ScriptedLLM().then(
      { calls: [call('add_medications', { medications: [{ medicationName: 'Aspirin' }] })] },
      { calls: [call('open_page', { page: 'dashboard' })] },
      { content: 'Done.' },
    );
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('add aspirin and open my dashboard');
    expect(runtime.openPage).toHaveBeenCalledWith('dashboard'); // not lost because the form asked something
    expect(outcome.awaitingUser).toBe(true);
    expect(outcome.reply).toMatch(/Review it, then confirm/); // the reply is what the provider must answer
    expect(outcome.speak).toBe(true);
  });

  it('several tools in one turn run in order', async () => {
    const order: string[] = [];
    const llm = new ScriptedLLM().calls([call('open_page', { page: 'summary' }), call('list_records', { kind: 'medication' })], 'He takes Metformin.');
    const { agent } = makeAgent(llm, {
      openPage: vi.fn(async () => (order.push('open'), { ok: true, message: 'ok' })),
      listRecords: vi.fn(async () => (order.push('list'), { ok: true, message: 'ok', data: [] })),
    });
    await agent.run('open his chart and tell me his meds');
    expect(order).toEqual(['open', 'list']);
  });

  it('an unfinished fragment is deferred: nothing runs', async () => {
    const llm = new ScriptedLLM().then({ calls: [call('wait_for_more_speech')] });
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('and then I want to');
    expect(outcome.deferred).toBe(true);
    expect(runtime.openPage).not.toHaveBeenCalled();
  });

  it('stops after maxSteps model calls', async () => {
    const llm = new ScriptedLLM();
    for (let i = 0; i < 10; i++) llm.then({ calls: [call('list_records', { kind: 'task' })] });
    // Each result differs, so the loop guard does not step in: only maxSteps ends it.
    let n = 0;
    const { agent } = makeAgent(llm, { listRecords: vi.fn(async () => ({ ok: true, message: `${++n} tasks.` })) });
    const outcome = await agent.run('loop forever');
    expect(llm.requests).toHaveLength(6);
    expect(outcome.reply).toBe('6 tasks.');
  });

  it('gives the model the second recogniser\'s version when it differs — and not when it says the same', async () => {
    const llm = new ScriptedLLM().then({ content: 'Selected.' }, { content: 'Done.' });
    const { agent } = makeAgent(llm);
    await agent.run('select patient hairy why it', {}, undefined, 'Select patient Harry White.');
    expect(llm.requests[0].at(-1)?.content).toMatch(/SAID: select patient hairy why it\nALSO HEARD: Select patient Harry White\.$/);
    await agent.run('go to patients', {}, undefined, 'Go to patients.');
    expect(llm.requests[1].at(-1)?.content).toMatch(/SAID: go to patients$/);
  });

  it('remembers recent exchanges inside CONTEXT, so follow-ups make sense and the prompt keeps its shape', async () => {
    const llm = new ScriptedLLM().then({ content: 'Hello!' }, { content: 'Yes.' });
    const { agent } = makeAgent(llm);
    await agent.run('hello');
    await agent.run('are you there');
    const [first, second] = llm.requests;
    // Same layout every time: system, the day's SESSION exchange, then this utterance.
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(second.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(second[1].content).toMatch(/^SESSION\ntoday: /);
    expect(second[3].content).toMatch(/earlier: "hello" → Hello!\n\nSAID: are you there$/);
  });

  it('extracts a clinical note through record_note_findings, retrying when the model does not call it', async () => {
    const llm = new ScriptedLLM().then(
      { content: 'Sure, here you go.' },
      {
        calls: [
          call('record_note_findings', {
            medications: [{ medicationName: 'Amlodipine', dosage: '5 mg', frequency: 'once daily', quote: 'start amlodipine 5 mg once daily' }],
            diagnoses: [{ description: 'Hypertension', status: 'Active' }],
            questions: ['Which pharmacy?'],
          }),
        ],
      },
    );
    const { agent } = makeAgent(llm);
    const result = await agent.extractNote('BP high, start amlodipine 5 mg once daily, hypertension.');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0].at(-1)?.content).toMatch(/TASK: EXTRACT/);
    expect(result.items.medication).toEqual([{ fields: { medicationName: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily' }, quote: 'start amlodipine 5 mg once daily' }]);
    expect(result.items.diagnosis[0].fields.description).toBe('Hypertension');
    expect(result.questions).toEqual(['Which pharmacy?']);
  });
});

describe('long requests are split into steps first', () => {
  const LONG = 'Go to patients, select Harry White, add metformin 500 mg twice daily, create a task for blood pressure monitoring and book a follow-up next Tuesday';
  const STEPS = ['Go to patients', 'Select Harry White', 'Add metformin 500 mg twice daily', 'Create a task for blood pressure monitoring', 'Book a follow-up next Tuesday'];
  const planning = (llm: ScriptedLLM, overrides: Partial<Record<keyof AppRuntime, unknown>> = {}) => {
    const { runtime } = makeAgent(llm, overrides);
    const agent = new Agent(llm, runtime, () => context, 6, true);
    agent.setTools(buildTools());
    return { agent, runtime };
  };
  const said = (messages: { role: string; content?: string }[]) => String(messages.at(-1)?.content ?? '');

  it('done in one go (a model that does not plan), a long request still shows its steps — from its tools, no extra call', async () => {
    const llm = new ScriptedLLM()
      .then({ calls: [call('open_page', { page: 'dashboard' })] })
      .then({ calls: [call('add_medications', { medications: [{ medicationName: 'Metformin' }] }), call('open_page', { page: 'no-such-page' })] })
      .then({ content: 'Ready to confirm.' });
    const { agent } = makeAgent(llm); // planning off
    const shown: Array<Array<{ text: string; status: string }>> = [];
    await agent.run(LONG, { onPlan: (steps) => shown.push(steps) });
    expect(llm.requests.some((m) => said(m).includes('TASK: PLAN'))).toBe(false);
    // Each call a step in its tool's words; the refused call (an unknown page) is not one.
    expect(shown.at(-1)).toEqual([
      { text: 'Opening Dashboard', status: 'done' },
      { text: 'Opening the medication form', status: 'waiting' },
    ]);
  });

  it('a short request done in one go shows no steps', async () => {
    const llm = new ScriptedLLM().calls([call('open_page', { page: 'dashboard' })], 'Opened.');
    const { agent } = makeAgent(llm);
    const shown: unknown[] = [];
    await agent.run('open the dashboard', { onPlan: (steps) => shown.push(steps) });
    expect(shown).toEqual([]);
  });

  it('a short request goes straight to the tools — no planning call', async () => {
    const llm = new ScriptedLLM().calls([call('open_page', { page: 'dashboard' })], 'Opened.');
    const { agent } = planning(llm);
    await agent.run('open the dashboard');
    expect(said(llm.requests[0])).not.toContain('TASK: PLAN');
  });

  it('plans, then does each step in turn with its own CONTEXT — one turn for all of them', async () => {
    const llm = new ScriptedLLM().then({ calls: [call('plan_steps', { steps: STEPS })] });
    for (let i = 0; i < STEPS.length; i++) llm.calls([call('open_page', { page: 'dashboard' })], `Step ${i + 1} done.`);
    const { agent, runtime } = planning(llm);
    const progress: string[][] = [];
    const outcome = await agent.run(LONG, { onPlan: (steps) => progress.push(steps.map((s) => s.status)) });

    expect(said(llm.requests[0])).toContain('TASK: PLAN');
    const stepRequests = llm.requests.filter((m) => said(m).includes('request: step'));
    expect(stepRequests.map((m) => said(m).match(/SAID: (.*)/)?.[1])).toEqual(STEPS);
    expect(said(stepRequests[2])).toContain('request: step 3 of 5');
    // Earlier steps show in CONTEXT, so the model knows what is already done.
    expect(said(stepRequests[1])).toContain('earlier: "Go to patients"');
    expect(runtime.beginTurn).toHaveBeenCalledTimes(1);
    expect(runtime.beginTurn).toHaveBeenCalledWith(expect.any(Number), LONG);
    expect(progress.at(-1)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(progress[0]).toEqual(['running', 'pending', 'pending', 'pending', 'pending']);
    expect(outcome.reply).toBe('Step 1 done. Step 2 done. Step 3 done. Step 4 done. Step 5 done.');
  });

  it('a plan that lost part of the request is not used — the request runs in one go', async () => {
    const llm = new ScriptedLLM().then({ calls: [call('plan_steps', { steps: ['Go to patients', 'Select Harry White'] })] });
    llm.calls([call('open_page', { page: 'dashboard' })], 'Done in one go.');
    const { agent } = planning(llm);
    const outcome = await agent.run(LONG);
    expect(said(llm.requests[1])).toContain(`SAID: ${LONG}`);
    expect(said(llm.requests[1])).not.toContain('request: step');
    expect(outcome.reply).toBe('Done in one go.');
  });

  it('one step, or no plan at all, also runs in one go', async () => {
    for (const first of [{ calls: [call('plan_steps', { steps: [LONG] })] }, { content: 'Sure.' }]) {
      const llm = new ScriptedLLM().then(first);
      llm.calls([call('open_page', { page: 'dashboard' })], 'Done in one go.');
      const { agent } = planning(llm);
      expect((await agent.run(LONG)).reply).toBe('Done in one go.');
      expect(said(llm.requests[1])).toContain(`SAID: ${LONG}`);
    }
  });

  it('a confirmation prepared by a step is the reply at the end, after the remaining steps are done', async () => {
    const llm = new ScriptedLLM().then({ calls: [call('plan_steps', { steps: STEPS })] });
    for (let i = 0; i < STEPS.length; i++) llm.calls([call(i === 2 ? 'add_medications' : 'open_page', i === 2 ? { medications: [{ medicationName: 'Metformin' }] } : { page: 'dashboard' })], `Step ${i + 1} done.`);
    let confirmation = false;
    const runtime = {
      beginTurn: vi.fn(),
      endTurn: vi.fn(),
      openPage: vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: 'Opened.' })),
      createRecords: vi.fn(async (): Promise<ToolResult> => {
        confirmation = true;
        return { ok: true, message: 'Medication form ready. Review it, then confirm.', awaitUser: true };
      }),
    } as unknown as AppRuntime;
    const planned = new Agent(llm, runtime, () => ({ ...context, pendingConfirmation: confirmation ? { kind: 'form', description: 'Save the medication' } : null }), 6, true);
    planned.setTools(buildTools());
    const steps: string[][] = [];
    const outcome = await planned.run(LONG, { onPlan: (s) => steps.push(s.map((x) => x.status)) });
    expect(runtime.openPage).toHaveBeenCalledTimes(4); // the steps after the confirmation still ran
    expect(outcome.awaitingUser).toBe(true);
    expect(outcome.reply).toBe('Medication form ready. Review it, then confirm.');
    expect(steps.at(-1)).toEqual(['done', 'done', 'waiting', 'done', 'done']);
  });

  it('planCovers: nearly every word said must be in the steps', () => {
    expect(planCovers(STEPS, LONG)).toBe(true);
    expect(planCovers(STEPS.slice(0, 3), LONG)).toBe(false);
  });
});

describe('the model stalls — cut off, empty, or only announcing — and is told once to carry it out', () => {
  const said = (m: { content?: string }[]) => String(m.at(-1)?.content ?? '');

  it('an answer cut off at the output limit (its tool call lost) is asked for again, shorter', async () => {
    const llm = new ScriptedLLM();
    const chat = llm.chat.bind(llm);
    let first = true;
    llm.chat = async (...args: Parameters<typeof chat>) => {
      const turn = await chat(...args);
      if (first) {
        first = false;
        return { ...turn, content: '', toolCalls: [], truncated: true };
      }
      return turn;
    };
    llm.then({ content: '' }).calls([call('open_page', { page: 'dashboard' })], 'Opened.');
    const { agent, runtime } = makeAgent(llm);
    const outcome = await agent.run('open the dashboard');
    expect(said(llm.requests[1])).toMatch(/cut off before the tool call was complete/);
    expect(runtime.openPage).toHaveBeenCalled();
    expect(outcome.reply).toBe('Opened.');
  });

  it('"Let me correct this:" after a failed call is not the answer — the model is told to do it', async () => {
    const llm = new ScriptedLLM().then(
      { calls: [call('add_medications', { medications: [{ medicationName: 'Panadol' }] })] },
      { content: 'I need to add the medication names properly. Let me correct this:' },
      { calls: [call('open_page', { page: 'dashboard' })] },
      { content: 'Opened the dashboard.', followUp: true },
    );
    const { agent } = makeAgent(llm, { createRecords: vi.fn(async (): Promise<ToolResult> => ({ ok: false, message: 'Nothing was added.' })) });
    const outcome = await agent.run('add panadol');
    expect(said(llm.requests[2])).toMatch(/^Do it now: call the tool/);
    expect(outcome.reply).toBe('Opened the dashboard.');
  });

  it('an empty answer with nothing done is retried once, then said plainly — never "Done."', async () => {
    const llm = new ScriptedLLM().then({ content: '' }, { content: '' });
    const { agent } = makeAgent(llm);
    const outcome = await agent.run('add the following medications to each of the four patients');
    expect(llm.requests).toHaveLength(2);
    expect(outcome.reply).toMatch(/couldn't carry that out — nothing was changed/);
  });

  it('a confirmation may be said in the model’s own words; a question from the app is kept as asked', async () => {
    const confirm = new ScriptedLLM().then({ calls: [call('add_medications', { medications: [{ medicationName: 'Metformin' }] })] }, { content: 'Metformin for James is ready — please review and confirm.', followUp: true });
    expect((await makeAgent(confirm).agent.run('add metformin')).reply).toBe('Metformin for James is ready — please review and confirm.');
    const question = new ScriptedLLM().then({ calls: [call('add_medications', { medications: [{ medicationName: 'Metformin' }] })] }, { content: 'I opened the form.', followUp: true });
    const asking = makeAgent(question, { createRecords: vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: 'What dosage for Metformin?', awaitUser: true })) });
    expect((await asking.agent.run('add metformin')).reply).toBe('What dosage for Metformin?');
  });
});

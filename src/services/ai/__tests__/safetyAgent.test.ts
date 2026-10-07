/**
 * The Safety Agent at the tool call: values the provider did not say never reach the application — they are
 * removed (the app asks for them), corrected from what was said, or, when the record itself was made up,
 * the provider is asked with a fixed question instead.
 */
import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import type { ToolCall } from '@/types/ai';
import { SafetyAgent, type SafetyContext } from '../safety/safetyAgent';
import { questionFor } from '../safety/requirements';
import { needsReview, SafetyReviewer } from '../safety/reviewer';
import type { ChatLLM } from '../providers/llm';

function safety(said: string[], extra: Partial<SafetyContext> = {}) {
  let discarded = 0;
  const ctx: SafetyContext = {
    utterances: () => said,
    today: () => dayjs('2026-10-01'),
    providerName: () => 'Dr. Lucy White',
    providers: () => ['Dr. Lucy White', 'Dr. Omar Khan'],
    selectedPatient: () => ({ id: 'p3', name: 'Harry White' }),
    patients: () => [
      { id: 'p1', fullName: 'James Ahmed', mrn: 'MRN1001' },
      { id: 'p2', fullName: 'James Lee', mrn: 'MRN1002' },
      { id: 'p3', fullName: 'Harry White', mrn: 'MRN1003' },
    ],
    known: (kind) => (kind === 'diagnosis' ? ['Essential (primary) hypertension', 'Type 2 diabetes mellitus'] : ['Metformin', 'Amlodipine']),
    recordLabel: (_kind, id) => (id === 'med-1' ? 'Metformin' : undefined),
    openFormId: () => null,
    staged: () => [],
    discardStaged: () => {
      discarded += 1;
    },
    ...extra,
  };
  return { agent: new SafetyAgent(ctx), discarded: () => discarded };
}
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ name, arguments: args });
/** On Summary (or with a form open): an incomplete record opens in place and the form asks. */
const inPlace = { inPlace: () => true };

describe('the Safety Agent at the tool call', () => {
  it('"add medication and add diagnosis" — the model filled Panadol 500 mg twice daily and Hypertension: nothing of it runs; the provider is asked', () => {
    const { agent } = safety(['add medication and add diagnosis']);
    const verdict = agent.check(
      call('add_care_plan', {
        medications: [{ medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily', duration: '5 days' }],
        diagnoses: [{ description: 'Hypertension' }],
      }),
    );
    expect(verdict.kind).toBe('ask');
    if (verdict.kind !== 'ask') return;
    expect(verdict.result).toMatchObject({ ok: false, awaitUser: true, final: true });
    expect(verdict.result.message).toBe('What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
    expect(verdict.findings.map((f) => [f.field, f.value, f.action])).toEqual([
      ['medication 1 · medicationName', 'Panadol', 'asked'],
      ['medication 1 · dosage', '500 mg', 'asked'],
      ['medication 1 · frequency', 'Twice daily', 'asked'],
      ['medication 1 · duration', '5 days', 'asked'],
      ['diagnosis 1 · description', 'Hypertension', 'asked'],
    ]);
  });

  it('Issue 1 — on Configuration, no patient selected: nothing opens; everything missing is asked at once, the route too', () => {
    const { agent } = safety(['add medication and add diagnoses'], { selectedPatient: () => null });
    const verdict = agent.check(call('add_care_plan', { medications: [{ medicationName: 'Medication' }], diagnoses: [{ description: 'Diagnoses' }] }));
    expect(verdict.kind).toBe('ask');
    if (verdict.kind !== 'ask') return;
    // "medication" is the kind of record, never a drug's name — even though the word was said.
    expect(verdict.result.message).toBe('Which patient should these records be added to? What medication would you like to add? Please also tell me the dose and how often it should be taken. Which diagnosis would you like to add?');
  });

  it('the route is never required: none said goes through (the form\'s Oral); said once ("by mouth"), it goes on', () => {
    expect(safety(['add metformin 500 mg twice a day']).agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] })).kind).toBe('allow');
    expect(safety(['add metformin 500 mg twice a day']).agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', route: 'Oral' }] })).kind).toBe('allow'); // the app's own default
    const said = safety(['add metformin 500 mg by mouth twice a day']).agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] }));
    expect(said).toMatchObject({ kind: 'rewrite', args: { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', route: 'Oral' }] } });
  });

  it('what was said goes through untouched — the full request, word for word', () => {
    const { agent } = safety(['add panadol five hundred milligrams by mouth twice a day for five days and a diagnosis of hypertension']);
    const verdict = agent.check(
      call('add_care_plan', {
        medications: [{ medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily', duration: '5 days', route: 'Oral' }],
        diagnoses: [{ description: 'Hypertension' }],
      }),
    );
    expect(verdict).toEqual({ kind: 'allow', findings: [] });
  });

  it('a drug said with nothing else: its name goes on, the made-up dose and frequency are removed — the app asks for them', () => {
    const { agent } = safety(['add metformin'], inPlace);
    const verdict = agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] }));
    expect(verdict.kind).toBe('rewrite');
    if (verdict.kind !== 'rewrite') return;
    expect(verdict.args.medications).toEqual([{ medicationName: 'Metformin' }]);
    expect(agent.note(verdict.findings)).toMatch(/removed .*dosage "500 mg".*frequency "Twice daily".*Never fill them in yourself/);
    // Anywhere else (Dashboard, Patients, Configuration …) nothing opens: all of it is asked first.
    const away = safety(['add metformin']).agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily' }] }));
    expect(away.kind).toBe('ask');
    if (away.kind === 'ask') expect(away.result.message).toBe('I have the medication as Metformin. Please provide the missing information: dose and frequency.');
  });

  it('corrects from the provider\'s words — one frequency said, another given', () => {
    const { agent } = safety(['metformin 500 mg orally twice a day']);
    const verdict = agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Once daily' }] }));
    expect(verdict.kind).toBe('rewrite');
    if (verdict.kind !== 'rewrite') return;
    expect(verdict.args.medications).toEqual([{ medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', route: 'Oral' }]);
    expect(verdict.findings[0]).toMatchObject({ action: 'corrected', corrected: 'Twice daily' });
  });

  it('"go to patients and select patient" — no patient said: never one picked; the provider is asked which', () => {
    const { agent } = safety(['go to patients and select patient']);
    for (const args of [{ patient: 'James Ahmed' }, { list_position: 1 }, {}]) {
      const verdict = agent.check(call('select_patient', args));
      expect(verdict.kind).toBe('ask');
      if (verdict.kind === 'ask') expect(verdict.result.message).toBe('Which patient would you like to select?');
    }
    // Said: selected as said. Part of the name said: only that part goes on (the app finds who, or asks).
    expect(safety(['select james ahmed']).agent.check(call('select_patient', { patient: 'James Ahmed' })).kind).toBe('allow');
    const partial = safety(['select james']).agent.check(call('select_patient', { patient: 'James Ahmed' }));
    expect(partial).toMatchObject({ kind: 'rewrite', args: { patient: 'james' } });
    expect(safety(['select the second one']).agent.check(call('select_patient', { list_position: 2 })).kind).toBe('allow');
  });

  it('"it", "him", "that one" point back to what the provider named a moment ago — "select the patient" does not', () => {
    const recent = { recent: () => ['select james ahmed', 'delete the dictated condition'] };
    expect(safety(['select him again'], recent).agent.check(call('select_patient', { patient: 'James Ahmed' })).kind).toBe('allow');
    expect(safety(['delete it'], { ...recent, recordLabel: () => undefined }).agent.check(call('delete_record', { kind: 'diagnosis', record: 'Dictated Condition' })).kind).toBe('allow');
    // No pointing back ("the" is not "he"): the patient must be said now — never taken from before.
    expect(safety(['select the patient'], recent).agent.check(call('select_patient', { patient: 'James Ahmed' })).kind).toBe('ask');
    // A new value is never taken from before, pointing back or not.
    expect(safety(['add it again'], { recent: () => ['add metformin 500 mg'] }).agent.check(call('add_medications', { medications: [{ medicationName: 'Metformin', dosage: '500 mg' }] })).kind).toBe('ask');
  });

  it('dates, times and the appointment\'s reason must come from the words', () => {
    const said = ['book a follow up next tuesday at 3 pm'];
    expect(safety(said).agent.check(call('add_appointments', { appointments: [{ date: '2026-10-06', startTime: '15:00', reason: 'Follow-up' }] })).kind).toBe('allow');
    // On Summary: the wrong date and time are removed — and as the provider DID say them, the call goes back to
    // the agent once to take them from the words; the second time it opens without them (the form asks).
    const onSummary = safety(said, inPlace).agent;
    const wrongOnSummary = call('add_appointments', { appointments: [{ date: '2026-10-07', startTime: '10:00', reason: 'Follow-up' }] });
    // The day the provider said, worked out wrong by the model ("next tuesday" as a Wednesday): corrected to it.
    const firstOnSummary = onSummary.check(wrongOnSummary);
    expect(firstOnSummary.kind).toBe('refuse');
    expect(firstOnSummary.findings).toContainEqual(expect.objectContaining({ field: 'appointment 1 · date', action: 'corrected', corrected: '2026-10-06' }));
    expect(onSummary.check(wrongOnSummary)).toMatchObject({ kind: 'rewrite', args: { appointments: [{ date: '2026-10-06', reason: 'Follow-up' }] } });
    // Away from Summary: the provider DID say a date and a time — the agent got them wrong. It gets the call back
    // once to take them from the words; only if it fails again is the provider asked.
    const away = safety(said).agent;
    const wrongCall = call('add_appointments', { appointments: [{ date: '2026-10-07', startTime: '10:00', reason: 'Follow-up' }] });
    const first = away.check(wrongCall);
    expect(first.kind).toBe('refuse');
    if (first.kind === 'refuse') expect(first.result.message).toMatch(/^Not run — this call leaves out what the provider said: appointment: startTime\./);
    expect(away.check(wrongCall).kind).toBe('ask');
    // A recall "in two weeks" with no reason said: the date goes on, the made-up reason does not — the app asks for it.
    const recall = safety(['recall him in two weeks'], inPlace).agent.check(call('add_recalls', { recalls: [{ reason: 'Blood pressure review', dueDate: '2026-10-15' }] }));
    expect(recall).toMatchObject({ kind: 'rewrite', args: { recalls: [{ dueDate: '2026-10-15' }] } });
  });

  it('a change or a delete names a record the provider named — not one the model chose', () => {
    expect(safety(['stop the metformin']).agent.check(call('update_record', { kind: 'medication', record: 'med-1', changes: { status: 'Discontinued' } })).kind).toBe('allow');
    const chosen = safety(['delete the medication']).agent.check(call('delete_record', { kind: 'medication', record: 'med-1' }));
    expect(chosen.kind).toBe('ask');
    if (chosen.kind === 'ask') expect(chosen.result.message).toBe('Which medication would you like to delete?');
  });

  it('a diagnosis by the application\'s own name for it, its key word said', () => {
    expect(safety(['add hypertension']).agent.check(call('add_diagnoses', { diagnoses: [{ description: 'Essential (primary) hypertension' }] })).kind).toBe('allow');
    expect(safety(['add a diagnosis']).agent.check(call('add_diagnoses', { diagnoses: [{ description: 'Essential (primary) hypertension' }] })).kind).toBe('ask');
  });

  it('after the tool: a new record on screen holding a value nobody said is closed unconfirmed, and the provider asked', () => {
    let staged = [{ kind: 'medication', values: { medicationName: 'Metformin', dosage: '500 mg', frequency: 'Twice daily', route: 'Oral' } as Record<string, unknown> }];
    const s = safety(['add metformin 500 mg'], { staged: () => staged });
    const verdict = s.agent.after(call('add_medications', {}), { ok: true, message: 'Ready to confirm.', awaitUser: true });
    expect(verdict?.kind).toBe('ask');
    expect(s.discarded()).toBe(1);
    if (verdict?.kind === 'ask') expect(verdict.result.message).toBe('How often should Metformin be taken?');
    staged = [{ kind: 'medication', values: { medicationName: 'Metformin', dosage: '500 mg', route: 'Oral' } }];
    expect(s.agent.after(call('add_medications', {}), { ok: true, message: 'What is the frequency?', awaitUser: true })).toBeNull();
  });

  it('nothing from the provider\'s words (a button, the screen): nothing to check', () => {
    expect(safety([]).agent.check(call('add_medications', { medications: [{ medicationName: 'Panadol' }] })).kind).toBe('allow');
  });
});

describe('the questions are fixed, never a suggestion', () => {
  it('asks for exactly what is missing', () => {
    expect(questionFor([{ kind: 'select_patient' }])).toBe('Which patient would you like to select?');
    expect(questionFor([{ kind: 'medication', name: 'Metformin', fields: ['dosage'] }])).toBe('What dose should be prescribed for Metformin?');
    expect(questionFor([{ kind: 'medication', name: 'Metformin', fields: ['dosage', 'frequency'] }])).toBe('I have the medication as Metformin. Please provide the missing information: dose and frequency.');
    expect(questionFor([{ kind: 'appointment', fields: ['date', 'startTime'] }])).toBe('What date and time should the appointment be scheduled for?');
  });
});

describe("the Safety Agent's model — a second look at risky calls", () => {
  /** A model that reports what it is given, and remembers being asked. */
  const reviewing = (report: Record<string, unknown> | Error) => {
    const seen: string[] = [];
    const llm: ChatLLM = {
      name: 'fake:reviewer',
      async chat(messages) {
        seen.push(String(messages[1].content));
        if (report instanceof Error) throw report;
        return { content: '', toolCalls: [{ name: 'report_review', arguments: report }] };
      },
    };
    return { reviewer: new SafetyReviewer(llm), seen };
  };
  const meds = (said: string[], args: Record<string, unknown>) => ({ said, call: call('add_medications', args) });

  it('only where the words turn something around ("not …", "instead …") — a complete request is never second-guessed', () => {
    expect(needsReview(call('add_medications', { medications: [{ medicationName: 'Metformin' }] }), ['add metformin'])).toBe(false);
    // Several records, several patients, a change: the rules check them — the model's second look only asked
    // the provider what they had already said ("I want to be sure … you said Tom Baker").
    expect(needsReview(call('add_medications', { medications: [{ medicationName: 'Metformin' }, { medicationName: 'Amlodipine' }] }), ['add metformin and amlodipine'])).toBe(false);
    expect(needsReview(call('delete_record', { kind: 'medication', record: 'med-1' }), ['delete the metformin'])).toBe(false);
    expect(needsReview(call('add_medications', { medications: [{ medicationName: 'Amlodipine' }] }), ['not metformin, add amlodipine'])).toBe(true);
    expect(needsReview(call('get_provider_overview', {}), ['not today'])).toBe(false);
  });

  it('a "problem" stands only when the call holds what the provider turned away', async () => {
    const { reviewer } = reviewing({ ok: false, problems: [{ field: 'patient', quote: 'Do not change anything for the other patients', issue: 'other patients' }] });
    const { agent } = safety(['For Luke King add Panadol 500 mg twice daily. Do not change anything for the other patients.']);
    agent.setReviewer(reviewer);
    expect(await agent.review(call('add_medications', { medications: [{ medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily', patient: 'Luke King' }] }))).toBeNull();
  });

  it('a mismatch quoting the provider\'s words stops the call and asks — it never changes a value', async () => {
    const { reviewer, seen } = reviewing({ ok: false, problems: [{ field: 'medication 1 · medicationName', quote: 'not metformin', issue: 'metformin was excluded' }] });
    const { agent } = safety(['not metformin, add amlodipine 5 mg by mouth once daily']);
    agent.setReviewer(reviewer);
    const { call: c } = meds([], { medications: [{ medicationName: 'Metformin', dosage: '5 mg', route: 'Oral', frequency: 'Once daily' }] });
    const verdict = await agent.review(c);
    expect(seen[0]).toContain('CALL: add_medications');
    expect(verdict?.kind).toBe('ask');
    expect(verdict?.result).toMatchObject({ ok: false, awaitUser: true });
    expect(verdict?.result.message).toBe('Just to make sure I get this right: you said "not metformin". Could you tell me what the medication name should be?');
    expect(verdict?.findings[0]).toMatchObject({ action: 'asked', field: 'medication 1 · medicationName' });
  });

  it('a "problem" that does not quote what was said is the model\'s, not the provider\'s — ignored', async () => {
    const { reviewer } = reviewing({ ok: false, problems: [{ field: 'dosage', quote: 'take 10 mg', issue: 'should be 10 mg' }] });
    const { agent } = safety(['add metformin and amlodipine 5 mg by mouth once daily']);
    agent.setReviewer(reviewer);
    expect(await agent.review(call('add_medications', { medications: [{ medicationName: 'Metformin' }, { medicationName: 'Amlodipine' }] }))).toBeNull();
  });

  it('a reviewer that fails lets the call through — the rules have already checked it', async () => {
    const { reviewer } = reviewing(new Error('connection refused'));
    const reviews: string[] = [];
    const { agent } = safety(['not aspirin — add metformin and amlodipine'], { reviewed: (_c, o) => reviews.push(o === 'started' ? 'started' : o.status) });
    agent.setReviewer(reviewer);
    expect(await agent.review(call('add_medications', { medications: [{ medicationName: 'Metformin' }, { medicationName: 'Amlodipine' }] }))).toBeNull();
    expect(reviews).toEqual(['started', 'skipped']);
  });
});

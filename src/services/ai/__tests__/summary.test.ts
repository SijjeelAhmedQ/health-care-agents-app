/**
 * The Summary Agent: WHAT a summary is of is read from the words by code (no tool, no model choosing), the
 * facts are gathered from the records, and a model's answer is cleaned — or the text written from the facts.
 */
import { describe, expect, it } from 'vitest';
import type { ChatLLM } from '../providers/llm';
import { detectTarget, type TargetContext } from '../summary/summaryTarget';
import { collectFacts, ruleSummary, type SummarySource } from '../summary/summaryFacts';
import { cleanSummary, summaryMessages, unsupportedUrgency, unusable, writeSummary } from '../summary/summaryWriter';
import type { InboxItem } from '@/services/inbox/inboxModel';
import type { Patient } from '@/types/domain';

const ctx = (over: Partial<TargetContext> = {}): TargetContext => ({
  pageId: 'dashboard',
  selectedPatientId: 'p1',
  patients: [
    { id: 'p1', fullName: 'Tom Baker' },
    { id: 'p2', fullName: 'Chloe Bell' },
  ],
  ...over,
});

describe('what a summary is of — from the words', () => {
  it.each([
    ['Summarize all inbox normal records', { kind: 'inbox', category: 'all', status: 'normal', file: 'all', attention: false, patientId: undefined }],
    ['summary of the abnormal labs', { kind: 'inbox', category: 'lab', status: 'abnormal' }],
    ["summarize Chloe Bell's unfiled radiology", { kind: 'inbox', category: 'radiology', file: 'unfiled', patientId: 'p2' }],
    ["summarize every patient's referrals", { kind: 'inbox', category: 'referral', patientId: undefined }],
    ['summarize his discharge summaries', { kind: 'inbox', category: 'discharge', patientId: 'p1' }],
    ['give me a summary of my day', { kind: 'dashboard' }],
    ['dashboard summary', { kind: 'dashboard' }],
    ['summarize my appointments', { kind: 'schedule' }],
    ['summarize his medications', { kind: 'patient', patientId: 'p1', records: 'medication' }],
    ["summary of Chloe Bell's diagnoses", { kind: 'patient', patientId: 'p2', records: 'diagnosis' }],
    ['summarize Chloe Bell', { kind: 'patient', patientId: 'p2' }],
    ['summarize the patients page', { kind: 'patients' }],
    ['summarize the AI configuration', { kind: 'configuration' }],
  ])('"%s"', (said, expected) => {
    expect(detectTarget(said, ctx())).toMatchObject(expected);
  });

  it('normal / abnormal / unfiled records are the Inbox’s — never the page on screen (Configuration)', () => {
    const onConfiguration = ctx({ pageId: 'configuration' });
    expect(detectTarget('Summarize all abnormal records', onConfiguration)).toMatchObject({ kind: 'inbox', category: 'all', status: 'abnormal' });
    expect(detectTarget('Open all abnormal records summary', onConfiguration)).toMatchObject({ kind: 'inbox', status: 'abnormal' });
    expect(detectTarget('summary of the unfiled records', onConfiguration)).toMatchObject({ kind: 'inbox', file: 'unfiled' });
  });

  it('the task’s words first, then what the provider said — the page on screen only when neither names anything', () => {
    const onConfiguration = ctx({ pageId: 'configuration' });
    // The master's task lost "inbox": the provider's own words still say it.
    expect(detectTarget(['Summarize the records', 'Go to inbox and open all abnormal records summary'], onConfiguration)).toMatchObject({ kind: 'inbox', status: 'abnormal' });
    expect(detectTarget(['Summarize', 'summarize'], onConfiguration)).toEqual({ kind: 'configuration' }); // nothing named: this page
  });

  it('"this page" — whatever is on screen: an Inbox tab, a Summary tab, My Appointments', () => {
    expect(detectTarget('summarize this page', ctx({ pageId: 'inbox-lab' }))).toMatchObject({ kind: 'inbox', category: 'lab', status: 'all' });
    expect(detectTarget('summarize this tab', ctx({ pageId: 'summary-recall' }))).toMatchObject({ kind: 'patient', patientId: 'p1', records: 'recall' });
    expect(detectTarget('summary of this screen', ctx({ pageId: 'my-appointments' }))).toEqual({ kind: 'schedule' });
    expect(detectTarget('summarize', ctx({ pageId: 'patients' }))).toEqual({ kind: 'patients' });
  });
});

const patient = (id: string, fullName: string): Patient => ({ id, fullName, age: 50, gender: 'Male', mrn: `MRN-${id}`, status: 'Active', primaryProviderName: 'Dr. Lucy White' }) as unknown as Patient;
const item = (over: Partial<InboxItem>): InboxItem =>
  ({ id: 'lab:1', category: 'lab', sourceId: '1', subject: 'Lipid panel', patientId: 'p1', patientName: 'Tom Baker', from: 'Lab', receivedAt: '2026-10-01T09:00:00Z', status: 'Normal', statusTone: 'success', sourceStatus: 'Final', attention: false, preview: '', meta: [], ...over }) as InboxItem;
const source = (inbox: InboxItem[], filed: string[] = []): SummarySource => ({
  patients: [patient('p1', 'Tom Baker'), patient('p2', 'Chloe Bell')],
  selectedPatientId: null,
  records: () => [],
  workload: () => null,
  inbox,
  filedIds: filed,
  providerAppointments: () => [],
});

describe('the facts, from the records', () => {
  const inbox = [
    item({ id: 'lab:1', subject: 'Lipid panel', status: 'Normal' }),
    item({ id: 'lab:2', subject: 'HbA1c', status: 'Abnormal', statusTone: 'danger', attention: true, attentionReason: 'Above range', patientId: 'p2', patientName: 'Chloe Bell' }),
    item({ id: 'rad:1', category: 'radiology', subject: 'Chest X-ray', status: 'Normal', patientId: 'p2', patientName: 'Chloe Bell' }),
  ];

  it('every patient\'s normal Inbox records — all of them, counted', () => {
    const facts = collectFacts({ kind: 'inbox', category: 'all', status: 'normal', file: 'all', attention: false }, source(inbox, ['lab:1']));
    expect(facts.title).toBe('Normal Inbox records');
    expect(facts.scope).toBe('All patients · 2 records');
    expect(facts.stats.map((s) => `${s.label}=${s.value}`)).toEqual(['Records=2', 'Patients=2', 'Abnormal=0', 'Need attention=0']);
    const records = facts.sections.find((s) => s.title === 'Records')!;
    expect(records.items.map((i) => i.text)).toEqual(['Lipid panel — Tom Baker', 'Chest X-ray — Chloe Bell']);
    expect(records.items[0].detail).toContain('filed');
  });

  it('nothing to summarize is said plainly — no model is asked', async () => {
    const facts = collectFacts({ kind: 'inbox', category: 'referral', status: 'abnormal', file: 'all', attention: false }, source(inbox));
    expect(facts.empty).toBe(true);
    let asked = 0;
    const llm = { name: 'x', chat: async () => (asked++, { content: 'made up', toolCalls: [] }) } as ChatLLM;
    const written = await writeSummary(llm, 'summarize abnormal referrals', facts);
    expect(asked).toBe(0);
    expect(written).toMatchObject({ source: 'rules', text: 'There are no abnormal referrals.' });
  });

  it('the model is given only the facts, and no tools; a failed or empty answer falls back to the facts', async () => {
    const facts = collectFacts({ kind: 'inbox', category: 'all', status: 'all', file: 'all', attention: false }, source(inbox));
    let tools: unknown[] | null = null;
    const answering = { name: 'm', chat: async (_m: unknown, t: unknown[]) => ((tools = t), { content: '<think>hmm</think>**HbA1c** is abnormal for Chloe Bell; 2 normal records.', toolCalls: [] }) } as unknown as ChatLLM;
    const written = await writeSummary(answering, 'summarize the inbox', facts);
    expect(tools).toEqual([]);
    expect(written).toMatchObject({ source: 'model', text: 'HbA1c is abnormal for Chloe Bell; 2 normal records.' });
    expect(String(summaryMessages('summarize the inbox', facts)[1].content)).toContain('- HbA1c — Chloe Bell (lab result · Abnormal');

    const down = { name: 'm', chat: async () => Promise.reject(new Error('unreachable')) } as unknown as ChatLLM;
    const fallback = await writeSummary(down, 'summarize the inbox', facts);
    expect(fallback.source).toBe('rules');
    expect(fallback.text).toBe(ruleSummary(facts));
    expect(fallback.text).toMatch(/^Inbox records — All patients · 3 records\./);
  });

  it('a model\'s preamble and markdown are taken out', () => {
    expect(cleanSummary("Here's a summary of the records:\n## Labs\n* Lipid panel normal\n* HbA1c abnormal")).toBe('Labs\n- Lipid panel normal\n- HbA1c abnormal');
    expect(cleanSummary('ok')).toBe('');
  });

  it('what MedGemma got wrong on Kaggle is not shown: "there are none" when there are, numbers not in the data, the data copied back', () => {
    const facts = collectFacts({ kind: 'inbox', category: 'all', status: 'all', file: 'all', attention: false }, source(inbox));
    expect(unusable('There are no normal Inbox records.', facts)).toMatch(/nothing/);
    expect(unusable('Chloe Bell has 7 abnormal results.', facts)).toMatch(/numbers/);
    expect(unusable('Records: 3; Patients: 2\nIn brief:\n- HbA1c — Chloe Bell', facts)).toMatch(/copies/);
    expect(unusable('HbA1c is abnormal for Chloe Bell and needs attention; the lipid panel and chest X-ray are normal.', facts)).toBeNull();
  });

  it('counts that overlap are said to overlap — "14 flagged for attention and 12 abnormal" of 25 is never shown', () => {
    const items = [
      item({ id: 'lab:a', subject: 'HbA1c', status: 'Abnormal', attention: true, attentionReason: 'Abnormal result' }),
      item({ id: 'lab:b', subject: 'ALT', status: 'Abnormal', attention: true, attentionReason: 'Abnormal result' }),
      item({ id: 'ref:c', category: 'referral', subject: 'Cardiology referral', status: 'Normal', attention: true, attentionReason: 'Urgent priority' }),
    ];
    const facts = collectFacts({ kind: 'inbox', category: 'all', status: 'all', file: 'all', attention: false }, source(items));
    const overlap = facts.sections.find((x) => x.title === 'How the counts overlap')!.items.map((i) => i.text);
    expect(overlap).toEqual([
      '3 records in all: 2 abnormal and 1 normal (these two add up to 3).',
      'Of the 2 abnormal: all 2 need attention.',
      'Of the 1 normal: 1 need attention (1 urgent priority).',
      'Need attention: 3 = 2 abnormal + 1 normal — the same records as above, not more of them.',
    ]);
    // What qwen3.5:9b wrote — read as 5 of 3: not shown.
    expect(unusable('The Inbox contains 3 records across 2 patients, with 3 items flagged for attention and 2 marked as abnormal.', facts)).toMatch(/overlapping/);
    // Said as they relate: shown.
    expect(unusable('All 3 records need attention: both 2 abnormal lab results and 1 urgent cardiology referral.', facts)).toBeNull();
  });
});

describe('what a summary calls urgent is the records’ own priority — never the model’s judgement', () => {
  // The 12 abnormal Inbox records of the live test, each with its own priority.
  const abnormal = (id: string, category: InboxItem['category'], subject: string, patientName: string, priority?: string, value?: string) =>
    item({ id, category, subject, patientId: patientName, patientName, priority, status: 'Abnormal', attention: true, attentionReason: 'Abnormal finding', ...(value ? { result: { test: subject, value } } : {}) });
  const records = [
    abnormal('lab:1', 'lab', 'Liver Function Tests', 'Liam Thompson', 'STAT', 'ALT 96 U/L'),
    abnormal('rad:1', 'radiology', 'PET — Right shoulder', 'Lily Martin', 'Routine'),
    abnormal('dis:1', 'discharge', 'Discharge note – Vaccination', 'Liam Thompson'),
    abnormal('lab:2', 'lab', 'Lipid Panel', 'Lily Martin', 'Urgent', 'LDL 168 mg/dL'),
    abnormal('lab:3', 'lab', 'Urinalysis', 'Liam Martin', 'Routine', 'Protein 2+, WBC present'),
    abnormal('rad:2', 'radiology', 'Mammography — Chest', 'Lucas Martin', 'Routine'),
    abnormal('dis:2', 'discharge', 'Discharge note – Lab results review', 'Liam Martin'),
    abnormal('ref:1', 'referral', 'Dermatology referral', 'Lucy Young', 'Routine'),
    abnormal('lab:4', 'lab', 'Liver Function Tests', 'Lucy Young', 'Routine', 'ALT 96 U/L'),
    abnormal('rad:3', 'radiology', 'CT — Right shoulder', 'Ella Hall', 'Urgent'),
    abnormal('dis:3', 'discharge', 'Discharge Summary – Sep 15, 2026', 'Lucy Young'),
    abnormal('ref:2', 'referral', 'Internal Medicine referral', 'Harry White', 'Routine'),
  ];
  const facts = collectFacts({ kind: 'inbox', category: 'all', status: 'abnormal', file: 'all', attention: false }, source(records));

  it('the data says which records are urgent — and lists them first', () => {
    expect(facts.sections.find((x) => x.title === 'Priority (from the records)')!.items.map((i) => i.text)).toEqual([
      'Urgent by their own priority: 3 of the 12 — only these; rank no other record above them.',
      'STAT: Liver Function Tests — Liam Thompson',
      'Urgent: Lipid Panel — Lily Martin',
      'Urgent: CT — Right shoulder — Ella Hall',
      'The rest: 6 Routine priority, 3 no priority given.',
    ]);
    const listed = facts.sections.find((x) => x.title === 'Records')!.items;
    expect(listed.slice(0, 3).map((i) => i.text)).toEqual(['Liver Function Tests — Liam Thompson', 'Lipid Panel — Lily Martin', 'CT — Right shoulder — Ella Hall']);
    expect(listed[0].detail).toContain('STAT priority');
    expect(String(summaryMessages('summarize all inbox abnormal records', facts)[1].content)).toContain('- Urgent: CT — Right shoulder — Ella Hall');
  });

  it('what Ternary Bonsai wrote on Kaggle — two Routine referrals called "the most urgent": that sentence goes, the rest stays', async () => {
    const bonsai =
      'All 12 abnormal records need attention, spanning 7 patients. The most urgent items are the two referrals (Dermatology for Lucy Young and Internal Medicine for Harry White) and the two radiology reports with abnormal findings (PET right shoulder for Lily Martin and CT right shoulder for Ella Hall). Lab results include two elevated ALT levels at 96 U/L (Liam Thompson and Lucy Young), an LDL of 168 mg/dL (Lily Martin), and a urinalysis showing protein 2+ and WBC (Liam Martin).';
    const llm = { name: 'ternary-bonsai-2-27b', chat: async () => ({ content: bonsai, toolCalls: [] }) } as unknown as ChatLLM;
    const written = await writeSummary(llm, 'Summarize all inbox abnormal records', facts);
    expect(written.source).toBe('model');
    expect(written.removed).toEqual([expect.stringMatching(/^The most urgent items are the two referrals/)]);
    expect(written.text).toBe(
      'All 12 abnormal records need attention, spanning 7 patients. Lab results include two elevated ALT levels at 96 U/L (Liam Thompson and Lucy Young), an LDL of 168 mg/dL (Lily Martin), and a urinalysis showing protein 2+ and WBC (Liam Martin).',
    );
    expect(written.note).toMatch(/^The Safety Agent took out what the data does not support/);
  });

  it('urgency the records hold stays — so does saying something is NOT urgent', () => {
    const right = 'Most urgent: the ALT of 96 U/L for Liam Thompson (STAT), then the LDL for Lily Martin and the CT for Ella Hall (both Urgent).';
    expect(unsupportedUrgency(right, facts)).toEqual({ text: right, removed: [] });
    expect(unsupportedUrgency('The two referrals, for Lucy Young and Harry White, are not urgent.', facts).removed).toEqual([]);
    // A "not" further on does not take the claim back.
    expect(unsupportedUrgency('The most urgent is the referral for Lucy Young, which has not been filed yet.', facts).removed).toHaveLength(1);
    // MedGemma's summary called nothing urgent: untouched.
    const medgemma = 'There are 12 abnormal records in the inbox. Lucy Young has 3 abnormal records, including abnormal liver function tests and a dermatology referral.';
    expect(unsupportedUrgency(medgemma, facts).removed).toEqual([]);
  });

  it('naming no patient: the kind of record must have an urgent one; with nothing urgent, nothing is', () => {
    expect(unsupportedUrgency('The referrals are the most urgent.', facts).removed).toHaveLength(1);
    expect(unsupportedUrgency('The urgent ones are a lab result and a CT.', facts).removed).toEqual([]);
    const routine = collectFacts({ kind: 'inbox', category: 'referral', status: 'all', file: 'all', attention: false }, source(records));
    expect(routine.sections.find((x) => x.title === 'Priority (from the records)')!.items[0].text).toBe('None of the 2 is marked STAT, Emergency, Urgent or High priority — call none of them urgent.');
    expect(unsupportedUrgency('Both referrals need urgent review.', routine).removed).toHaveLength(1);
    expect(unsupportedUrgency('Neither referral is urgent.', routine).removed).toEqual([]);
  });

  it('a summary that was nothing but unsupported urgency is written from the data instead', async () => {
    const llm = { name: 'm', chat: async () => ({ content: 'Lucy Young and Harry White need urgent action.', toolCalls: [] }) } as unknown as ChatLLM;
    const written = await writeSummary(llm, 'summarize', facts);
    expect(written).toMatchObject({ source: 'rules', text: ruleSummary(facts) });
    expect(written.note).toMatch(/^The model's text was not used: The Safety Agent took out/);
  });
});

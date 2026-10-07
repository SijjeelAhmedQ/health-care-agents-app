/**
 * WHAT a summary is of — read from the provider's words (and the page on screen), by code.
 *
 * The Summary Agent's model never picks a tool or an argument: the app decides what is being summarized and
 * gathers its data, and the model only writes the text. So any model can write summaries — MedGemma included,
 * which calls no tools — and a summary is always of the data the provider asked about:
 *
 *   "Summarize all inbox normal records"      → Inbox · Normal · every category · every patient
 *   "summary of Tom Baker's abnormal labs"    → Inbox · Abnormal · Lab · Tom Baker
 *   "give me a summary of my day"             → the dashboard
 *   "summarize his medications"               → the selected patient's medications
 *   "summarize this page"                     → whatever page is on screen
 */
import type { RecordKind } from '@/types/records';
import type { InboxView } from '@/services/inbox/inboxModel';

export type InboxStatusFilter = 'all' | 'normal' | 'abnormal';
export type InboxFileFilter = 'all' | 'unfiled' | 'filed';

export type SummaryTarget =
  | { kind: 'dashboard' }
  | {
      kind: 'inbox';
      category: InboxView;
      status: InboxStatusFilter;
      file: InboxFileFilter;
      attention: boolean;
      /** A patient's id, or undefined for every patient. */
      patientId?: string;
    }
  /** One patient's chart — or only one kind of their records. */
  | { kind: 'patient'; patientId?: string; records?: RecordKind }
  /** The patient list. */
  | { kind: 'patients' }
  /** The signed-in provider's own appointments (My Appointments). */
  | { kind: 'schedule' }
  | { kind: 'configuration' };

/** What the detector needs to know of the app. */
export interface TargetContext {
  /** The page on screen (its PageRegistry id). */
  pageId: string | null;
  /** The selected patient. */
  selectedPatientId: string | null;
  patients: ReadonlyArray<{ id: string; fullName: string; firstName?: string; lastName?: string }>;
}

const THIS_PAGE = /\b(this|current|the)\s+(page|tab|screen|view|section|option)\b|\b(what'?s|what is)\s+(on\s+)?(the\s+)?screen\b|\bon\s+(the\s+)?screen\b/i;
const INBOX = /\b(inbox|labs?|lab results?|results?|radiology|imaging|x-?rays?|scans?|mri|ct|ultrasound|referrals?|discharges?|discharge summar(y|ies)|reports?|(ab)?normal|unfiled|un-filed|not filed|unreviewed)\b/i;
const DASHBOARD = /\b(dashboard|my day|today|today'?s|workload|day)\b/i;
const MY_SCHEDULE = /\b(my\s+(appointments?|schedule|agenda|calendar|bookings?|visits?)|who am i seeing|schedule)\b/i;
const MY_WORK = /\bmy\s+(tasks?|recalls?|work|queue)\b/i;
const PATIENT_LIST = /\b(patient\s+list|patients\s+list|all\s+(the\s+)?patients|every\s+patient|my\s+panel|the\s+patients|patients\s+page|patients)\b/i;
const CONFIGURATION = /\b(configuration|settings|config|ai\s+models?|models?)\b/i;
const SELECTED = /\b(his|her|their|(this|the|selected|current)\s+patient(?:'s)?)\b(?!s)/i;
const ALL_PATIENTS = /\b(all|every|everyone'?s?|each)\s+(the\s+)?(patients?'?s?|patient'?s)\b|\beveryone\b|\ball\s+of\s+them\b/i;

const RECORD_WORDS: Array<[RecordKind, RegExp]> = [
  ['medication', /\b(medications?|meds?|drugs?|prescriptions?|medicines?)\b/i],
  ['diagnosis', /\b(diagnos[ie]s|diagnosis|problems?(\s+list)?|conditions?)\b/i],
  ['task', /\b(tasks?|to-?dos?)\b/i],
  ['recall', /\b(recalls?|reminders?)\b/i],
  ['appointment', /\b(appointments?|visits?|bookings?)\b/i],
];

/** Every patient whose full name (or first + last) appears in the words — longest names first. */
export function patientsNamed(text: string, patients: TargetContext['patients']): string[] {
  const words = ` ${text.toLowerCase().replace(/[’']s\b/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  return [...patients]
    .sort((a, b) => b.fullName.length - a.fullName.length)
    .filter((p) => {
      const full = p.fullName.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
      return full.length > 2 && words.includes(` ${full} `);
    })
    .map((p) => p.id);
}

function inboxCategory(text: string): InboxView {
  if (/\b(radiology|imaging|x-?rays?|scans?|mri|ct|ultrasound|mammograph\w*)\b/i.test(text)) return 'radiology';
  if (/\breferrals?\b/i.test(text)) return 'referral';
  if (/\bdischarges?\b|discharge summar/i.test(text)) return 'discharge';
  if (/\b(labs?|lab results?|blood (tests?|work)|tests?)\b/i.test(text)) return 'lab';
  return 'all';
}

function inboxTarget(text: string, ctx: TargetContext, category?: InboxView): Extract<SummaryTarget, { kind: 'inbox' }> {
  const named = patientsNamed(text, ctx.patients)[0];
  const patientId = ALL_PATIENTS.test(text) ? undefined : (named ?? (SELECTED.test(text) ? (ctx.selectedPatientId ?? undefined) : undefined));
  return {
    kind: 'inbox',
    category: category ?? inboxCategory(text),
    status: /\babnormal\b/i.test(text) ? 'abnormal' : /\bnormal\b/i.test(text) ? 'normal' : 'all',
    file: /\b(unfiled|un-filed|not\s+filed|unreviewed|not\s+reviewed|pending|outstanding)\b/i.test(text) ? 'unfiled' : /\b(filed|reviewed)\b/i.test(text) ? 'filed' : 'all',
    attention: /\b(attention|flagged|urgent|critical|stat)\b/i.test(text),
    patientId,
  };
}

/** What the page on screen is a summary of. */
export function pageTarget(pageId: string | null, ctx: TargetContext): SummaryTarget {
  const id = pageId ?? '';
  if (id === 'patients') return { kind: 'patients' };
  if (id === 'my-appointments') return { kind: 'schedule' };
  if (id === 'configuration') return { kind: 'configuration' };
  if (id === 'inbox' || id.startsWith('inbox-')) {
    const tab = id.slice('inbox-'.length) as InboxView;
    return { kind: 'inbox', category: id === 'inbox' ? 'all' : tab, status: 'all', file: 'all', attention: false };
  }
  if (id.startsWith('summary-') && id !== 'summary-ai') {
    return { kind: 'patient', patientId: ctx.selectedPatientId ?? undefined, records: id.slice('summary-'.length) as RecordKind };
  }
  if (id === 'summary' || id === 'summary-ai') return { kind: 'patient', patientId: ctx.selectedPatientId ?? undefined };
  return { kind: 'dashboard' };
}

/**
 * The target of a summary request, from the words: the first of `texts` that names one wins — the Summary
 * Agent's task first, then what the provider said (the master's task can lose a word: "go to inbox and …
 * abnormal records summary" given as "summarize all abnormal records"). Only when none names anything is it
 * the page on screen.
 */
export function detectTarget(texts: string | ReadonlyArray<string | undefined>, ctx: TargetContext): SummaryTarget {
  for (const text of typeof texts === 'string' ? [texts] : texts) {
    const found = text ? namedTarget(text, ctx) : null;
    if (found) return found;
  }
  return pageTarget(ctx.pageId, ctx);
}

/** What the words name as the summary's target — or null when they name nothing ("summarize"). */
export function namedTarget(text: string, ctx: TargetContext): SummaryTarget | null {
  const said = text.replace(/\s+/g, ' ').trim();
  const named = patientsNamed(said, ctx.patients)[0];
  const aboutPatient = !!named || SELECTED.test(said);
  const record = RECORD_WORDS.find(([, re]) => re.test(said))?.[0];

  // "Summarize this page / tab / what's on screen" — whatever it is.
  if (THIS_PAGE.test(said) && !INBOX.test(said.replace(THIS_PAGE, '')) && !record) return pageTarget(ctx.pageId, ctx);
  // The Inbox — any category, any status, any patient (or all).
  if (INBOX.test(said) && !(record && aboutPatient && !/\binbox\b/i.test(said))) return inboxTarget(said, ctx);
  // The provider's own appointments.
  if (MY_SCHEDULE.test(said) && !aboutPatient) return { kind: 'schedule' };
  // The provider's day: the dashboard (also "my tasks", "my recalls" — their own work queue).
  if ((DASHBOARD.test(said) || MY_WORK.test(said)) && !aboutPatient) return { kind: 'dashboard' };
  // One kind of a patient's records, or their whole chart.
  if (record && (aboutPatient || !PATIENT_LIST.test(said))) return { kind: 'patient', patientId: named ?? ctx.selectedPatientId ?? undefined, records: record };
  if (aboutPatient || /\b(chart|patient\s+summary|clinical\s+summary)\b/i.test(said)) return { kind: 'patient', patientId: named ?? ctx.selectedPatientId ?? undefined };
  if (PATIENT_LIST.test(said)) return { kind: 'patients' };
  if (CONFIGURATION.test(said)) return { kind: 'configuration' };
  return null;
}

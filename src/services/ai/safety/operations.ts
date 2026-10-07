/**
 * Operations — WHAT is being done decides what must be said, never the kind of record alone.
 *
 *   1. detect the operation      add · update · delete one · delete all · view · select / create a patient
 *   2. identify the entity       medication, diagnosis, task, recall, appointment, patient
 *   3. what THIS operation needs (below) — and what of it is missing
 *   4. the Safety Agent checks each value that was said, deterministically
 *   5. a destructive operation waits for the provider's confirmation (the app's own confirm step)
 *   6. only then does the specialist's tool run
 *
 *   add           patient · the record's own required fields (the form's schema: a drug's name, dose, route,
 *                 frequency — whatever the form requires, nothing else)
 *   update        patient · which record · at least one change — only the fields being changed
 *   delete one    patient · which record (nothing clinical: a dose identifies nothing the name does not)
 *   delete all    patient · scope ALL — no record, no field; confirmed before anything is deleted
 *   view          patient — no clinical field
 *
 * "Delete all medications for Tom Baker" never asks "Which medication, at what dose…?".
 */
import type { RecordKind } from '@/types/records';
import { missingFrom, type Missing } from './requirements';

export type Operation = 'add' | 'update' | 'delete_one' | 'delete_all' | 'view' | 'select_patient' | 'create_patient' | 'other';
export type Entity = RecordKind | 'patient';

export interface DetectedOperation {
  operation: Operation;
  /** The kind of record it is about, when the words name one. */
  kind?: Entity;
}

const VERBS: Array<[Exclude<Operation, 'delete_all' | 'create_patient' | 'other'>, RegExp]> = [
  ['delete_one', /\b(delete|remove|erase|wipe|clear out|get rid of)\b/],
  ['update', /\b(change|update|edit|modify|adjust|amend|increase|decrease|reduce|raise|lower|switch|stop|discontinue|hold|resume|mark|rename|set(?! up))\b/],
  ['add', /\b(add|create|new|prescribe|start|book|schedule|set up|enter|put|register|enrol|enroll|give|recall|remind)\b/],
  ['select_patient', /\b(select|choose|pick)\b/],
  ['view', /\b(show|list|view|display|see|read|open|check|what|which|how many|any)\b/],
];
/** "all", "every", "each", "everything", "all of his/her/their …" — the whole set, not one record. */
const ALL = /\b(all|every|each|everything|entire|whole)\b/;

/** The kinds of record words name ("add medication", "delete all diagnoses"), in the order they come. */
export function entitiesIn(text: string): Entity[] {
  const t = text.toLowerCase();
  const found: Array<[number, Entity]> = [];
  const at = (kind: Entity, re: RegExp) => {
    const m = re.exec(t);
    if (m) found.push([m.index, kind]);
  };
  at('medication', /\b(medications?|medicines?|meds?|drugs?|prescri\w*|tablets?|antibiotics?|painkillers?|analgesics?|antihypertensives?|statins?|steroids?|insulin|inhalers?)\b/);
  at('diagnosis', /\b(diagnos[ie]s|diagnosis|conditions?|problems?)\b/);
  at('task', /\btasks?\b/);
  at('recall', /\brecalls?\b/);
  // "Follow-up" is an appointment — unless it only describes another record ("the follow-up recall").
  at('appointment', /\b(appointments?|visits?)\b|\bfollow ?-?ups?\b(?!\s+(recalls?|tasks?|medications?|diagnos[ie]s|diagnosis|notes?)\b)/);
  return found.sort((a, b) => a[0] - b[0]).map(([, kind]) => kind);
}

/**
 * The operation words ask for — the verb that comes first leads ("change the frequency to twice daily" is an
 * update, though "twice daily" could be part of an add). "Delete" with "all/every" over a kind is delete all.
 */
export function detectOperation(text: string): DetectedOperation {
  const t = text.toLowerCase();
  const kind = entitiesIn(t)[0];
  let first: { operation: Operation; at: number } | null = null;
  for (const [operation, re] of VERBS) {
    const m = re.exec(t);
    if (m && (!first || m.index < first.at)) first = { operation, at: m.index };
  }
  if (!first) return { operation: 'other', kind };
  if (first.operation === 'delete_one' && ALL.test(t)) return { operation: 'delete_all', kind };
  // "Add a new patient" — an add that names no record, only a patient.
  // ("… do not change anything for the other patients" is no new patient.)
  if (first.operation === 'add' && !kind && /\b(new|register|enrol|enroll|add|create)\s+(an?\s+)?(new\s+)?patient\b/.test(t)) return { operation: 'create_patient', kind: 'patient' };
  return { operation: first.operation, kind };
}

/** Words that ask to add something — said anywhere in the request. */
export const saysAdd = (text: string) => VERBS.find(([op]) => op === 'add')![1].test(text.toLowerCase());
/** Words that ask for ALL of them. */
export const saysAll = (text: string) => ALL.test(text.toLowerCase());

/**
 * The words of a request that carry no value of a record: the action, the kind, the time words, small words.
 * What is left of an utterance without them is what its values must come from.
 */
export const REQUEST_WORDS: ReadonlySet<string> = new Set(
  (
    'add create make new set up book schedule recall remind arrange put enter record select choose pick open go goto show list ' +
    'delete remove change update edit mark please can could would you i want need ' +
    'replace swap switch substitute keep make get put set start stop do done have has had is are was be with into instead ' +
    'task tasks recall recalls appointment appointments visit reminder medication medications medicine diagnosis diagnoses ' +
    'after in within on at by from next this coming following tomorrow today tonight day days week weeks month months year years ' +
    'monday tuesday wednesday thursday friday saturday sunday am pm one two three four five six seven eight nine ten eleven twelve ' +
    'a an the and or for to of with patient patients page him her them his their it ' +
    'again also too more same that this these those one now then just ok okay yes no all every each any some'
  ).split(' '),
);

/**
 * Words that name nothing specific — "the appropriate antibiotic", "the usual dose", "whatever medication is
 * normally used", "the medication we discussed": asking the app to choose, or pointing at nothing said. A value
 * made only of these (and the request's words) is not a drug, a condition or a reason the provider gave.
 */
export const VAGUE_WORDS: ReadonlySet<string> = new Set(
  (
    'appropriate suitable usual usually standard normal normally regular regularly typical typically common commonly default ' +
    'whatever whichever something anything best right proper correct reasonable sensible good better stronger weaker higher lower adult ' +
    'decide choose yourself think medically clinically discussed talked mentioned earlier previous previously last before ' +
    'based information already have has know makes sense value values missing most needed fine should be is are was were we ' +
    'antibiotic antibiotics painkiller painkillers analgesic analgesics antihypertensive statin steroid vitamin supplement drug drugs med meds dose doses dosage ' +
    'condition conditions symptoms problem problems use used using give take care treat treatment therapy hey there sure maybe probably guess ' +
    'find look up go section if just me my your our its'
  ).split(' '),
);

/** Made only of words that name nothing specific ("appropriate antibiotic", "the usual medication"). */
export const vagueOnly = (value: string): boolean => {
  const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.length > 0 && words.every((w) => VAGUE_WORDS.has(w) || REQUEST_WORDS.has(w));
};

/**
 * A day for an appointment: "next week", "this month", "sometime" name no day to book. A weekday, a date, a
 * month day, "tomorrow", "in 3 days" do.
 */
export const VAGUE_DAY = /\b(next|this|coming|following) (week|month)\b|\bsometime\b|\bsoon\b/;
export const SPECIFIC_DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|\d{1,2}(st|nd|rd|th)|\d{1,2}[/-]\d{1,2}|\d{4}-\d{2}-\d{2}|january|february|march|april|june|july|august|september|october|november|december|in \w+ days?)\b/;

/** An utterance's own words (lowercase, letters and digits), without the request's words. */
export const contentWords = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !REQUEST_WORDS.has(w));

/** Destructive operations: nothing happens before the provider confirms. */
export const isDestructive = (operation: Operation) => operation === 'delete_one' || operation === 'delete_all';

/** One planned operation, as the requirements are worked out for it. */
export interface OperationPlan {
  operation: Operation;
  kind?: Entity;
  /** The patient it is for, as said (vetted). */
  patient?: string;
  /** update / delete one: the record as the provider named it. */
  record?: string;
  /** add: the records, each with only what was said. */
  records: Array<{ kind: RecordKind; values: Record<string, unknown> }>;
  /** update: field → new value, only what was said. */
  changes: Record<string, unknown>;
  /** create_patient: the new patient's details. */
  patientDetails: Record<string, unknown>;
}

const NAME_FIELD: Partial<Record<Entity, string>> = { medication: 'medicationName', diagnosis: 'description', task: 'title', recall: 'reason' };
const label = (v: unknown) => (typeof v === 'string' ? v : String(v));

/**
 * What THIS operation still needs. `patientChosen`: a patient is selected, or chosen earlier in the request.
 * Never the record kind's add-form fields for anything but an add.
 */
export function missingFor(plan: OperationPlan, patientChosen: boolean): Missing[] {
  // "Which patient should this medication be added to?" — for an add; anything else: "Which patient is this for?"
  const of = (plan.operation === 'add' ? plan.records.map((r) => r.kind) : []) as RecordKind[];
  const needPatient = () => (!plan.patient && !patientChosen ? [{ kind: 'record_patient', of } as Missing] : []);
  switch (plan.operation) {
    case 'select_patient':
      return plan.patient ? [] : [{ kind: 'select_patient' }];
    case 'create_patient': {
      const fields = missingFrom('patient', plan.patientDetails);
      return fields.length ? [{ kind: 'patient', fields }] : [];
    }
    case 'add':
      // Nothing named to add at all ("add something for Chloe Bell"): asked what.
      if (!plan.records.length) return [...needPatient(), { kind: 'what_to_add', patient: plan.patient } as Missing];
      return [
        ...needPatient(),
        ...plan.records.flatMap<Missing>((r) => {
          const fields = missingFrom(r.kind, r.values);
          const nameField = NAME_FIELD[r.kind];
          const name = nameField && r.values[nameField] !== undefined ? label(r.values[nameField]) : undefined;
          // What was said for it, shown back: "I have the medication as Gabapentin 500 mg."
          const have = r.kind === 'medication' ? [name, r.values.dosage, r.values.frequency].filter((v) => v !== undefined && v !== null && v !== '').map(label).join(' ') || undefined : undefined;
          return fields.length ? [{ kind: r.kind, name, fields, have, patient: plan.patient }] : [];
        }),
      ];
    case 'update': {
      if (plan.kind === 'patient') {
        const out: Missing[] = plan.patient ? [] : [{ kind: 'select_patient' }];
        if (!Object.keys(plan.changes).length) out.push({ kind: 'changes', record: 'patient', name: plan.patient });
        return out;
      }
      const kind = plan.kind as RecordKind | undefined;
      if (!kind) return [];
      return [
        ...needPatient(),
        ...(plan.record ? [] : [{ kind: 'existing', record: kind, verb: 'change', patient: plan.patient } as Missing]),
        ...(Object.keys(plan.changes).length ? [] : [{ kind: 'changes', record: kind, name: plan.record } as Missing]),
      ];
    }
    case 'delete_one':
      if (plan.kind === 'patient') return plan.patient ? [] : [{ kind: 'existing', record: 'patient', verb: 'delete' }];
      if (!plan.kind) return [];
      return [...needPatient(), ...(plan.record ? [] : [{ kind: 'existing', record: plan.kind, verb: 'delete', patient: plan.patient } as Missing])];
    case 'delete_all':
    case 'view':
      return needPatient();
    default:
      return [];
  }
}

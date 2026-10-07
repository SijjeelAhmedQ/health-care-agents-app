/**
 * Requirements — what the provider must say for an action, and the question that asks for what is missing.
 *
 * Required fields come from the forms themselves (FieldRegistry); a field the application fills by itself
 * (route Oral, a task due in a week, the signed-in provider) is not asked for. The questions are templates:
 * a model never words them, so a question can never suggest a value ("Panadol?").
 */
import { FieldRegistry } from '@/registry/fieldRegistry';
import { defaultValues } from '@/registry/recordDefaults';
import type { RecordKind } from '@/types/records';

export type RequirementKind = RecordKind | 'patient';

/** Fields the application fills by itself — never asked for. */
const FILLED_BY_APP: Partial<Record<RequirementKind, string[]>> = {
  appointment: ['providerName'],
};

/** What the provider must say for a new record of this kind (in form order). */
export function mustSay(kind: RequirementKind): string[] {
  const form = FieldRegistry.getForm(kind);
  if (!form) return [];
  const defaults = kind === 'patient' ? {} : defaultValues(kind, '');
  return form.fields
    .filter((f) => f.required && f.name !== 'patient' && !(f.name in defaults) && !(FILLED_BY_APP[kind] ?? []).includes(f.name))
    .map((f) => f.name);
}

/** What is still missing from a record: its required fields that hold no value. */
export function missingFrom(kind: RequirementKind, values: Record<string, unknown>): string[] {
  const has = (f: string) => values[f] !== undefined && values[f] !== null && values[f] !== '';
  return mustSay(kind).filter((f) => !has(f) && !(kind === 'patient' && f === 'dateOfBirth' && has('age')));
}

/** Something the provider is asked for: a patient to select, the patient records are for, or a record's fields. */
export type Missing =
  | { kind: 'select_patient' }
  /** The patient records are for — `of`: the kinds of record, for the wording ("this medication"). */
  | { kind: 'record_patient'; of?: RecordKind[] }
  /** A patient named that is nobody on file, or more than one patient ("Ahmed", "John"). */
  | { kind: 'which_patient'; said: string; options: string[]; close?: boolean }
  | { kind: 'comment' }
  /** An add with nothing named to add. */
  | { kind: 'what_to_add'; patient?: string }
  | { kind: 'existing'; record: RecordKind | 'patient'; verb: string; patient?: string }
  /** An update with nothing said to change ("change Gabapentin for Tom Baker"). */
  | { kind: 'changes'; record: RecordKind | 'patient'; name?: string }
  /** A record's required fields. `have`: what was said for it (shown back); `patient`: whose it is. */
  | { kind: RequirementKind; name?: string; fields: string[]; have?: string; patient?: string };

const list = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** A field as the provider names it, in "please provide the missing information: …". */
const LABEL: Record<string, Record<string, string>> = {
  medication: { medicationName: 'medication name', dosage: 'dose', frequency: 'frequency', duration: 'duration', route: 'route of administration' },
  task: { title: 'what the task is', dueDate: 'due date' },
  recall: { reason: 'reason', dueDate: 'due date' },
  appointment: { date: 'date', startTime: 'time', reason: 'reason for the visit' },
  patient: { firstName: 'first name', lastName: 'last name', dateOfBirth: 'date of birth (or age)', gender: 'gender', phone: 'phone number' },
};
const labelOf = (kind: string, field: string) => LABEL[kind]?.[field] ?? FieldRegistry.getForm(kind)?.fields.find((f) => f.name === field)?.label.toLowerCase() ?? field;

/** "this medication", "these records" — the records a patient is asked for. */
function recordsWord(of: RecordKind[] = []): string {
  const kinds = [...new Set(of)];
  if (kinds.length !== 1) return kinds.length ? 'these records' : 'this';
  return `this ${kinds[0]}`;
}

/** One missing thing, as one or two polite sentences. */
function sentence(m: Missing): string {
  switch (m.kind) {
    case 'select_patient':
      return 'Which patient would you like to select?';
    case 'record_patient': {
      const what = recordsWord(m.of);
      if (what === 'this') return 'Which patient is this for?';
      if (m.of?.length === 1 && m.of[0] === 'appointment') return 'Which patient is this appointment for?';
      return `Which patient should ${what} be added to?`;
    }
    case 'which_patient':
      if (m.close && m.options.length) return `I couldn't find a patient named "${m.said}". Did you mean ${m.options.length < 2 ? m.options[0] : `${m.options.slice(0, -1).join(', ')} or ${m.options[m.options.length - 1]}`}?`;
      if (m.options.length > 1) return `I found more than one patient matching "${m.said}": ${list(m.options)}. Which one do you mean?`;
      return `I couldn't find a patient named "${m.said}". Which patient do you mean?`;
    case 'comment':
      return 'What should the comment say?';
    case 'what_to_add':
      return `What would you like to add${m.patient ? ` for ${m.patient}` : ''}?`;
    case 'existing':
      return `Which ${m.record} would you like to ${m.verb}${m.patient ? ` for ${m.patient}` : ''}?`;
    case 'changes':
      return `What would you like to change for ${m.name ? m.name : `the ${m.record}`}?`;
    case 'medication':
      return medicationSentence(m);
    case 'diagnosis':
      return `Which diagnosis would you like to add${m.patient ? ` for ${m.patient}` : ''}?`;
    case 'task':
      if (m.fields.includes('title')) return `What task would you like to create${m.patient ? ` for ${m.patient}` : ''}?`;
      return `Please provide the missing information for the task${m.name ? ` "${m.name}"` : ''}: ${list(m.fields.map((f) => labelOf('task', f)))}.`;
    case 'recall': {
      const forP = m.patient ? ` for ${m.patient}` : '';
      const reason = m.fields.includes('reason');
      const due = m.fields.includes('dueDate');
      if (reason && due) return `What is the recall${forP} for, and when should it be due?`;
      if (reason) return `What is the reason for the recall${forP}?`;
      if (due) return `When should the recall${m.name ? ` for ${m.name}` : forP} be due?`;
      return `Please provide the missing information for the recall: ${list(m.fields.map((f) => labelOf('recall', f)))}.`;
    }
    case 'appointment': {
      const forP = m.patient ? ` for ${m.patient}` : '';
      const date = m.fields.includes('date');
      const time = m.fields.includes('startTime');
      const reason = m.fields.includes('reason');
      const when = date && time ? 'What date and time should the appointment' : date ? 'What date should the appointment' : time ? 'What time should the appointment' : '';
      const rest = m.fields.filter((f) => !['date', 'startTime', 'reason'].includes(f));
      const extra = rest.length ? ` Please also provide the ${list(rest.map((f) => labelOf('appointment', f)))}.` : '';
      if (when) return `${when}${forP} be scheduled for${reason ? ', and what is the reason for the visit' : ''}?${extra}`;
      if (reason) return `What is the reason for the visit${forP}?${extra}`;
      return extra.trim();
    }
    case 'patient':
      return `To add the new patient, please provide their ${list(m.fields.map((f) => labelOf('patient', f)))}.`;
  }
}

/**
 * A medication: one missing value is one plain question ("What dose should be prescribed for Gabapentin?");
 * several are listed after what was said ("I have the medication as Gabapentin 500 mg. Please provide …").
 */
function medicationSentence(m: { name?: string; fields: string[]; have?: string; patient?: string }): string {
  const forP = m.patient ? ` for ${m.patient}` : '';
  if (m.fields.includes('medicationName')) {
    const rest = m.fields.filter((f) => f !== 'medicationName').map((f) => ({ dosage: 'the dose', frequency: 'how often it should be taken', duration: 'for how many days', route: 'the route of administration' })[f] ?? labelOf('medication', f));
    return `What medication would you like to add${forP}?${rest.length ? ` Please also tell me ${list(rest)}.` : ''}`;
  }
  // The name was said but not reported: the question is about "it".
  if (!m.name) {
    if (m.fields.length === 1 && m.fields[0] === 'dosage') return `What dose should be prescribed${forP}?`;
    if (m.fields.length === 1 && m.fields[0] === 'frequency') return `How often should it be taken?`;
    return `Please provide the missing information for the medication${forP}: ${list(m.fields.map((f) => labelOf('medication', f)))}.`;
  }
  const name = m.name;
  if (m.fields.length === 1) {
    switch (m.fields[0]) {
      case 'dosage':
        return `What dose should be prescribed for ${name}?`;
      case 'frequency':
        return `How often should ${name} be taken?`;
      case 'duration':
        return `How many days should ${name} be prescribed for?`;
      case 'route':
        return `What route should be used for ${name}? For example, Oral.`;
    }
  }
  const several = / and /.test(name);
  const have = m.have && !several ? m.have : name;
  return `I have the medication${several ? 's' : ''} as ${have}. Please provide the missing information: ${list(m.fields.map((f) => labelOf('medication', f)))}.`;
}

/** Records of a kind missing the same fields are one part ("… for Panadol and Paracetamol"); repeats go. */
function merge(missing: Missing[]): Missing[] {
  const out: Missing[] = [];
  const names = new Map<Missing, string[]>();
  for (const m of missing) {
    if (!('fields' in m)) {
      if (!out.some((o) => JSON.stringify(o) === JSON.stringify(m))) out.push(m);
      continue;
    }
    const same = out.find((o) => 'fields' in o && o.kind === m.kind && o.fields.join() === m.fields.join() && !!o.name === !!m.name && (o as { patient?: string }).patient === m.patient);
    if (!same) {
      const own = { ...m };
      out.push(own);
      names.set(own, m.name ? [m.name] : []);
    } else if (m.name && !names.get(same)!.includes(m.name)) names.get(same)!.push(m.name);
  }
  return out.map((m) => (names.get(m) && names.get(m)!.length > 1 ? ({ ...m, name: list(names.get(m)!), have: undefined } as Missing) : m));
}

/** Who first: a question about the patient comes before the questions about the records. */
const ORDER = (m: Missing) => (m.kind === 'which_patient' ? 0 : m.kind === 'select_patient' || m.kind === 'record_patient' ? 1 : 2);

/**
 * One reply for everything missing, a polite sentence for each part:
 * "Which patient should this medication be added to? What dose should be prescribed for Gabapentin?"
 */
export function questionFor(missing: Missing[]): string {
  const parts = merge(missing)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => ORDER(a.m) - ORDER(b.m) || a.i - b.i)
    .map(({ m }) => sentence(m))
    .filter(Boolean);
  return parts.join(' ');
}

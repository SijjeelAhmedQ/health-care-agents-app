/**
 * The Safety Agent — nothing reaches the application that the provider did not say.
 *
 *   execution agent ─► tool call ─► SAFETY (check) ─► tool runs ─► SAFETY (after) ─► provider confirms
 *                                     │                               │
 *                                     ├ value said / app data / app default → kept
 *                                     ├ one value said for it → corrected to it ("twice a day" → Twice daily)
 *                                     ├ not said → removed; the app asks for it if it is required
 *                                     └ the record itself not said (the drug, the patient) → the call is not
 *                                       run: the provider is asked, with a fixed question
 *
 * It is code, not a model: it cannot invent anything, and it never completes a missing value — it only
 * traces values to the provider's words (provenance.ts), the application's data, or the application's own
 * defaults. It runs for every agent (the single assistant, the master, every specialist) at the one place
 * every action passes: the tool call. After a tool has prepared something for confirmation, it checks what
 * is on screen once more, before the provider is asked to confirm it.
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { FieldValues, SafetyFinding, ToolCall, ToolResult } from '@/types/ai';
import { RECORD_KINDS, type RecordKind } from '@/types/records';
import { FieldRegistry } from '@/registry/fieldRegistry';
import { defaultValues } from '@/registry/recordDefaults';
import { compactSaid, corpusOf, coverage, datesSaid, digitsSaid, doseSaid, durationSaid, frequenciesSaid, optionSaid, positionSaid, PRN_SAID, routesSaid, TELEHEALTH_SAID, timesSaid, wordSaid, type Corpus } from './provenance';
import { missingFrom, questionFor, type Missing } from './requirements';
import { needsReview, reviewFindings, reviewQuestion, type ReviewOutcome, type SafetyReviewer } from './reviewer';
import { detectOperation, REQUEST_WORDS, saysAdd, saysAll, SPECIFIC_DAY, VAGUE_DAY, VAGUE_WORDS, vagueOnly } from './operations';

/** What the Safety Agent reads: the provider's words for this request, and the application's own data. */
export interface SafetyContext {
  /** Every utterance of the request in progress — the clarifications included. */
  utterances(): readonly string[];
  /**
   * What the provider said in the requests just before this one. Only for what "it", "him", "that one" points
   * to — an existing record or patient named a moment ago — never for a new value.
   */
  recent?(): readonly string[];
  /** The dates and times of the appointments on file (what "the other slot" or "three days later" counts from). */
  slots?(): { dates: readonly string[]; times: readonly string[] };
  today?(): Dayjs;
  /** The signed-in provider (their name is the default of every "provider" field). */
  providerName(): string | null;
  providers(): readonly string[];
  selectedPatient(): { id: string; name: string } | null;
  patients(): ReadonlyArray<{ id: string; fullName: string; mrn?: string }>;
  /** The names the application holds for a kind (drugs, conditions on record). */
  known(kind: RecordKind): readonly string[];
  /** An existing record's name, by id. */
  recordLabel(kind: RecordKind, id: string): string | undefined;
  openFormId(): string | null;
  /**
   * The provider is where new records are made (Summary, a form or the care plan open): an incomplete record
   * opens in place and the form asks for what is missing. Anywhere else nothing opens before it is complete.
   */
  inPlace?(what: 'records' | 'patient'): boolean;
  /** What a create form or the care plan holds now (not an edit of a saved record). */
  staged(): Array<{ kind: string; values: Record<string, unknown> }>;
  /**
   * The patients a name said for a call could be — the application's own lookup (exact name, MRN, part of a
   * name, a misheard spelling). `name`: exactly one; otherwise every candidate (none: nobody matches).
   */
  findPatient?(raw: string): { name?: string; options: string[]; close?: boolean };
  /** The model's review of a call: begun, then what it found (Agent Monitoring shows both). */
  reviewed?(call: ToolCall, outcome: ReviewOutcome | 'started'): void;
  /** Close it, unconfirmed: nothing of it is saved. */
  discardStaged(): void;
}

export type SafetyVerdict =
  | { kind: 'allow'; findings: SafetyFinding[] }
  | { kind: 'rewrite'; args: Record<string, unknown>; findings: SafetyFinding[] }
  | { kind: 'ask'; result: ToolResult; findings: SafetyFinding[] }
  /** The call is not the operation the provider asked for: it goes back to the agent, not to the provider. */
  | { kind: 'refuse'; result: ToolResult; findings: SafetyFinding[] };

/** How a field's value is traced to what was said. Fields not listed (category, priority, status …) are the app's classification, not facts. */
type Check = 'drug' | 'diagnosis' | 'name' | 'text' | 'subject' | 'dose' | 'frequency' | 'route' | 'duration' | 'date' | 'dob' | 'time' | 'number' | 'digits' | 'compact' | 'gender' | 'words' | 'provider' | 'prn' | 'telehealth';

const CHECKS: Record<string, Record<string, Check>> = {
  medication: { medicationName: 'drug', dosage: 'dose', frequency: 'frequency', route: 'route', duration: 'duration', startDate: 'date', endDate: 'date', indication: 'text', instructions: 'text', notes: 'text', refills: 'number', isPRN: 'prn', prescribedBy: 'provider' },
  diagnosis: { description: 'diagnosis', icd10: 'compact', onsetDate: 'date', notes: 'text', diagnosedBy: 'provider' },
  task: { title: 'subject', dueDate: 'date', description: 'text', assignedTo: 'provider' },
  recall: { reason: 'subject', dueDate: 'date', notes: 'text' },
  appointment: { providerName: 'provider', date: 'date', startTime: 'time', durationMinutes: 'number', reason: 'subject', notes: 'text', isTelehealth: 'telehealth' },
  patient: {
    firstName: 'name', lastName: 'name', dateOfBirth: 'dob', age: 'number', gender: 'gender', occupation: 'text', phone: 'digits', email: 'compact',
    addressLine1: 'text', city: 'text', state: 'text', postalCode: 'digits', bloodGroup: 'words', maritalStatus: 'words', language: 'words',
    insuranceProvider: 'words', policyNumber: 'digits', primaryProviderName: 'provider', emergencyContactName: 'name', emergencyContactPhone: 'digits', emergencyContactRelation: 'words',
  },
  appointment_cancel: { cancellationNote: 'text' },
  appointment_reschedule: { date: 'date', startTime: 'time', durationMinutes: 'number', comment: 'text' },
};

/** The field that names a record (for questions). */
const NAME_FIELD: Partial<Record<string, string>> = { medication: 'medicationName', diagnosis: 'description', task: 'title', recall: 'reason', patient: 'lastName' };
/**
 * A drug or a condition nobody said is a made-up record: the call is not run, the provider is asked. (A task's
 * title or a recall's reason nobody said is only a value: removed, the record stays, and the app asks for it.)
 */
const MADE_UP_WITHOUT: Partial<Record<string, string>> = { medication: 'medicationName', diagnosis: 'description' };

/**
 * What the post-check reads on screen: the facts a form never fills by itself. Everything else a form holds may
 * be the application's own doing (a default, an age worked out from the date of birth) — not a model's guess.
 */
const POST_CHECK: Record<string, string[]> = {
  medication: ['medicationName', 'dosage', 'frequency', 'duration'],
  diagnosis: ['description'],
  task: ['title', 'dueDate'],
  recall: ['reason', 'dueDate'],
  appointment: ['date', 'startTime', 'reason'],
  patient: ['firstName', 'lastName', 'dateOfBirth', 'phone'],
};

const PLURAL: Record<RecordKind, string> = { medication: 'medications', diagnosis: 'diagnoses', task: 'tasks', recall: 'recalls', appointment: 'appointments' };
const KIND_OF_PLURAL = Object.fromEntries(Object.entries(PLURAL).map(([k, p]) => [p, k])) as Record<string, RecordKind>;

const empty = (v: unknown) => v === undefined || v === null || v === '';
const text = (v: unknown) => (dayjs.isDayjs(v) ? v.format('YYYY-MM-DD') : String(v));
const lower = (v: unknown) => text(v).trim().toLowerCase();

const ASK_PREFIX = 'Safety Agent: ';

/** The provider points at something on screen or just shown ("move it onto the other slot", "that time"). */
const POINTS_AT_SCREEN = /\b(it|that|this|those|these|same|other|slot)\b/;
/** "three days later", "a week after", "2 days earlier" — counted from a date the application showed. */
const RELATIVE_SHIFT = /\b(\d+|a|an)\s+(days?|weeks?)\s+(later|after|afterwards|earlier|before|sooner)\b/g;

export class SafetyAgent {
  /**
   * Dates and times the application itself showed during the request in progress (its tools' results: the
   * appointments listed, the slot of the one being moved). The provider may point at them, or count from them.
   */
  private seen = { request: '', dates: new Set<string>(), times: new Set<string>() };
  /**
   * The call being checked moves, cancels or changes an EXISTING record: a date or time the application showed
   * may be what the provider points at. A new record never takes one from the screen — only from their words.
   */
  private existingRecord = false;

  /** The Safety Agent's model (Configuration → Agents): a second look at risky calls. None: rules only. */
  private reviewer: SafetyReviewer | null = null;

  /** Calls already sent back once for what the words hold (request + tool): the second time, the provider is asked. */
  private sentBack = new Set<string>();

  constructor(private readonly ctx: SafetyContext) {}

  /**
   * Of what is missing, only what the provider's words hold no trace of — the only things they are asked for.
   * A dose (an amount with a unit), a frequency, a date, a time, a patient's name, or words that can only be a
   * drug, a condition or a reason: when the words hold it, it was said — whichever model failed to report it.
   */
  unsaid(missing: Missing[], used: unknown = []): Missing[] {
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length) return missing;
    const corpus = corpusOf(said);
    // What the call (or plan) already put somewhere is not evidence for something else it lacks: "metformin"
    // is no recall's reason; a date or time on the appointment is not the recall's; "500 mg twice daily" on
    // metformin is not Panadol's. (A dose said once after a LIST of drugs is each drug's — shareListDose has
    // already given it to them, by where each drug was named.)
    const values = scalarsOf(used).map((v) => String(v).toLowerCase());
    const usedWords = new Set(values.flatMap((v) => v.match(/[a-z]+/g) ?? []));
    const ev: Evidence = {
      raw: said.join(' . ').toLowerCase(),
      day: SPECIFIC_DAY.test(corpus.text) || !VAGUE_DAY.test(corpus.text),
      left: this.leftoverWords(said).filter((w) => !usedWords.has(w)),
      doses: [...corpus.text.matchAll(new RegExp(DOSE_SAID.source, 'g'))].map((m) => normDose(m[0])).filter((d) => !values.some((v) => normDose(v) === d)),
      frequencies: [...frequenciesSaid(corpus)].filter((f) => !values.includes(f.toLowerCase())),
      date: [...datesSaid(corpus, this.today())].some((d) => !values.some((v) => v.startsWith(d))),
      time: [...timesSaid(corpus)].some((t) => !values.some((v) => v.startsWith(t))),
    };
    const left = ev.left;
    const out: Missing[] = [];
    for (const m of missing) {
      switch (m.kind) {
        case 'select_patient':
        case 'record_patient':
          if (!this.patientsNamed(corpus).length) out.push(m);
          break;
        case 'existing': {
          // Which drug or condition: a word of one the app holds; anything else: words that name it.
          const known = m.record === 'medication' || m.record === 'diagnosis' ? this.knownWords(m.record) : null;
          if (known ? !left.some((w) => known.has(w)) : !left.length) out.push(m);
          break;
        }
        case 'comment':
          if (!left.length) out.push(m);
          break;
        case 'which_patient':
        case 'what_to_add':
          out.push(m);
          break;
        case 'changes':
          if (!left.length && !ev.doses.length && !ev.frequencies.length && !ev.date && !ev.time) out.push(m);
          break;
        default: {
          const fields = m.fields.filter((f) => !this.evidenceFor(m.kind, f, corpus, ev));
          if (fields.length) out.push({ ...m, fields });
        }
      }
    }
    return out;
  }

  /** Whether the words hold something that can be this field. */
  private evidenceFor(kind: string, field: string, corpus: Corpus, ev: Evidence): boolean {
    const left = ev.left;
    if (kind === 'appointment' && field === 'date' && !ev.day) return false; // "next week" is no day to book
    // "A follow-up appointment", "a check-up": what the visit is for was said.
    if (kind === 'appointment' && field === 'reason' && VISIT_REASON.test(corpus.text)) return true;
    switch (CHECKS[kind]?.[field]) {
      case 'drug':
      case 'diagnosis': {
        // A drug or a condition: a word of one the application knows (the model left out a name that was said).
        const known = this.knownWords(CHECKS[kind]?.[field] === 'drug' ? 'medication' : 'diagnosis');
        return left.some((w) => known.has(w));
      }
      case 'dose':
        return ev.doses.length > 0;
      case 'frequency':
        return ev.frequencies.length > 0;
      case 'date':
        return ev.date;
      case 'dob':
        return datesSaid(corpus, this.today()).size > 0 || /\b\d+\s*(years?|yrs?)\b|\baged?\b/.test(corpus.text);
      case 'time':
        return ev.time;
      case 'duration':
        return /\b\d+\s*(days?|weeks?|months?|years?)\b/.test(corpus.text);
      case 'gender':
        return /\b(male|female|man|woman|boy|girl)\b/.test(corpus.text);
      case 'digits':
        return corpus.digits.length >= 7;
      case 'number':
        return corpus.numbers.length > 0;
      case 'provider':
        return true; // the app's own: the signed-in provider
      default:
        // What a task, recall or visit is for: words in the part of the request that asks for IT ("…, create a
        // task for blood pressure monitoring, recall him in two weeks, …" — the recall's part holds no reason).
        if (CLAUSE_OF[kind]) {
          const own = ev.raw.split(/[,.;!?]|\band then\b|\bthen\b|\band\b(?=\s+(?:add|create|make|book|schedule|recall|remind|set|put)\b)/).filter((c) => CLAUSE_OF[kind]!.test(c));
          const words = new Set(own.flatMap((c) => c.match(/[a-z]+/g) ?? []));
          return left.some((w) => words.has(w) && !this.knownWords('medication').has(w) && !this.knownWords('diagnosis').has(w) && !CLAUSE_OF[kind]!.test(w));
        }
        // A name: words that are none of the rest — a drug's or a condition's name is no other record's.
        return left.some((w) => !this.knownWords('medication').has(w) && !this.knownWords('diagnosis').has(w) && !['follow', 'up', 'followup'].includes(w));
    }
  }

  /** The words of the drug or condition names the application holds (4 letters or more, nothing vague). */
  /** The words name a drug (or a condition) the application knows ("add metformin" — no "medication" said). */
  namesKnown(kind: RecordKind, text: string): boolean {
    const known = this.knownWords(kind);
    return (text.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => known.has(w));
  }

  private knownWords(kind: RecordKind): Set<string> {
    return new Set(
      this.ctx
        .known(kind)
        .flatMap((n) => n.toLowerCase().match(/[a-z]+/g) ?? [])
        .filter((w) => w.length >= 4 && !VAGUE_WORDS.has(w) && !REQUEST_WORDS.has(w) && !DOSING_WORDS.has(w)),
    );
  }

  /**
   * The patient a name said for a call is, when the application can tell: one patient → their full name;
   * nobody, or more than one → what to ask ("I found more than one patient matching "Ahmed": …").
   */
  whichPatient(raw: string): { name: string } | { ask: Missing } | null {
    const found = this.ctx.findPatient?.(raw);
    if (!found) return null;
    if (found.name) return { name: found.name };
    return { ask: { kind: 'which_patient', said: raw.trim(), options: found.options.slice(0, 5), close: found.close } };
  }

  /** The patients whose full name (or MRN) the provider said. */
  private patientsNamed(corpus: Corpus) {
    return this.ctx.patients().filter((p) => coverage(p.fullName, corpus).share === 1 || (!!p.mrn && compactSaid(p.mrn, corpus)));
  }

  /** The words left once the request's own words, amounts, dosing words and people's names are taken out. */
  private leftoverWords(said: string[]): string[] {
    const people = new Set([...this.ctx.patients().map((p) => p.fullName), ...this.ctx.providers()].flatMap((n) => n.toLowerCase().match(/[a-z]+/g) ?? []));
    return (said.join(' ').toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !REQUEST_WORDS.has(w) && !DOSING_WORDS.has(w) && !VAGUE_WORDS.has(w) && !people.has(w) && w.length > 1);
  }

  setReviewer(reviewer: SafetyReviewer | null) {
    this.reviewer = reviewer;
  }

  /** The model the Safety Agent reviews with, or null when it runs on rules alone. */
  get reviewerModel(): string | null {
    return this.reviewer?.modelName ?? null;
  }

  /**
   * After the rules let a call through: a risky one (a change, several records or patients, "not …") gets the
   * model's second look. It can only ask — never change a value. Null: nothing to ask.
   */
  async review(call: ToolCall): Promise<Extract<SafetyVerdict, { kind: 'ask' }> | null> {
    if (!this.reviewer) return null;
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length || !needsReview(call, said)) return null;
    this.ctx.reviewed?.(call, 'started');
    const outcome = await this.reviewer.review(call, said);
    this.ctx.reviewed?.(call, outcome);
    if (outcome.status !== 'problems') return null;
    return { kind: 'ask', result: askResult(reviewQuestion(outcome.problems)), findings: reviewFindings(call.name, outcome.problems) };
  }

  /** A tool's result: the dates and times it showed are application data for the rest of this request. */
  observe(result: ToolResult) {
    this.freshSeen();
    if (result.data === undefined) return;
    let text = '';
    try {
      text = JSON.stringify(result.data);
    } catch {
      return;
    }
    for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) this.seen.dates.add(m[1]);
    for (const m of text.matchAll(/\b(\d{2}:\d{2})\b/g)) this.seen.times.add(m[1]);
  }

  /** A new request starts with nothing seen. */
  private freshSeen() {
    const request = this.ctx.utterances()[0] ?? '';
    if (request !== this.seen.request) this.seen = { request, dates: new Set(), times: new Set() };
  }

  /** Dates the provider pointed at on screen, or counted from one shown ("three days later"). */
  private datesFromScreen(corpus: Corpus): Set<string> {
    this.freshSeen();
    const out = new Set<string>();
    if (!this.existingRecord) return out;
    const shown = new Set([...this.seen.dates, ...(this.ctx.slots?.().dates ?? [])]);
    if (POINTS_AT_SCREEN.test(corpus.text)) shown.forEach((d) => out.add(d));
    for (const m of corpus.text.matchAll(RELATIVE_SHIFT)) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : 1;
      const days = m[2].startsWith('week') ? n * 7 : n;
      const sign = /later|after|afterwards/.test(m[3]) ? 1 : -1;
      shown.forEach((d) => out.add(dayjs(d).add(sign * days, 'day').format('YYYY-MM-DD')));
    }
    if (/\b(next day|day after)\b/.test(corpus.text)) shown.forEach((d) => out.add(dayjs(d).add(1, 'day').format('YYYY-MM-DD')));
    return out;
  }

  /** What the agent is told beside the tool's result when values were removed or corrected. */
  note(findings: SafetyFinding[]): string {
    return safetyNote(findings);
  }

  // ------------------------------------------------------------------------------------- the tool call

  /** Before a tool runs: keep what was said, correct what can be corrected from it, remove the rest — or ask. */
  check(call: ToolCall): SafetyVerdict {
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length) return { kind: 'allow', findings: [] }; // not from the provider's words (a button, the screen)
    const corpus = corpusOf(said);
    // "delete it", "select him again": what is pointed to was named a moment ago — by the provider.
    const pointsBack = /\b(it|that|this|those|these|them|him|her|he|she|same|again|one)\b/.test(corpus.text);
    const refs = pointsBack ? corpusOf([...(this.ctx.recent?.() ?? []), ...said]) : corpus;
    const findings: SafetyFinding[] = [];
    const args = { ...call.arguments } as Record<string, unknown>;
    const tool = call.name;
    const ask: Missing[] = [];
    const inPlaceMissing: Missing[] = [];
    const inPlace = this.ctx.inPlace?.(tool === 'create_patient' ? 'patient' : 'records') ?? false;

    // The operation first: a call that ADDS when the provider asked to delete, change or see is never run —
    // whatever its values. (Its own required fields are not even looked at: they are an add's, not this.)
    // The latest utterance that says what to do decides it: "delete all medications" said after an unanswered
    // "add medication" is a delete; an answer without a verb ("500 mg twice daily") belongs to the request before.
    const heard = [...said].reverse().find((u) => detectOperation(u).operation !== 'other') ?? said.join(' ');
    const asked = detectOperation(heard).operation;
    if (/^(add_|create_patient$)/.test(tool) && ['delete_one', 'delete_all', 'update'].includes(asked) && !saysAdd(heard)) {
      const use = asked === 'update' ? 'update_record (or edit_patient), with only the fields being changed' : `delete_record${asked === 'delete_all' ? ' with all: true' : ''} (or delete_patient)`;
      const what = { delete_one: 'delete', delete_all: 'delete all of them', update: 'change an existing record' }[asked as 'delete_one' | 'delete_all' | 'update'];
      return {
        kind: 'refuse',
        result: { ok: false, message: `Not run: the provider asked to ${what}, not to add anything. Use ${use} — and ask nothing about an add's fields.` },
        findings: [{ tool, field: 'operation', value: tool, action: 'removed', reason: `the provider asked to ${what}, not to add` }],
      };
    }
    this.existingRecord = /^(reschedule|cancel)_(my|patient)_appointment$|^update_record$/.test(tool);

    // A new record: every value checked, then complete — or nothing opens (no page change, no form) and the
    // provider is asked, in one question, for everything still missing.
    const recordList = (kind: RecordKind | 'patient', items: unknown, path: string) => {
      if (!Array.isArray(items)) return items;
      return items.map((item, i) => {
        const where = `${path} ${i + 1}`;
        const checked = this.record(kind, (item ?? {}) as FieldValues, corpus, tool, where, findings);
        this.routeFromWords(kind, checked.values, corpus, tool, where, findings);
        const missing = missingFrom(kind, checked.values);
        const name = NAME_FIELD[kind] && !empty(checked.values[NAME_FIELD[kind]!]) ? text(checked.values[NAME_FIELD[kind]!]) : undefined;
        const have = kind === 'medication' ? [name, checked.values.dosage, checked.values.frequency].filter((v) => !empty(v)).map(text).join(' ') || undefined : undefined;
        // A made-up drug or condition is never opened, wherever the provider is.
        if (missing.length && (!inPlace || checked.lostName)) ask.push({ kind, name, fields: missing, have });
        // On Summary the form asks for what is missing — but not for what the provider already said.
        else if (missing.length) inPlaceMissing.push({ kind, name, fields: missing, have });
        return checked.values;
      });
    };
    /**
     * Records need a patient: the selected one, one named in the call, or one per record. A call naming none
     * while the provider named exactly one patient — not the selected one — gets that patient: theirs, said.
     */
    const needsPatient = (lists: unknown[], put: (name: string) => void, of: RecordKind[] = []) => {
      const named = !empty(args.patient) || (Array.isArray(args.for_patients) && args.for_patients.length > 0);
      const perRecord = lists.some((l) => Array.isArray(l) && l.length > 0 && l.every((r) => !empty((r as FieldValues | undefined)?.patient)));
      const some = lists.some((l) => Array.isArray(l) && l.some((r) => !empty((r as FieldValues | undefined)?.patient)));
      if (named || perRecord || some) return;
      const said = this.patientsNamed(corpus);
      const selected = this.ctx.selectedPatient();
      if (said.length === 1 && said[0].id !== selected?.id) {
        put(said[0].fullName);
        findings.push({ tool, field: 'patient', value: '', action: 'corrected', corrected: said[0].fullName, reason: 'the patient the provider named' });
        return;
      }
      if (!inPlace && !selected) ask.unshift({ kind: 'record_patient', of });
    };

    // A dose said once after a list of drugs: each drug's (before anything about the records is decided).
    for (const key of ['medications'] as const) {
      if (/^add_(medications|care_plan)$/.test(tool) && Array.isArray(args[key])) {
        const meds = (args[key] as FieldValues[]).map((m) => ({ ...m }));
        const shared = this.shareListDose(meds);
        if (shared.length) {
          args[key] = meds;
          findings.push(...shared.map((f) => ({ ...f, tool })));
        }
      }
    }
    if (/^add_(medications|diagnoses|tasks|recalls|appointments)$/.test(tool)) {
      const plural = tool.slice(4);
      args[plural] = recordList(KIND_OF_PLURAL[plural], args[plural], KIND_OF_PLURAL[plural]);
      this.patientList(args, corpus, tool, findings);
      needsPatient(
        [args[plural]],
        (name) => {
          if (Array.isArray(args[plural])) args[plural] = (args[plural] as FieldValues[]).map((r) => ({ ...r, patient: name }));
        },
        [KIND_OF_PLURAL[plural] as RecordKind],
      );
    } else if (tool === 'add_care_plan') {
      for (const kind of RECORD_KINDS) if (args[PLURAL[kind]] !== undefined) args[PLURAL[kind]] = recordList(kind, args[PLURAL[kind]], kind);
      this.patientArg(args, 'patient', corpus, tool, findings);
      this.patientList(args, corpus, tool, findings);
      needsPatient(
        RECORD_KINDS.map((kind) => args[PLURAL[kind]]),
        (name) => {
          args.patient = name;
        },
        RECORD_KINDS.filter((kind) => Array.isArray(args[PLURAL[kind]]) && (args[PLURAL[kind]] as unknown[]).length > 0),
      );
    } else if (tool === 'create_patient') {
      const checked = this.record('patient', args as FieldValues, corpus, tool, 'new patient', findings);
      Object.keys(args).forEach((k) => delete args[k]);
      Object.assign(args, checked.values);
      const missing = missingFrom('patient', checked.values);
      if (missing.length && !inPlace) ask.push({ kind: 'patient', fields: missing });
    } else if (tool === 'select_patient' || tool === 'edit_patient' || tool === 'delete_patient') {
      const patient = this.patientArg(args, 'patient', refs, tool, findings);
      const position = this.positionArg(args, corpus, tool, findings);
      if (tool === 'select_patient' && !patient && !position) ask.push({ kind: 'select_patient' });
      if (tool === 'edit_patient' && args.changes && typeof args.changes === 'object') {
        args.changes = this.record('patient', args.changes as FieldValues, corpus, tool, 'change', findings).values;
      }
    } else if (tool === 'update_record' || tool === 'delete_record' || tool === 'list_records') {
      const kind = args.kind as RecordKind;
      this.patientArg(args, 'patient', refs, tool, findings);
      const all = tool === 'delete_record' && args.all === true;
      if (tool === 'list_records') {
        // Seeing records needs only the patient: nothing clinical.
      } else if (all && saysAll(heard)) {
        // Delete ALL: the scope is the whole kind — no record, no field. The app confirms before deleting.
        if (!empty(args.record)) {
          findings.push({ tool, field: 'record', value: text(args.record), action: 'removed', reason: 'all of them were asked for, not one' });
          delete args.record;
        }
      } else if (all) {
        findings.push({ tool, field: `${kind}`, value: 'all', action: 'asked', reason: `"all" was not said` });
        ask.push({ kind: 'existing', record: kind, verb: 'delete' });
      } else if (!this.existingSaid(kind, args.record, refs)) {
        findings.push({ tool, field: `${kind}`, value: text(args.record ?? ''), action: 'asked', reason: `which ${kind} was not said` });
        ask.push({ kind: 'existing', record: kind, verb: tool === 'delete_record' ? 'delete' : 'change' });
      } else if (tool === 'update_record' && args.changes && typeof args.changes === 'object') {
        args.changes = this.record(kind, args.changes as FieldValues, corpus, tool, 'change', findings).values;
      }
    } else if (tool === 'fill_open_form') {
      const form = this.ctx.openFormId();
      for (const [field, value] of Object.entries(args)) {
        const kind = this.kindForField(form, field);
        if (!kind) continue;
        const verdict = field === 'patient' ? this.patientSaid(value, corpus) : this.valueSaid(kind, field, value, corpus);
        this.apply(args, field, value, verdict, tool, field, findings);
      }
    } else if (/^reschedule_(my|patient)_appointment$/.test(tool)) {
      const map: Record<string, [string, string]> = { to_date: ['appointment_reschedule', 'date'], to_time: ['appointment_reschedule', 'startTime'], duration_minutes: ['appointment_reschedule', 'durationMinutes'], comment: ['appointment_reschedule', 'comment'] };
      for (const [arg, [form, field]] of Object.entries(map)) if (!empty(args[arg])) this.apply(args, arg, args[arg], this.valueSaid(form, field, args[arg], corpus), tool, field, findings);
    } else if (/^cancel_(my|patient)_appointment$/.test(tool)) {
      if (!empty(args.note)) this.apply(args, 'note', args.note, this.valueSaid('appointment_cancel', 'cancellationNote', args.note, corpus), tool, 'note', findings);
    } else if (tool === 'inbox_add_comment') {
      if (!empty(args.text) && !this.textSaid(String(args.text), corpus)) {
        findings.push({ tool, field: 'comment', value: String(args.text), action: 'asked', reason: 'not said by the provider' });
        ask.push({ kind: 'comment' });
      }
    } else {
      return { kind: 'allow', findings: [] };
    }

    // A patient named that is nobody on file, or more than one ("Ahmed", "John"): asked which — before anything
    // is searched, opened or selected.
    const patientNames = new Set<string>();
    if (typeof args.patient === 'string' && args.patient.trim()) patientNames.add(args.patient);
    for (const value of Object.values(args)) {
      if (!Array.isArray(value)) continue;
      for (const r of value) if (r && typeof r === 'object' && typeof (r as FieldValues).patient === 'string' && String((r as FieldValues).patient).trim()) patientNames.add(String((r as FieldValues).patient));
    }
    if (Array.isArray(args.for_patients)) for (const p of args.for_patients) if (typeof p === 'string' && p.trim()) patientNames.add(p);
    for (const raw of patientNames) {
      const which = this.whichPatient(raw);
      if (which && 'ask' in which) {
        ask.unshift(which.ask);
        findings.push({ tool, field: 'patient', value: raw, action: 'asked', reason: which.ask.kind === 'which_patient' && which.ask.options.length ? 'more than one patient matches' : 'no patient matches' });
      }
    }

    // On Summary: a value the call left out that the provider DID say goes back to the agent once — the form
    // would otherwise ask the provider for it, and the agent may not answer for them.
    if (!ask.length && inPlaceMissing.length) {
      const key = `${said.join(' | ')}#${tool}#inplace`;
      const unsaid = this.unsaid(inPlaceMissing, args);
      const overlooked = inPlaceMissing
        .map((m) => ('fields' in m ? { ...m, fields: m.fields.filter((f) => !unsaid.some((u) => 'fields' in u && u.kind === m.kind && u.name === m.name && u.fields.includes(f))) } : m))
        .filter((m) => 'fields' in m && m.fields.length);
      if (overlooked.length && !this.sentBack.has(key)) {
        if (this.sentBack.size > 50) this.sentBack.clear();
        this.sentBack.add(key);
        const what = overlooked.map((m) => ('fields' in m ? `${m.kind}${m.name ? ` "${m.name}"` : ''}: ${m.fields.join(', ')}` : m.kind)).join('; ');
        return {
          kind: 'refuse',
          result: { ok: false, message: `Not run — this call leaves out what the provider said: ${what}. Read SAID again and call ${tool} again with every value they said (a date as YYYY-MM-DD from CONTEXT's dates). Leave out only what they did not say.` },
          findings: [...findings, { tool, field: 'call', value: tool, action: 'removed', reason: 'it left out values the provider said' }],
        };
      }
    }

    if (ask.length) {
      const unsaid = this.unsaid(ask, args);
      const key = `${said.join(' | ')}#${tool}`;
      // Something the call lacks is in the provider's words: the agent overlooked it — it gets the call back
      // once, to add it from the words. The provider is never asked for what they already said.
      if (JSON.stringify(unsaid) !== JSON.stringify(ask) && !this.sentBack.has(key)) {
        if (this.sentBack.size > 50) this.sentBack.clear();
        this.sentBack.add(key);
        const names = this.patientsNamed(corpusOf(said)).map((p) => p.fullName);
        const what = ask
          .map((m) => (m.kind === 'record_patient' || m.kind === 'select_patient' ? `the patient${names.length ? ` (the provider named ${names.join(', ')})` : ''}` : 'fields' in m ? `${m.kind === 'patient' ? 'the new patient' : `${m.kind}${m.name ? ` "${m.name}"` : ''}`}: ${m.fields.join(', ')}` : m.kind === 'existing' ? `which ${m.record}` : m.kind))
          .join('; ');
        return {
          kind: 'refuse',
          result: { ok: false, message: `Not run — this call leaves out what the provider said: ${what}. Read SAID again and call ${tool} again with every value they said, in their words (the patient in patient). Leave out only what they did not say.` },
          findings: [...findings, { tool, field: 'call', value: tool, action: 'removed', reason: 'it left out values the provider said' }],
        };
      }
      for (const f of findings) if (f.action === 'removed') f.action = 'asked';
      return { kind: 'ask', result: askResult(questionFor(unsaid.length ? unsaid : ask)), findings };
    }
    return findings.length ? { kind: 'rewrite', args, findings } : { kind: 'allow', findings };
  }

  /** After a tool prepared a new record for confirmation: what is on screen must hold only what was said. */
  after(call: ToolCall, result: ToolResult): SafetyVerdict | null {
    if (!result.ok || !/^(add_|create_patient$|fill_open_form$)/.test(call.name)) return null;
    this.existingRecord = false; // new records: only the provider's words
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length) return null;
    const corpus = corpusOf(said);
    const findings: SafetyFinding[] = [];
    const missing: Missing[] = [];
    for (const { kind, values } of this.ctx.staged()) {
      const facts = POST_CHECK[kind];
      if (!facts) continue;
      const bad: string[] = [];
      for (const field of facts) {
        const raw = values[field];
        if (empty(raw)) continue;
        const value = this.asStored(kind, field, raw);
        if (this.isDefault(kind, field, value)) continue;
        const verdict = this.valueSaid(kind, field, value, corpus);
        if (!verdict.ok) {
          bad.push(field);
          findings.push({ tool: call.name, field: `${kind} · ${field}`, value: text(value), action: 'asked', reason: verdict.reason });
        }
      }
      const named = NAME_FIELD[kind] && !bad.includes(NAME_FIELD[kind]!) ? values[NAME_FIELD[kind]!] : undefined;
      if (bad.length) missing.push({ kind: kind as RecordKind, name: empty(named) ? undefined : text(named), fields: bad });
    }
    if (!findings.length) return null;
    this.ctx.discardStaged();
    return { kind: 'ask', result: askResult(questionFor(missing)), findings };
  }

  // ------------------------------------------------------------------------------------ for the Planning Agent

  /**
   * What a plan may keep of a record: the same checks as a tool call — each value kept, corrected from the
   * provider's words, or removed (then it is asked for). The Planning Agent never passes on a value it made up.
   */
  vetRecord(kind: RecordKind | 'patient', values: FieldValues, where: string): { values: FieldValues; findings: SafetyFinding[] } {
    const findings: SafetyFinding[] = [];
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length) return { values, findings };
    const corpus = corpusOf(said);
    const checked = this.record(kind, values, corpus, 'plan', where, findings).values;
    this.routeFromWords(kind, checked, corpus, 'plan', where, findings);
    return { values: checked, findings };
  }

  /** The existing record a plan names (to change or delete): kept when the provider named it — or pointed back to it. */
  vetRecordName(kind: RecordKind, value: string, where: string): { value: string | undefined; finding?: SafetyFinding } {
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length || !value) return { value };
    const pointsBack = /\b(it|that|this|those|these|them|same|one)\b/.test(corpusOf(said).text);
    const corpus = pointsBack ? corpusOf([...(this.ctx.recent?.() ?? []), ...said]) : corpusOf(said);
    if (this.existingSaid(kind, value, corpus)) return { value };
    return { value: undefined, finding: { tool: 'plan', field: `${where} · record`, value, action: 'removed', reason: `the ${kind} "${value}" was not named by the provider` } };
  }

  /** A patient a plan names: kept when said (or selected — not when selecting), narrowed to the part said, or dropped. */
  vetPatient(value: string, selecting = false): { value: string | undefined; finding?: SafetyFinding } {
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length || !value) return { value };
    const verdict = this.patientSaid(value, corpusOf(said), selecting);
    if (verdict.ok) return { value: verdict.corrected === undefined ? value : String(verdict.corrected) };
    return { value: undefined, finding: { tool: 'plan', field: 'patient', value, action: 'removed', reason: verdict.reason } };
  }

  // --------------------------------------------------------------------------------------------- values

  /** One record's values: each kept, corrected or removed. `lostName`: the record's own name was made up. */
  private record(kind: RecordKind | 'patient', item: FieldValues, corpus: Corpus, tool: string, where: string, findings: SafetyFinding[]) {
    const values: FieldValues = { ...item };
    let lostName = false;
    for (const [rawField, value] of Object.entries(item)) {
      if (empty(value)) continue;
      const field = FieldRegistry.resolveField(kind, rawField)?.name ?? rawField;
      if (field === 'patient') {
        this.apply(values, rawField, value, this.patientSaid(value, corpus), tool, `${where} · patient`, findings);
        continue;
      }
      if (!CHECKS[kind]?.[field]) continue;
      const verdict = this.isDefault(kind, field, value) ? { ok: true as const } : this.valueSaid(kind, field, value, corpus);
      const removed = this.apply(values, rawField, value, verdict, tool, `${where} · ${field}`, findings);
      if (removed && field === MADE_UP_WITHOUT[kind]) lostName = true;
    }
    return { values, lostName };
  }

  /** Nothing left of a value once the patient, the action, the record kind and the time are taken out of it. */
  private restatesRequest(value: string): boolean {
    const names = new Set(this.ctx.patients().flatMap((p) => p.fullName.toLowerCase().split(/\s+/)));
    const words = value.toLowerCase().match(/[a-z]+/g) ?? [];
    return words.length > 0 && words.every((w) => names.has(w) || REQUEST_WORDS.has(w) || VAGUE_WORDS.has(w));
  }

  /** A drug's route not in the call but said ("by mouth", "IV"), one route for the request: it is the provider's. */
  private routeFromWords(kind: RecordKind | 'patient', values: FieldValues, corpus: Corpus, tool: string, where: string, findings: SafetyFinding[]) {
    if (kind !== 'medication' || !empty(values.route)) return;
    const said = routesSaid(corpus);
    if (said.length !== 1) return;
    values.route = said[0];
    findings.push({ tool, field: `${where} · route`, value: '', action: 'corrected', corrected: said[0], reason: 'the route the provider said' });
  }

  /** Keep, correct or remove one value. True when it was removed. */
  private apply(target: Record<string, unknown>, key: string, value: unknown, verdict: Verdict, tool: string, field: string, findings: SafetyFinding[]): boolean {
    if (verdict.ok && verdict.corrected === undefined) return false;
    if (verdict.ok) {
      target[key] = verdict.corrected;
      findings.push({ tool, field, value: text(value), action: 'corrected', corrected: String(verdict.corrected), reason: verdict.reason ?? 'corrected to what was said' });
      return false;
    }
    delete target[key];
    findings.push({ tool, field, value: text(value), action: 'removed', reason: verdict.reason });
    return true;
  }

  /** Was this value of this field said (or is it the application's own)? */
  valueSaid(kind: string, field: string, value: unknown, corpus: Corpus): Verdict {
    const check = CHECKS[kind]?.[field];
    if (!check || empty(value) || value === false) return { ok: true };
    const v = text(value);
    const notSaid = (what = `"${v}" was not said by the provider`): Verdict => ({ ok: false, reason: what });
    // "The appropriate antibiotic", "the usual dose", "the medication we discussed": nothing specific was said.
    if ((check === 'drug' || check === 'diagnosis' || check === 'subject') && vagueOnly(v)) return notSaid(`"${v}" names nothing specific — the provider has to say which`);
    switch (check) {
      case 'drug':
      case 'diagnosis':
        return this.clinicalNameSaid(check === 'drug' ? 'medication' : 'diagnosis', v, corpus) ? { ok: true } : notSaid();
      case 'name':
        return coverage(v, corpus).share === 1 ? { ok: true } : notSaid();
      case 'text':
        return this.textSaid(v, corpus) ? { ok: true } : notSaid();
      case 'subject':
        // What a task, recall or visit is FOR: said — and more than the request itself ("Recall Luke King
        // after two weeks" names who and when, not what for).
        if (!this.textSaid(v, corpus)) return notSaid();
        return this.restatesRequest(v) ? notSaid(`"${v}" is the request itself — what it is for was not said`) : { ok: true };
      case 'dose':
        if (!/[a-z]/i.test(v)) return notSaid(`the dose "${v}" has no unit — 500 what?`);
        return doseSaid(v, corpus) ? { ok: true } : notSaid(`the dose "${v}" (amount and unit) was not said`);
      case 'frequency': {
        const said = [...frequenciesSaid(corpus)];
        if (said.some((f) => f.toLowerCase() === v.toLowerCase())) return { ok: true };
        // One frequency said, another given: the provider's is the one.
        if (said.length === 1) return { ok: true, corrected: said[0], reason: `the provider said "${said[0]}"` };
        return notSaid(`how often ("${v}") was not said`);
      }
      case 'route':
      case 'gender':
        return optionSaid(check, v, corpus) ? { ok: true } : notSaid();
      case 'duration':
        return durationSaid(v, corpus) ? { ok: true } : notSaid(`the duration "${v}" was not said`);
      case 'date': {
        if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return { ok: true }; // not a date at all: the form refuses it and says why
        const date = dayjs(v).format('YYYY-MM-DD');
        // An appointment needs a day: "next week" names none (a recall "in two weeks" does).
        if (kind === 'appointment' && field === 'date' && VAGUE_DAY.test(corpus.text) && !SPECIFIC_DAY.test(corpus.text)) return notSaid('which day was not said');
        const readings = [...datesSaid(corpus, this.today())].sort();
        if (readings.includes(date) || this.datesFromScreen(corpus).has(date)) return { ok: true };
        // A day was said, and the model worked out another date ("next Monday" given as a Tuesday): the provider's
        // day — its nearest reading — is the one; the form shows it for them to review.
        if (readings.length) return { ok: true, corrected: readings[0], reason: `the provider said a day that is ${readings[0]}, not ${date}` };
        return notSaid(`no date said is ${v}`);
      }
      case 'dob': {
        if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return { ok: true };
        if (datesSaid(corpus, this.today()).has(dayjs(v).format('YYYY-MM-DD'))) return { ok: true };
        // A date of birth the application works out from a spoken age ("45 years old").
        const age = this.today().diff(dayjs(v), 'year');
        return corpus.numbers.some((n) => Math.abs(n - age) <= 1) && /\b(years?|yrs?|age|aged|old)\b/.test(corpus.text) ? { ok: true } : notSaid(`the date of birth ${v} was not said`);
      }
      case 'time':
        if (!/^\d{2}:\d{2}/.test(v)) return { ok: true }; // not a time at all: the form refuses it and says why
        if (timesSaid(corpus).has(v.slice(0, 5))) return { ok: true };
        // A time the application showed, pointed at ("onto the other slot", "the same time").
        this.freshSeen();
        return this.existingRecord && POINTS_AT_SCREEN.test(corpus.text) && (this.seen.times.has(v.slice(0, 5)) || (this.ctx.slots?.().times ?? []).includes(v.slice(0, 5))) ? { ok: true } : notSaid(`no time said is ${v}`);
      case 'number':
        return corpus.numbers.includes(Number(v)) ? { ok: true } : notSaid();
      case 'digits':
        return digitsSaid(v, corpus) ? { ok: true } : notSaid();
      case 'compact':
        return compactSaid(v, corpus) ? { ok: true } : notSaid();
      case 'words':
        return coverage(v.replace(/\+/g, ' positive').replace(/-$/, ' negative'), corpus).share === 1 || compactSaid(v, corpus) ? { ok: true } : notSaid();
      case 'provider':
        return this.providerSaid(v, corpus) ? { ok: true } : notSaid(`the provider "${v}" was not said`);
      case 'prn':
        return PRN_SAID(corpus) ? { ok: true } : notSaid('"as needed" was not said');
      case 'telehealth':
        return TELEHEALTH_SAID(corpus) ? { ok: true } : notSaid('a telehealth visit was not said');
    }
  }

  /** A drug or condition: every word said (one letter misheard at most) — or the application's own name for one, its key word said. */
  private clinicalNameSaid(kind: RecordKind, value: string, corpus: Corpus): boolean {
    const cov = coverage(value, corpus, true);
    if (cov.share === 1 && cov.words.length) return true;
    const known = this.ctx.known(kind).some((name) => name.toLowerCase() === value.toLowerCase());
    return known && cov.words.some((w) => w.length >= 5 && wordSaid(w, corpus, true));
  }

  /** Free text (a task, a reason, a comment): nearly all of its words said, in the provider's own words. */
  private textSaid(value: string, corpus: Corpus): boolean {
    const cov = coverage(value, corpus);
    if (!cov.words.length) return true;
    return cov.words.length <= 2 ? cov.share === 1 : cov.share >= 0.75;
  }

  private providerSaid(value: string, corpus: Corpus): boolean {
    const own = this.ctx.providerName();
    if (own && lower(own) === lower(value)) return true; // the signed-in provider: the default
    const bare = lower(value).replace(/^dr\.?\s+/, '');
    // A patient's name is no provider ("a task for Zoe Hill" is FOR the patient, not assigned to her).
    if (this.ctx.patients().some((p) => lower(p.fullName) === bare)) return false;
    const words = bare.split(/\s+/).filter((w) => w.length >= 3);
    const providers = this.ctx.providers().map(lower);
    if (providers.length && !providers.some((p) => words.some((w) => p.includes(w)))) return false;
    return words.some((w) => wordSaid(w, corpus));
  }

  /**
   * "Metformin, Panadol, gabapentin, rituximab 500 mg twice daily for 30 days": a dose said ONCE, after a list of
   * drugs, is each drug's — with its frequency and duration. A drug of the list without them gets them from the
   * one that has them, when exactly one dose was said and the drug is named before it. "Metformin 500 mg and
   * Panadol" is not a list before the dose: Panadol gets nothing (it is asked for).
   */
  shareListDose(meds: FieldValues[], where = 'medication'): SafetyFinding[] {
    const said = this.ctx.utterances().filter(Boolean);
    if (!said.length || meds.length < 2) return [];
    const text = said.join(' ').toLowerCase();
    const doses = [...text.matchAll(new RegExp(DOSE_SAID.source, 'g'))];
    if (new Set(doses.map((m) => normDose(m[0]))).size !== 1) return [];
    const at = doses[0].index ?? 0;
    // The values said after the list: from the drug the model gave them to — or, when it gave them to none,
    // from the words themselves (one dose, one frequency, one duration said).
    const corpus = corpusOf(said);
    const freqs = [...frequenciesSaid(corpus)];
    const durations = [...text.matchAll(/\b(\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty)\s+(days?|weeks?|months?)\b/g)].map((m) => m[0]);
    const fromWords: FieldValues = { dosage: normDose(doses[0][0]), ...(freqs.length === 1 ? { frequency: freqs[0] } : {}), ...(new Set(durations).size === 1 ? { duration: durations[0] } : {}) };
    const source = meds.find((m) => !empty(m.dosage) && normDose(String(m.dosage)) === normDose(doses[0][0])) ?? fromWords;
    const findings: SafetyFinding[] = [];
    meds.forEach((m, i) => {
      if (m === source || !empty(m.dosage)) return;
      const drug = String(m.medicationName ?? m.name ?? '').trim().toLowerCase();
      const named = drug ? text.indexOf(drug) : -1;
      // Named after the dose: not part of the list before it. (A drug of the list the model did not name is.)
      if (drug && (named < 0 || named > at)) return;
      for (const field of ['dosage', 'frequency', 'duration'] as const) {
        if (empty(m[field]) && !empty(source[field])) {
          m[field] = source[field];
          findings.push({ tool: 'list', field: `${where} ${i + 1} · ${field}`, value: '', action: 'corrected', corrected: String(source[field]), reason: 'said once after the list of drugs — each drug\'s' });
        }
      }
    });
    return findings;
  }

  /** The patients whose full name (or MRN) the provider said in this request. */
  namedPatients(): Array<{ id: string; fullName: string }> {
    const said = this.ctx.utterances().filter(Boolean);
    return said.length ? this.patientsNamed(corpusOf(said)) : [];
  }

  /**
   * A patient named in a call: the selected one, or one whose name (or MRN) was said. `selecting`: the call
   * selects a patient — "select patient" is never answered with the one already on screen.
   */
  private patientSaid(value: unknown, corpus: Corpus, selecting = false): Verdict {
    const raw = text(value).replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!raw) return { ok: true };
    const selected = selecting ? null : this.ctx.selectedPatient();
    if (selected && (raw === selected.id || lower(raw) === lower(selected.name))) return { ok: true }; // the patient on screen
    const known = this.ctx.patients().find((p) => p.id === raw || (p.mrn && lower(p.mrn) === lower(raw)));
    if (known && (compactSaid(raw, corpus) || coverage(known.fullName, corpus).share > 0)) return { ok: true };
    const cov = coverage(raw, corpus);
    if (cov.words.length && cov.share === 1) return { ok: true };
    // Part of the name was said ("select James"): only that part goes on — the application finds who it is, or asks.
    const said = cov.words.filter((w) => !cov.unsaid.includes(w));
    if (said.length) return { ok: true, corrected: said.join(' '), reason: 'only this part of the name was said' };
    return { ok: false, reason: `the patient "${raw}" was not said` };
  }

  private patientArg(args: Record<string, unknown>, key: string, corpus: Corpus, tool: string, findings: SafetyFinding[]): boolean {
    if (empty(args[key])) return false;
    return !this.apply(args, key, args[key], this.patientSaid(args[key], corpus, tool === 'select_patient'), tool, 'patient', findings);
  }

  private patientList(args: Record<string, unknown>, corpus: Corpus, tool: string, findings: SafetyFinding[]) {
    if (!Array.isArray(args.for_patients)) return;
    const kept: string[] = [];
    for (const name of args.for_patients as string[]) {
      const verdict = this.patientSaid(name, corpus);
      if (verdict.ok) kept.push(String(verdict.corrected ?? name));
      else findings.push({ tool, field: 'for_patients', value: String(name), action: 'removed', reason: verdict.reason });
    }
    args.for_patients = kept.length ? kept : undefined;
  }

  private positionArg(args: Record<string, unknown>, corpus: Corpus, tool: string, findings: SafetyFinding[]): boolean {
    if (empty(args.list_position)) return false;
    if (positionSaid(Number(args.list_position), corpus)) return true;
    findings.push({ tool, field: 'list_position', value: String(args.list_position), action: 'removed', reason: 'no position in the list was said' });
    delete args.list_position;
    return false;
  }

  /** An existing record named in a change or a delete: by words said, or by an id whose record's name was said. */
  private existingSaid(kind: RecordKind, record: unknown, corpus: Corpus): boolean {
    const raw = text(record ?? '').trim();
    if (!raw) return false;
    const label = this.ctx.recordLabel(kind, raw);
    const name = label ?? raw;
    const cov = coverage(name, corpus, kind === 'medication' || kind === 'diagnosis');
    return cov.words.length > 0 && cov.share > 0;
  }

  /** A form field: the open form's kind, or — in the care plan — the record kind that has a field of that name. */
  private kindForField(form: string | null, field: string): string | null {
    if (form && CHECKS[form]) return form;
    if (field === 'patient') return 'medication';
    return RECORD_KINDS.find((k) => CHECKS[k][FieldRegistry.resolveField(k, field)?.name ?? field]) ?? null;
  }

  /** A value as the form holds it, as the checks read it (dates YYYY-MM-DD, times HH:mm). */
  private asStored(kind: string, field: string, raw: unknown): unknown {
    if (!dayjs.isDayjs(raw)) return raw;
    const type = FieldRegistry.getForm(kind)?.fields.find((f) => f.name === field)?.type;
    return type === 'time' ? raw.format('HH:mm') : raw.format('YYYY-MM-DD');
  }

  /** The application's own value for a field of a new record (route Oral, a task due in a week, the signed-in provider). */
  private isDefault(kind: string, field: string, value: unknown): boolean {
    const own = this.ctx.providerName();
    if (own && ['providerName', 'prescribedBy', 'diagnosedBy', 'assignedTo'].includes(field) && lower(value) === lower(own)) return true;
    if (!(RECORD_KINDS as readonly string[]).includes(kind)) return false;
    const d = defaultValues(kind as RecordKind, own ?? '')[field];
    if (d === undefined) return false;
    return lower(d) === lower(value) || (dayjs.isDayjs(d) && dayjs(text(value)).isSame(d, 'day'));
  }

  private today() {
    return this.ctx.today?.() ?? dayjs();
  }
}

type Verdict = { ok: true; corrected?: unknown; reason?: string } | { ok: false; reason: string };

/** The tool call is not run: the provider is asked instead — a fixed question, never a suggestion. */
interface Evidence {
  /** What was said, as said (its punctuation splits it into parts). */
  raw: string;
  /** An appointment's day was said (not only "next week"). */
  day: boolean;
  left: string[];
  doses: string[];
  frequencies: string[];
  date: boolean;
  time: boolean;
}

/** Every plain value inside a call's arguments or a plan (lists and records included). */
function scalarsOf(v: unknown): Array<string | number | boolean> {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(scalarsOf);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(scalarsOf);
  return [v as string | number | boolean];
}

/** "500 milligrams", "500mg", "500 MG" → "500 mg". */
const normDose = (s: string) => {
  const m = String(s).toLowerCase().match(/(\d+(?:\.\d+)?)\s*([a-z]+)/);
  if (!m) return '';
  const unit = { milligram: 'mg', milligrams: 'mg', microgram: 'mcg', micrograms: 'mcg', gram: 'g', grams: 'g', gm: 'g' }[m[2]] ?? m[2];
  return `${m[1]} ${unit}`;
};

/** The words that ask for a task, a recall or a visit — the part of a request around them is about that record. */
const CLAUSE_OF: Partial<Record<string, RegExp>> = {
  task: /\b(tasks?|to ?-?do)\b/,
  recall: /\b(recall|recalls|remind|reminder)\b/,
  appointment: /\b(appointments?|visits?|book|schedule)\b/,
};

/** Words that say what a visit is for. */
const VISIT_REASON = /\b(follow ?-?up|check ?-?up|review|consult(ation)?|physical|annual|vaccination|screening)\b/;

/** An amount with its unit: a dose was said. */
const DOSE_SAID = /\b\d+(?:\.\d+)?\s*(mg|mcg|g|gm|grams?|ml|milligrams?|micrograms?|units?|iu|puffs?|tablets?|tabs?|capsules?|caps?|drops?|sprays?)\b/;
/** Words of how much, how often and how a drug is given — never a drug, a condition or a reason. */
const DOSING_WORDS: ReadonlySet<string> = new Set(
  (
    'mg mcg g gm gram grams ml milligram milligrams microgram micrograms unit units iu puff puffs tablet tablets tab tabs capsule capsules cap caps drop drops spray sprays ' +
    'once twice thrice daily times time bid tid qid od bd prn needed as hourly hours hour every morning mornings evening night nightly bedtime ' +
    'oral orally mouth by iv im intravenous intravenously intramuscular subcutaneous topical sublingual inhaled per dr doctor'
  ).split(' '),
);

function askResult(question: string): ToolResult {
  return {
    ok: false,
    awaitUser: true,
    final: true,
    speak: true,
    message: question,
    data: { safety: `${ASK_PREFIX}the provider did not say this — they are asked. Never fill it in yourself.` },
  };
}

/** What the agent is told when values were removed or corrected (beside the tool's own result). */
export function safetyNote(findings: SafetyFinding[]): string {
  const removed = findings.filter((f) => f.action === 'removed');
  const corrected = findings.filter((f) => f.action === 'corrected');
  const parts: string[] = [];
  if (removed.length) parts.push(`removed ${removed.map((f) => `${f.field} "${f.value}"`).join(', ')} — the provider did not say ${removed.length === 1 ? 'it' : 'them'}; the app asks for what is required. Never fill ${removed.length === 1 ? 'it' : 'them'} in yourself`);
  if (corrected.length) parts.push(`corrected ${corrected.map((f) => `${f.field} "${f.value}" → "${f.corrected}"`).join(', ')} to what the provider said`);
  return parts.length ? `(${ASK_PREFIX}${parts.join('; ')}.)` : '';
}

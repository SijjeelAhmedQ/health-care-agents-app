/**
 * The application's actions, as the assistant's tools perform them.
 *
 * Every tool in tools.ts is a thin, typed wrapper over one method here. The
 * methods work through the registries (PageRegistry, FormRegistry,
 * FieldRegistry, RecordRegistry, NavigationRegistry, InboxVoiceRegistry) and
 * Redux — the same handlers the buttons use — and report back in words the
 * model can act on. No DOM queries, no text parsing: what to do and with which
 * values is decided by the model; this code only carries it out.
 *
 * Two rules are absolute:
 *   1. Nothing that depends on a patient runs without a selected patient.
 *   2. Nothing is saved or deleted without an explicit confirmation from the
 *      user — never one the model gives itself in the same turn it asked.
 */
import dayjs from 'dayjs';
import type { FieldValues, PendingConfirmation, ToolResult } from '@/types/ai';
import type { Appointment, Patient } from '@/types/domain';
import { PatientAppointmentsRegistry, ScheduleRegistry, type PatientAppointmentsController, type ScheduleController, type ScheduleView } from '@/registry/scheduleRegistry';

/** Whose appointments: the signed-in provider's own, or the selected patient's. */
type AppointmentScope = 'mine' | 'patient';
import { RECORD_KINDS, type EntityKind, type RecordKind } from '@/types/records';
import { categoryMeta, type InboxItem, type InboxView } from '@/services/inbox/inboxModel';
import { findPatientByRef, patientRef, patientRefName } from '@/services/records/patientRef';
import { InboxVoiceRegistry, getConfirmFiling, inboxNoun, ordinalWord, type InboxVoiceController } from '@/services/inbox/inboxVoice';
import { FieldRegistry, type CoerceResult, type FieldDefinition, type FieldScalar, type FormDefinition } from '@/registry/fieldRegistry';
import { FormRegistry, type FormController } from '@/registry/formRegistry';
import { NavigationRegistry } from '@/registry/navigationRegistry';
import { PageRegistry, type PageDefinition } from '@/registry/pageRegistry';
import { RecordRegistry, recordLabels, type RecordController } from '@/registry/recordRegistry';
import { matchRecord, recordDate, recordLabel, recordStatus, recordSubtitle, recordSummary, type AnyRecord } from '@/services/records/recordMapping';
import type { ProviderWorkload } from '@/services/provider/providerWorkload';
import type { PendingSlot } from '@/store/slices/voiceSlice';
import { ListRegistry } from '@/registry/listRegistry';
import { AiSummaryRegistry } from '@/registry/aiSummaryRegistry';
import { CARE_PLAN_FORM_ID, CARE_PLAN_INSTANCE, CarePlanRegistry, type CarePlanItems } from '@/registry/carePlanRegistry';
import type { AIConfig, LLMProviderKind } from '@/services/ai/config';
import type { ModelInfo } from '@/services/ai/modelCatalog';
import type { SttConfig, SttSettings } from '@/services/ai/sttConfig';
import { soundAlikes } from '@/services/records/nameMatch';
import type { ChatLLM } from '../providers/llm';

/** A summary that was written and shown (RuntimeDeps.summarize). */
export interface SummaryOutcome {
  /** What it is of: "Normal Inbox records". */
  title: string;
  /** Whose / how much: "All patients · 5 records". */
  scope: string;
  text: string;
  source: 'model' | 'rules';
  empty: boolean;
  /** The model call, for the trace (when a model wrote it). */
  model?: { name: string; request?: unknown; answer?: string; ms?: number; note?: string };
}

export interface RuntimeState {
  currentPageId: string | null;
  currentPatientId: string | null;
  currentPatientName: string | null;
  openFormId: string | null;
  pendingConfirmation: PendingConfirmation | null;
  pendingSlot: PendingSlot | null;
  patientPanelOpen: boolean;
}

export interface RuntimeDeps {
  getState(): RuntimeState;
  /** Every name the app holds for a kind of record (all patients) — what a misheard name is matched against. */
  knownNames?(kind: RecordKind): string[];
  navigate(path: string): void;
  back(): void;
  setCurrentPatient(id: string | null): void;
  setOpenForm(formId: string | null): void;
  setPendingConfirmation(p: PendingConfirmation | null): void;
  setPendingSlot(s: PendingSlot | null): void;
  setPatientSearch(query: string): void;
  setPatientPanel(open: boolean): void;
  setDashboardPanel(open: boolean): void;
  /** The selected patient, or undefined. */
  getPatient(): Patient | undefined;
  /** Every patient, and the ones the patient search on screen shows — in on-screen order. */
  allPatients(): Patient[];
  findPatients(query: string): Patient[];
  getPatientSearch(): string;
  /** Records of one kind belonging to the selected patient. */
  getRecords(kind: RecordKind): AnyRecord[];
  deleteEntity(kind: EntityKind, id: string): Promise<void>;
  /** A narrative overview of the selected patient, built from real data only. */
  describePatient(): string;
  /** The signed-in provider's schedule and work queue. */
  getWorkload(): ProviderWorkload | null;
  /** Full names of the practice's providers (for provider fields). */
  providerNames(): string[];
  /** The signed-in provider's own appointments — every one booked with them, across patients. */
  providerAppointments(): Appointment[];
  /** Every Inbox record (all patients, filed or not), once the Inbox has loaded. */
  inboxItems(): InboxItem[];
  /** Add the same comment, signed by the provider, to each of these Inbox records. */
  addInboxComments(itemIds: string[], text: string): void;
  stopListening(): void;
  /** Hand a dictated clinical note to the AI Summary for extraction (or start dictating one). */
  takeNote(text?: string): void;
  /**
   * Summarize what `text` asks about (the dashboard, Inbox records, a page, a patient's chart …): the app gathers
   * the data, the Summary Agent's model (`llm`, or the assistant's) writes it, and it opens in the Summary panel.
   */
  summarize?(request: { text: string; said?: string; llm?: ChatLLM | null; signal?: AbortSignal }): Promise<SummaryOutcome>;
  // ---- configuration
  /** The language model settings in use, and the bridge's address. */
  aiSettings(): { llm: AIConfig['llm']; bridgeUrl: string };
  listModels(provider: LLMProviderKind, apiUrl: string): Promise<ModelInfo[]>;
  /** Save the language model settings and switch to them once the current request is finished. */
  switchLanguageModel(llm: AIConfig['llm']): void;
  getSpeechConfig(): Promise<SttConfig>;
  saveSpeechConfig(settings: SttSettings): Promise<SttConfig>;
  // ---- application
  signOut(): void;
  setSpokenReplies(on: boolean): void;
  setSidebarCollapsed(collapsed: boolean): void;
  openHelp(): void;
}

/** Who asked: the assistant (by voice or typed), or a button / the command palette. */
export type Origin = 'assistant' | 'ui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 3000, interval = 40): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = probe();
    if (v) return v;
    await sleep(interval);
  }
  return undefined;
}

/** Refusal for the model: it tried to open or change a saved record while new ones wait on the provider. */
const WAITING_ON_PROVIDER =
  'What was just prepared is waiting for the provider — do not open, change or delete saved records now (that would close it). Add only what they asked for that is still missing, or stop.';

const ok = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, message, ...extra });
const fail = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: false, message, ...extra });
/** The application now needs the user: a question, or a confirmation. */
const ask = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, message, awaitUser: true, speak: true, ...extra });

/** A record as the model sees it: its id plus the few facts that identify it. */
export function recordBrief(kind: EntityKind, row: AnyRecord) {
  if (kind === 'patient') {
    const p = row as Patient;
    return { id: p.id, name: p.fullName, mrn: p.mrn, dateOfBirth: p.dateOfBirth, age: p.age, gender: p.gender, phone: p.phone };
  }
  return { id: (row as { id: string }).id, label: recordLabel(kind, row), details: recordSubtitle(kind, row), status: recordStatus(kind, row), date: recordDate(kind, row) };
}

const describePatient = (p: Patient) => `${p.fullName} (MRN ${p.mrn}${p.dateOfBirth ? `, born ${dayjs(p.dateOfBirth).format('D MMM YYYY')}` : ''})`;

/** The field that names a record (medication name, diagnosis, task title…). */
function primaryField(def: FormDefinition): FieldDefinition | undefined {
  return def.fields.find((f) => f.required && f.type === 'text') ?? def.fields.find((f) => f.required);
}

/**
 * The same records for each of several patients: one copy per patient, grouped by patient in the order
 * named. A record that already names its own patient is kept once, as it is — never copied to others.
 */
function forEachPatient(items: FieldValues[], patients?: string[]): FieldValues[] {
  const names = [...new Set((patients ?? []).map((p) => p.trim()).filter(Boolean))];
  if (!names.length) return items;
  const own = items.filter((item) => typeof item.patient === 'string' && item.patient.trim());
  const shared = items.filter((item) => !own.includes(item));
  return [...names.flatMap((patient) => shared.map((item) => ({ ...item, patient }))), ...own];
}

/** Say which spoken patient names were taken as a close match ("Lilly Martyn" -> Lily Martin). */
function withHeard(result: ToolResult, heard: string[]): ToolResult {
  return heard.length ? { ...result, message: `${heard.join('; ')}. ${result.message}` } : result;
}

/** True when none of the record-defining required fields have a value (who it is for does not define a record). */
function isBlank(def: FormDefinition, values: Record<string, unknown>): boolean {
  return def.fields.filter((f) => f.required && f.optionsFrom !== 'patients').every((f) => values[f.name] === undefined || values[f.name] === '' || values[f.name] === null);
}

/** The provider said it is about every patient: "all patients' …", "every patient", "all of the patients", "everyone's". */
const EVERY_PATIENT = /\b(all|every|each)\s+(of\s+)?(the\s+|my\s+)?patient(s|'s|s')?\b|\beveryone'?s?\b/i;

export class AppRuntime {
  origin: Origin = 'ui';
  /** The agent turn in progress; a confirmation staged in this turn cannot be confirmed in it. */
  private turn: number | null = null;
  private pendingTurn: number | null = null;
  /** The question that was waiting when this turn began: one asked during the turn is not the model's to answer. */
  private slotAtTurnStart = 'null';
  /** What the provider said this turn (lower-cased). */
  private said = '';
  /** Where the last record opened in the Inbox sat in the list — "next" after it was filed out of view. */
  private lastInboxIndex = -1;

  constructor(private readonly deps: RuntimeDeps) {}

  /** `said`: the provider's words this turn — a value found in them was said, not guessed. */
  beginTurn(turn: number, said = '') {
    this.turn = turn;
    this.origin = 'assistant';
    this.slotAtTurnStart = JSON.stringify(this.state().pendingSlot ?? null);
    this.said = said.toLowerCase().replace(/\s+/g, ' ');
  }

  endTurn() {
    this.turn = null;
    this.origin = 'ui';
  }

  /**
   * For the model only, on every form or care-plan step it causes: a small model tends to stop part-way
   * through a long request ("…a task, a recall after two weeks and a follow-up next Tuesday" came back
   * without the recall and the visit), or to start editing what it just prepared.
   */
  private remind(result: ToolResult): ToolResult {
    if (this.origin !== 'assistant' || !result.ok) return result;
    // Records for several patients: what each patient now has, side by side, so the model can see a record
    // given to the wrong patient or missing for one ("Panadol to John, Paracetamol to James…" when every
    // patient was to get all three).
    const byPatient = this.openRecordsByPatient();
    return {
      ...result,
      data: {
        ...(result.data as Record<string, unknown> | undefined),
        check:
          'Compare with SAID: every medication, diagnosis, task, recall and appointment the provider mentioned must be open now. If one is missing, add only the missing ones (add_care_plan — records added while a form is open join one care plan). Do not change, clear or re-add what is there, and do not open saved records.',
        ...(byPatient
          ? {
              by_patient: byPatient,
              check_patients:
                'Each patient must have exactly the records SAID gives them: "to each of" / "all of them" means every record for every patient named. If a patient is missing records, add them (add_* with for_patients or the patient field). Never fill a value SAID did not give for that record — the provider is asked.',
            }
          : {}),
      },
    };
  }

  /** The open form's (or care plan's) records grouped by patient, when they are for more than one patient. */
  /** The patients whose new records wait in the open record form or the care plan ([] when none waits). */
  waitingPatients(): string[] {
    const names = new Set<string>();
    const plan = CarePlanRegistry.get();
    const values = plan?.isOpen()
      ? plan.entries().map((e) => e.values)
      : (() => {
          const form = FormRegistry.active();
          if (!form?.isOpen() || !(RECORD_KINDS as readonly string[]).includes(form.formId)) return [];
          return form.entries?.getAll() ?? [form.getValues()];
        })();
    for (const v of values) {
      const who = patientRefName((v as Record<string, unknown>).patient) || this.state().currentPatientName;
      if (who) names.add(who);
    }
    return [...names];
  }

  private openRecordsByPatient(): Record<string, string[]> | null {
    const groups: Record<string, string[]> = {};
    const add = (kind: string, values: Record<string, unknown>) => {
      const def = FieldRegistry.getForm(kind);
      const primary = def ? primaryField(def) : undefined;
      const who = patientRefName(values.patient) || this.state().currentPatientName || 'no patient';
      (groups[who] ??= []).push(String((primary && values[primary.name]) || kind));
    };
    const plan = CarePlanRegistry.get();
    if (plan?.isOpen()) plan.entries().forEach((e) => add(e.kind, e.values));
    else {
      const form = FormRegistry.active();
      if (!form?.entries || !(RECORD_KINDS as readonly string[]).includes(form.formId)) return null;
      form.entries.getAll().forEach((v) => add(form.formId, v));
    }
    return Object.keys(groups).length > 1 ? groups : null;
  }

  /**
   * The assistant is acting, and what is waiting on the provider (a question or a confirmation) was
   * prepared in this very turn — so they have not seen it, let alone asked to change it.
   */
  private preparedThisTurn(): boolean {
    if (this.origin !== 'assistant' || this.turn === null) return false;
    const pending = this.state().pendingConfirmation;
    const slot = this.state().pendingSlot;
    return (!!pending && this.pendingTurn === this.turn) || (!!slot && JSON.stringify(slot) !== this.slotAtTurnStart);
  }

  /** The form open now holds a saved record being changed (not a new one). */
  private editing = false;

  /** A form is open on a saved record (an edit): what it holds was saved before, not said now. */
  isEditing(): boolean {
    return this.editing && !!FormRegistry.active()?.isOpen();
  }

  /**
   * New records wait on the provider in a record form or the care plan (a question about them, or the one
   * confirmation to save them): more records — another agent's — can join them, and are saved with them.
   */
  recordsWaiting(): boolean {
    if (this.isEditing()) return false;
    const st = this.state();
    const active = FormRegistry.active();
    const open = CarePlanRegistry.isOpen() || (!!active?.isOpen() && (RECORD_KINDS as readonly string[]).includes(active.formId));
    const waits = (st.pendingConfirmation?.kind === 'form' && !st.pendingConfirmation.recordId) || !!st.pendingSlot;
    return open && waits;
  }

  /**
   * Close what was prepared for confirmation, unconfirmed — the Safety Agent found a value in it nobody said.
   * Nothing of it is saved; the provider is asked again.
   */
  discardStaged() {
    this.pendingTurn = null;
    this.deps.setPendingConfirmation(null);
    this.deps.setPendingSlot(null);
    if (CarePlanRegistry.isOpen()) CarePlanRegistry.get()?.close();
    const form = FormRegistry.active();
    if (form?.isOpen()) form.close();
    this.deps.setOpenForm(null);
    this.editing = false;
  }

  private stage(p: PendingConfirmation) {
    this.pendingTurn = this.turn;
    this.deps.setPendingSlot(null);
    this.deps.setPendingConfirmation(p);
  }

  private state() {
    return this.deps.getState();
  }

  // ----------------------------------------------------------------- pages

  /** Patient-dependent actions are refused while no patient is selected. */
  /** `forRecords`: new records can name their patients instead — say so, rather than send the model searching. */
  private requirePatient(what: string, forRecords = false): ToolResult | null {
    if (this.state().currentPatientId) return null;
    if (forRecords)
      return fail(
        `No patient is selected and none was named, so I can't ${what}. Call it again naming the patient the provider said: in each record's patient field, or all of them in for_patients (no need to select anyone first). If the provider named no patient, ask them who it is for.`,
      );
    return fail(`No patient is selected, so I can't ${what}. Select a patient first (search_patients / select_patient).`);
  }

  async openPage(pageId: string): Promise<ToolResult> {
    const page = PageRegistry.get(pageId);
    if (!page) return fail(`There is no page "${pageId}". Pages: ${PageRegistry.all().map((p) => p.id).join(', ')}.`);
    return this.goTo(page);
  }

  private async goTo(page: PageDefinition): Promise<ToolResult> {
    // The assistant opens the Inbox on the selected patient; buttons and the palette keep the whole queue.
    if (page.module === 'inbox' && this.origin === 'assistant') return this.inboxShow({ category: (page.tab as InboxView | undefined) ?? 'all' });
    if (page.requiresPatient) {
      const blocked = this.requirePatient(`open ${page.title}`);
      if (blocked) return blocked;
    }
    // Agent Monitoring is being watched: the screen stays on it, so say so rather than "Opened".
    if (NavigationRegistry.isPinned()) return fail(`Agent Monitoring is on screen and stays there — ${page.title} was not opened. Go back to CareFlow to open it.`);
    this.deps.navigate(page.path);
    await waitFor(() => NavigationRegistry.pathname() === page.path, 2500);
    await sleep(80); // let a lazy page mount and register its forms
    return ok(`Opened ${page.title}.`);
  }

  goBack(): ToolResult {
    if (InboxVoiceRegistry.get()?.snapshot().openItem) {
      InboxVoiceRegistry.get()!.close();
      return ok('Closed the Inbox record.');
    }
    this.deps.back();
    return ok('Went back.');
  }

  scroll(direction: 'up' | 'down' | 'top' | 'bottom'): ToolResult {
    NavigationRegistry.scrollBy(direction);
    return ok(`Scrolled ${direction}.`);
  }

  setPatientPanel(open: boolean): ToolResult {
    if (!open) {
      this.deps.setPatientPanel(false);
      return ok('Closed the patient summary panel.');
    }
    const blocked = this.requirePatient('show the patient summary panel');
    if (blocked) return blocked;
    this.deps.setPatientPanel(true);
    return ok(`Opened the summary panel for ${this.state().currentPatientName} on the right.`);
  }

  // -------------------------------------------------------------- patients

  async searchPatients(heard: string): Promise<ToolResult> {
    // A misheard name ("Loose he Yung") finds nothing as written: search for the one close spelling instead.
    let query = heard;
    let closest = '';
    if (!this.deps.findPatients(heard).length) {
      const { matches, strong } = soundAlikes(heard, this.deps.allPatients(), (p) => p.fullName);
      if (strong) {
        query = strong.fullName;
        closest = `No patient is called "${heard}"; the closest name is ${strong.fullName}. `;
      } else if (matches.length) {
        return ok(`No patient is called "${heard}". The closest names are ${matches.slice(0, 3).map((m) => m.item.fullName).join(', ')} — ask the user which one they mean.`, {
          data: matches.slice(0, 6).map((m) => recordBrief('patient', m.item)),
        });
      }
    }
    this.deps.setPatientSearch(query);
    this.deps.navigate(`${PageRegistry.get('patients')!.path}?q=${encodeURIComponent(query)}`);
    await sleep(120);
    RecordRegistry.get('patient')?.setSearch(query);
    const matches = this.deps.findPatients(query);
    if (!matches.length) return ok(`No patient matches "${query}". The patient list is open.`, { data: [] });
    return ok(`${closest}${matches.length} patient${matches.length === 1 ? '' : 's'} match "${query}" (shown on screen in this order).`, {
      data: matches.slice(0, 8).map((p, i) => ({ position: i + 1, ...recordBrief('patient', p) })),
    });
  }

  /**
   * Which patient a request is about — never a guess. An id, an exact full name or MRN, or a
   * position in the patient list on screen. Anything else that matches several is returned
   * as candidates for the model to resolve with the user.
   */
  /** `heardAs`: the patient was found by a close spelling of what speech recognition heard. */
  private resolvePatient(patient?: string, position?: number): { patient: Patient; heardAs?: string } | ToolResult {
    if (position) {
      const list = this.deps.findPatients(this.deps.getPatientSearch().trim());
      if (this.state().currentPageId !== 'patients' && !this.deps.getPatientSearch().trim()) return fail('There is no patient list on screen — search for the patient first.');
      if (position > list.length) return fail(`There is no ${ordinalWord(position)} patient in the list — it has ${list.length}.`);
      return { patient: list[position - 1] };
    }
    if (!patient) {
      const current = this.deps.getPatient();
      return current ? { patient: current } : fail('No patient was named and none is selected.');
    }
    const all = this.deps.allPatients();
    const byId = all.find((p) => p.id === patient);
    if (byId) return { patient: byId };
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exact = all.filter((p) => key(p.fullName) === key(patient) || key(p.mrn) === key(patient));
    if (exact.length === 1) return { patient: exact[0] };
    const { match, candidates } = matchRecord('patient', all, patient);
    const pool = exact.length > 1 ? exact : candidates;
    if (exact.length === 0 && match && candidates.length === 1) return { patient: match };
    if (!pool.length) {
      // Speech recognition often mishears a name ("Loose he Yung"): try the closest spellings.
      const { matches, strong } = soundAlikes(patient, all, (p) => p.fullName);
      if (strong) return { patient: strong, heardAs: patient };
      if (matches.length)
        return fail(`No patient is called "${patient}". The closest names are ${matches.slice(0, 3).map((m) => m.item.fullName).join(', ')} — ask the user which one they mean.`, {
          data: matches.slice(0, 6).map((m) => recordBrief('patient', m.item)),
        });
      return fail(`No patient matches "${patient}". Try the full name or the MRN.`);
    }
    return fail(`${pool.length} patients match "${patient}". Ask the user which one they mean.`, {
      data: pool.slice(0, 6).map((p) => recordBrief('patient', p)),
    });
  }

  /**
   * Who a name said for a call is — the same lookup the tools use (a reference, the full name or MRN, part of
   * a name, a misheard spelling). One patient: their name. Otherwise the candidates (none: nobody matches).
   * Looks only: nothing is searched on screen, nothing selected.
   */
  findPatient(raw: string): { name?: string; options: string[]; close?: boolean } {
    const all = this.deps.allPatients();
    const ref = findPatientByRef(all, raw);
    if (ref) return { name: ref.fullName, options: [] };
    const clean = String(raw).replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!clean) return { options: [] };
    const found = this.resolvePatient(clean);
    if (!('ok' in found)) return { name: found.patient.fullName, options: [] };
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exact = all.filter((p) => key(p.fullName) === key(clean));
    const pool = exact.length > 1 ? exact : matchRecord('patient', all, clean).candidates;
    // Nobody matches: the names spelled most like it ("John" → Josh Clarke), offered — never chosen.
    const close = !pool.length;
    const options = (pool.length ? pool : soundAlikes(clean, all, (p) => p.fullName).matches.map((m) => m.item)) as Patient[];
    return { options: options.slice(0, close ? 3 : 5).map((p) => `${p.fullName} (${p.mrn})`), close };
  }

  async selectPatient(args: { patient?: string; position?: number; page?: string }): Promise<ToolResult> {
    const found = this.resolvePatient(args.patient, args.position);
    if ('ok' in found) {
      if (args.patient && !found.ok && found.data) {
        // Put the candidates on screen, numbered, so the user can pick one by position.
        this.deps.setPatientSearch(args.patient);
        this.deps.navigate(`${PageRegistry.get('patients')!.path}?q=${encodeURIComponent(args.patient)}`);
      }
      return found;
    }
    const { patient, heardAs } = found;
    this.deps.setCurrentPatient(patient.id);
    await sleep(60);
    const target = (args.page && PageRegistry.get(args.page)) || PageRegistry.get('summary')!;
    await this.goTo(target);
    const closest = heardAs ? `No patient is called "${heardAs}"; the closest name is ${patient.fullName}. ` : '';
    return ok(`${closest}${describePatient(patient)} is now the selected patient. ${target.title} is open.`, heardAs ? { speak: true } : undefined);
  }

  clearPatient(): ToolResult {
    this.deps.setCurrentPatient(null);
    this.deps.navigate(PageRegistry.get('patients')!.path);
    return ok('No patient is selected now. The patient list is open.');
  }

  async deletePatient(patient?: string, position?: number): Promise<ToolResult> {
    const found = this.resolvePatient(patient, position);
    if ('ok' in found) return found;
    const p = found.patient;
    await this.ensureModule('patient');
    RecordRegistry.get('patient')?.setSearch(p.fullName);
    this.stage({
      kind: 'delete',
      formId: 'patient',
      formTitle: 'Delete patient',
      summary: recordSummary('patient', p),
      description: 'Permanently delete this patient',
      recordKind: 'patient',
      recordId: p.id,
    });
    return ask(`Delete ${describePatient(p)}? This cannot be undone. Please confirm or cancel.`);
  }

  async editPatient(args: { patient?: string; position?: number; changes?: FieldValues; askFor?: string }): Promise<ToolResult> {
    const found = this.resolvePatient(args.patient, args.position);
    if ('ok' in found) return found;
    const p = found.patient;
    const page = await this.ensureModule('patient');
    if ('ok' in page) return page;
    const existing = FormRegistry.get('patient');
    if (existing?.isOpen()) {
      existing.close();
      await waitFor(() => !existing.isOpen(), 1500);
    }
    this.deps.setPendingConfirmation(null);
    this.deps.setPendingSlot(null);
    if (!page.openEdit(p.id)) return fail(`I couldn't open ${p.fullName} for editing.`);
    this.editing = true;
    const form = await waitFor(() => FormRegistry.get('patient'), 3000);
    if (!form) return fail('The patient form did not open.');
    await waitFor(() => form.isOpen(), 1500);
    await sleep(120); // let the dialog load the patient's saved values before anything is written
    this.deps.setOpenForm('patient');
    if (args.changes && Object.keys(args.changes).length) {
      const filled = await this.fill('patient', form, [args.changes], 'active');
      return { ...filled, message: `Editing ${describePatient(p)} — only the fields given are changed. ${filled.message}` };
    }
    const field = args.askFor ? FieldRegistry.resolveField('patient', args.askFor) : undefined;
    if (field) {
      const now = form.getValues()[field.name];
      const question = `What is the new ${field.label.toLowerCase()} for ${p.fullName}?`;
      this.deps.setPendingSlot({ formId: 'patient', field: field.name, label: field.label, question });
      form.focusField(field.name);
      return ask(`${question}${now ? ` It is currently ${String(now)}.` : ''}`);
    }
    return ask(`${describePatient(p)} is open for editing. What should change?`);
  }

  // --------------------------------------------------------------- records

  /** Open the page that hosts a record kind and wait for its controller. */
  private async ensureModule(kind: EntityKind): Promise<RecordController | ToolResult> {
    const page = kind === 'patient' ? PageRegistry.get('patients')! : PageRegistry.recordTab(kind);
    if (this.state().currentPageId !== page.id || !RecordRegistry.get(kind)) {
      const nav = await this.goTo(page);
      if (!nav.ok) return nav;
    }
    const controller = await waitFor(() => RecordRegistry.get(kind), 4000);
    return controller ?? fail(`I couldn't open the ${page.title} page.`);
  }

  async listRecords(kind: RecordKind, status?: string, patient?: string, search?: string): Promise<ToolResult> {
    const chose = await this.usePatient(patient);
    if (chose) return chose;
    const blocked = this.requirePatient(`list ${recordLabels[kind].plural}`);
    if (blocked) return blocked;
    await this.ensureModule(kind);
    const all = this.deps.getRecords(kind);
    const byStatus = status ? all.filter((r) => recordStatus(kind, r).toLowerCase() === status.toLowerCase()) : all;
    // A search: every word said is in the record (its name, dose, reason, notes …).
    const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = words.length ? byStatus.filter((r) => words.every((w) => JSON.stringify(r).toLowerCase().includes(w))) : byStatus;
    const who = this.state().currentPatientName;
    const which = `${status ? `${status.toLowerCase()} ` : ''}`;
    const matching = words.length ? ` matching "${search}"` : '';
    return ok(
      rows.length
        ? `${who} has ${rows.length} ${which}${rows.length === 1 ? recordLabels[kind].singular : recordLabels[kind].plural}${matching}. The ${PageRegistry.recordTab(kind).title} tab is open.`
        : `${who} has no ${which}${recordLabels[kind].plural}${matching}.`,
      { data: rows.slice(0, 25).map((r) => recordBrief(kind, r)), speak: true },
    );
  }

  /** Open the create dialog pre-filled with one or more records (several = one tab each). */
  /** `forPatients`: every item is for each of these patients — one copy per patient, made here, never by the model. */
  async createRecords(kind: EntityKind, items: FieldValues[], forPatients?: string[]): Promise<ToolResult> {
    items = items.map((item) => FieldRegistry.canonical(kind, item));
    if (kind === 'patient') return this.openRecords(kind, items);
    items = forEachPatient(items, forPatients);
    // Records named for other patients ("…for Liam Martin, Harry White and Lily Martin"): each
    // patient is found first — none guessed; nothing opens while one of them is unclear.
    const named = await this.resolveItemPatients(items);
    if ('ok' in named) return named;
    // Records that name their patients need nobody selected (the form asks for any patient still missing).
    if (!named.first) {
      const blocked = this.requirePatient(`add a ${recordLabels[kind].singular}`, true);
      if (blocked) return blocked;
    } else if (!this.state().currentPatientId) {
      // The form opens on a patient's Summary: with nobody selected, the first one named is (as the care plan does).
      this.deps.setCurrentPatient(named.first.id);
      await sleep(60);
    }
    return withHeard(await this.openRecords(kind, named.items), named.heard);
  }

  private async openRecords(kind: EntityKind, items: FieldValues[]): Promise<ToolResult> {
    // A medication given a dose but no drug (a diagnosis with details but no condition) is not a record:
    // the details belong to a named one. An empty item — "add a medication" — still opens the blank form.
    const nameField = kind === 'patient' ? undefined : FieldRegistry.getForm(kind)!.fields.find((f) => f.knownFrom === kind);
    if (nameField) {
      const unnamed = (v: FieldValues) => Object.keys(v).length > 0 && (v[nameField.name] === undefined || v[nameField.name] === '');
      const named = items.filter((v) => !unnamed(v));
      if (!named.length && items.length) {
        const label = recordLabels[kind as RecordKind].singular;
        return fail(`A ${label} needs its ${nameField.label.toLowerCase()} — nothing was opened. A dose or frequency belongs to the named ${label} it was said with: call again with each ${label} named (and use add_care_plan when the provider also asked for other kinds of records).`);
      }
      items = named;
    }
    // While the care plan is open a record added to "the open form" joins it, like more records of
    // an open form's own kind do, rather than closing it and losing what it holds.
    if (kind !== 'patient' && CarePlanRegistry.isOpen()) return this.addCarePlan({ items: { [kind]: items } });
    // Adding to a form of the same kind that is already open (e.g. "and also ibuprofen") extends it.
    const open = FormRegistry.active();
    if (open && open.formId === kind && open.isOpen() && open.entries && !this.state().pendingConfirmation?.recordId) {
      return this.fill(kind, open, items, 'append');
    }
    // A record of another kind while a record form holds unsaved ones ("…metformin, and a task for BP
    // monitoring"): they belong together in one care plan — never close the open form and lose them.
    if (kind !== 'patient' && open?.isOpen() && open.formId !== kind && (RECORD_KINDS as readonly string[]).includes(open.formId) && !this.state().pendingConfirmation?.recordId) {
      const def = FieldRegistry.getForm(open.formId)!;
      const held = (open.entries?.getAll() ?? [open.getValues()])
        .map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== '')) as FieldValues)
        .filter((v) => !isBlank(def, v));
      if (held.length) return this.addCarePlan({ items: { [open.formId]: held, [kind]: items } as CarePlanItems });
    }
    const controller = await this.ensureModule(kind);
    if ('ok' in controller) return controller;
    const existing = FormRegistry.active();
    if (existing?.isOpen()) {
      existing.close();
      await waitFor(() => !existing.isOpen(), 1500);
    }
    controller.openCreate();
    this.editing = false;
    const form = await waitFor(() => FormRegistry.get(kind), 3000);
    if (!form) return fail(`The ${recordLabels[kind].singular} form did not open.`);
    await waitFor(() => form.isOpen(), 1500);
    await sleep(60); // let the new dialog reset before anything is written into it
    this.deps.setOpenForm(kind);
    this.deps.setPendingConfirmation(null);
    return this.fill(kind, form, items.length ? items : [{}], 'new');
  }

  private resolveRecord(kind: RecordKind, record: string): { row: AnyRecord } | ToolResult {
    const rows = this.deps.getRecords(kind);
    if (!rows.length) return fail(`${this.state().currentPatientName} has no ${recordLabels[kind].plural}.`);
    const { match, candidates } = matchRecord(kind, rows as Array<AnyRecord & { id: string }>, record);
    if (match) return { row: match };
    if (!candidates.length) {
      return fail(`No ${recordLabels[kind].singular} matches "${record}".`, { data: rows.slice(0, 15).map((r) => recordBrief(kind, r)) });
    }
    return fail(`Several ${recordLabels[kind].plural} match "${record}". Retry with the id of the one the user means, or ask them.`, {
      data: candidates.slice(0, 8).map((r) => recordBrief(kind, r)),
    });
  }

  /** The patient a record tool names: selected first when it is not the selected one. */
  private async usePatient(patient?: string): Promise<ToolResult | null> {
    if (!patient) return null;
    const found = this.resolvePatient(patient);
    if ('ok' in found) return found;
    if (found.patient.id !== this.state().currentPatientId) {
      this.deps.setCurrentPatient(found.patient.id);
      await sleep(60);
    }
    return null;
  }

  async updateRecord(kind: RecordKind, record: string, changes: FieldValues, patient?: string): Promise<ToolResult> {
    const chose = await this.usePatient(patient);
    if (chose) return chose;
    const blocked = this.requirePatient(`change a ${recordLabels[kind].singular}`);
    if (blocked) return blocked;
    if (this.preparedThisTurn()) return fail(WAITING_ON_PROVIDER);
    const found = this.resolveRecord(kind, record);
    if ('ok' in found) return found;
    if (kind === 'appointment' && (changes.date !== undefined || changes.startTime !== undefined || ['Cancelled', 'Rescheduled'].includes(String(changes.status ?? '')))) {
      return fail(
        'An appointment is moved or cancelled with a reason, and the patient is told — not edited. Use reschedule_patient_appointment (new date / time and the comment) or cancel_patient_appointment (the note) instead.',
      );
    }
    const controller = await this.ensureModule(kind);
    if ('ok' in controller) return controller;
    const existing = FormRegistry.active();
    if (existing?.isOpen()) {
      existing.close();
      await waitFor(() => !existing.isOpen(), 1500);
    }
    const id = (found.row as { id: string }).id;
    if (!controller.openEdit(id)) return fail(`I couldn't open that ${recordLabels[kind].singular} for editing.`);
    this.editing = true;
    const form = await waitFor(() => FormRegistry.get(kind), 3000);
    if (!form) return fail(`The ${recordLabels[kind].singular} form did not open.`);
    await waitFor(() => form.isOpen(), 1500);
    await sleep(80);
    this.deps.setOpenForm(kind);
    const label = recordLabel(kind, found.row);
    if (!Object.keys(changes).length) return ask(`${label} is open for editing. What should change?`);
    const filled = await this.fill(kind, form, [changes], 'active');
    return { ...filled, message: `${label}: ${filled.message}` };
  }

  async deleteRecord(kind: RecordKind, record: string | undefined, opts: { all?: boolean; patient?: string } = {}): Promise<ToolResult> {
    const chose = await this.usePatient(opts.patient);
    if (chose) return chose;
    const blocked = this.requirePatient(`delete ${opts.all ? `${recordLabels[kind].plural}` : `a ${recordLabels[kind].singular}`}`);
    if (blocked) return blocked;
    if (this.preparedThisTurn()) return fail(WAITING_ON_PROVIDER);
    if (opts.all) return this.deleteAll(kind);
    if (!record) return fail(`Which ${recordLabels[kind].singular}? Give record (its name as the provider said it), or all: true only if they asked to delete all of them.`);
    const found = this.resolveRecord(kind, record);
    if ('ok' in found) return found;
    const label = recordLabel(kind, found.row);
    // Show the record before asking, so "yes" is never a blind answer.
    await this.ensureModule(kind);
    RecordRegistry.get(kind)?.setSearch(label);
    this.stage({
      kind: 'delete',
      formId: kind,
      formTitle: `Delete ${recordLabels[kind].singular}`,
      summary: recordSummary(kind, found.row),
      description: `Permanently delete this ${recordLabels[kind].singular}`,
      recordKind: kind,
      recordId: (found.row as { id: string }).id,
    });
    return ask(`Delete the ${recordLabels[kind].singular} "${label}"? This cannot be undone. Please confirm or cancel.`);
  }

  /** Every record of a kind, for the selected patient: listed on screen, deleted together on one confirmation. */
  private async deleteAll(kind: RecordKind): Promise<ToolResult> {
    const rows = this.deps.getRecords(kind) as Array<AnyRecord & { id: string }>;
    const who = this.state().currentPatientName ?? 'this patient';
    const { singular, plural: many } = recordLabels[kind];
    if (!rows.length) return ok(`${who} has no ${many} — nothing to delete.`);
    await this.ensureModule(kind);
    RecordRegistry.get(kind)?.setSearch('');
    const labels = rows.map((r) => recordLabel(kind, r));
    this.stage({
      kind: 'delete',
      formId: kind,
      formTitle: `Delete all ${many}`,
      summary: labels.map((value, i) => ({ label: `${singular[0].toUpperCase()}${singular.slice(1)} ${i + 1}`, value })),
      description: `Permanently delete all ${rows.length} ${rows.length === 1 ? singular : many} of ${who}`,
      recordKind: kind,
      recordIds: rows.map((r) => r.id),
    });
    const shown = labels.length > 6 ? `${labels.slice(0, 6).join(', ')} and ${labels.length - 6} more` : labels.join(', ');
    return ask(`This will delete all ${rows.length} ${rows.length === 1 ? singular : many} for ${who} (${shown}). This cannot be undone. Do you want to continue?`);
  }

  // ----------------------------------------------------------------- forms

  /**
   * Write values into a form — one field set per entry — then ask for the first missing
   * required field or stage the save for confirmation. Values are checked against the
   * field definitions; what does not fit is reported back instead of written.
   *
   *   new     a freshly opened dialog: the first item goes into it, the rest into new tabs
   *   active  change the entry on screen (answers, corrections, edits)
   *   append  more records for a dialog that is already open: new tabs, unless the one on screen is still blank
   */
  private async fill(formId: string, controller: FormController, items: FieldValues[], mode: 'new' | 'active' | 'append'): Promise<ToolResult> {
    const def = FieldRegistry.getForm(formId)!;
    if (!controller.isOpen()) {
      controller.open();
      await waitFor(() => controller.isOpen(), 1500);
    }
    this.deps.setOpenForm(def.id);
    const errors: string[] = [];
    const modified: NonNullable<ToolResult['fieldsModified']> = [];
    const skipped = controller.entries ? 0 : Math.max(0, items.length - 1);
    const targets = controller.entries ? items : items.slice(0, 1);
    const firstIntoActive = mode !== 'append' || isBlank(def, controller.getValues());

    for (let i = 0; i < targets.length; i++) {
      const incoming = { ...targets[i] };
      // A spoken age stands in for the required date of birth (approximate, editable before saving).
      if (def.id === 'patient' && typeof incoming.age === 'number' && incoming.dateOfBirth === undefined && !controller.getValues().dateOfBirth && incoming.age > 0 && incoming.age < 130) {
        incoming.dateOfBirth = dayjs().subtract(incoming.age, 'year').startOf('year').format('YYYY-MM-DD');
      }
      const values = this.coerceItem(def, incoming, errors, modified);
      if (!Object.keys(values).length) continue;
      if (i === 0 && (firstIntoActive || !controller.entries)) controller.setValues(values);
      else controller.entries!.add(values);
    }
    this.deps.setPendingSlot(null);
    const notes = [...errors];
    if (skipped) notes.push(`this form holds one record at a time; ${skipped} more were not added`);
    // A record tab of the care plan is saved with the whole plan, never on its own.
    if (controller.instanceKey?.startsWith(CARE_PLAN_INSTANCE)) return this.remind(this.carePlanNextStep(modified, notes));
    const next = this.remind(this.nextStep(def, controller, modified, notes));
    // No double booking: an appointment that would clash is not offered for saving at all.
    if (this.state().pendingConfirmation?.formId === def.id && (def.id === 'appointment' || def.id === 'appointment_reschedule')) {
      const clashes = (await controller.validate()).filter((e) => /already (has an appointment|booked)/.test(e));
      if (clashes.length) {
        this.deps.setPendingConfirmation(null);
        this.pendingTurn = null;
        return fail(`Not bookable: ${clashes.join(' ')} Nothing is booked — ask the provider for another time.`, { fieldsModified: modified, speak: true });
      }
    }
    return next;
  }

  /**
   * A name as speech recognition heard it, against the names the app holds. A near-certain
   * misspelling (one known name, spelled almost the same) is corrected; merely similar names are
   * only reported, so a real but different drug (Valsartan vs Losartan) is never replaced.
   */
  private matchKnownName(kind: RecordKind, value: string): { use?: string; close?: string[] } {
    const names = this.deps.knownNames?.(kind) ?? [];
    const lower = value.toLowerCase();
    if (!names.length || names.some((n) => n.toLowerCase() === lower)) return {};
    const { matches } = soundAlikes(value, names, (n) => n, 0.7);
    const [best, next] = matches;
    if (best && best.score >= 0.85 && (!next || best.score - next.score >= 0.1)) return { use: best.item };
    return { close: matches.slice(0, 3).map((m) => m.item) };
  }

  /** Check each value against its field; what fits is returned, what does not is added to `errors`. */
  private coerceItem(def: FormDefinition, incoming: FieldValues, errors: string[], modified: NonNullable<ToolResult['fieldsModified']>): Record<string, FieldScalar> {
    const values: Record<string, FieldScalar> = {};
    for (const [name, raw] of Object.entries(incoming)) {
      const field = FieldRegistry.resolveField(def.id, name);
      if (!field) {
        errors.push(`"${name}" is not a field of the ${def.title} form`);
        continue;
      }
      const coerced =
        field.optionsFrom === 'providers' ? this.resolveProvider(field.name, raw) : field.optionsFrom === 'patients' ? this.resolvePatientField(raw) : FieldRegistry.coerceValue(field, raw);
      if (!coerced.ok) {
        errors.push(coerced.error);
        continue;
      }
      if (field.knownFrom && typeof coerced.value === 'string') {
        const known = this.matchKnownName(field.knownFrom, coerced.value);
        if (known.use) {
          errors.push(`"${coerced.value}" was taken as ${known.use}, the closest ${recordLabels[field.knownFrom].singular} name the app knows — say so to the provider`);
          coerced.value = known.use;
        } else if (known.close?.length) {
          errors.push(`"${coerced.value}" is not a ${recordLabels[field.knownFrom].singular} the app has seen; close names it knows: ${known.close.join(', ')}. Keep it unless the provider meant one of those`);
        }
      }
      values[field.name] = coerced.value;
      modified.push({ formId: def.id, field: field.name, value: String(coerced.value) });
    }
    return values;
  }

  // ------------------------------------------------------------- care plan

  /**
   * Open the Care Plan on the Summary — one dialog, a tab per record kind and a tab per record —
   * pre-filled with every record given (or add them to the plan already open). Selects the named
   * patient first. Then asks for the first missing required value, or stages one save for all.
   */
  async addCarePlan(args: { patient?: string; forPatients?: string[]; items: CarePlanItems }): Promise<ToolResult> {
    args = { ...args, items: Object.fromEntries(RECORD_KINDS.map((kind) => [kind, (args.items[kind] ?? []).map((item) => FieldRegistry.canonical(kind, item))])) as CarePlanItems };
    if (args.forPatients?.length) {
      args = { ...args, items: Object.fromEntries(RECORD_KINDS.map((kind) => [kind, forEachPatient(args.items[kind] ?? [], args.forPatients)])) as CarePlanItems };
    }
    if (args.patient) {
      const found = this.resolvePatient(args.patient);
      if ('ok' in found) return found;
      if (found.patient.id !== this.state().currentPatientId) {
        CarePlanRegistry.get()?.close();
        this.deps.setCurrentPatient(found.patient.id);
        await sleep(60);
      }
    }
    const named = await this.resolveItemPatients(RECORD_KINDS.flatMap((kind) => args.items[kind] ?? []));
    if ('ok' in named) return named;
    const resolved: CarePlanItems = {};
    let at = 0;
    for (const kind of RECORD_KINDS) {
      const given = args.items[kind];
      if (!given) continue;
      resolved[kind] = named.items.slice(at, at + given.length);
      at += given.length;
    }
    args = { ...args, items: resolved };
    // A care plan belongs to one patient's Summary: with nobody selected, the first one named is.
    if (named.first && !this.state().currentPatientId && !args.patient) {
      this.deps.setCurrentPatient(named.first.id);
      await sleep(60);
    }
    const blocked = this.requirePatient('open a care plan', true);
    if (blocked) return blocked;
    return withHeard(await this.openCarePlan(args), named.heard);
  }

  private async openCarePlan(args: { patient?: string; items: CarePlanItems }): Promise<ToolResult> {

    const errors: string[] = [];
    const modified: NonNullable<ToolResult['fieldsModified']> = [];
    const items: CarePlanItems = {};
    for (const kind of RECORD_KINDS) {
      const given = args.items[kind] ?? [];
      const def = FieldRegistry.getForm(kind)!;
      const checked = given.map((item) => this.coerceItem(def, item, errors, modified)).filter((v) => Object.keys(v).length);
      if (checked.length) items[kind] = checked;
    }
    // A value that does not fit (a drug name given as its dose, a date in the wrong form) is left out —
    // never the whole plan: everything else the provider said is kept, and a required value that is now
    // missing is asked for.
    // A medication without a drug (a diagnosis without its condition) is not a record: "500 mg twice
    // daily for 30 days" given as an item of its own belongs to a named drug. It is left out, and the
    // model is told why, rather than becoming an unnamed tab the provider is asked to name.
    for (const kind of RECORD_KINDS) {
      const name = FieldRegistry.getForm(kind)!.fields.find((f) => f.knownFrom === kind);
      if (!name || !items[kind]) continue;
      const named = items[kind]!.filter((v) => v[name.name] !== undefined && v[name.name] !== '');
      const dropped = items[kind]!.length - named.length;
      if (dropped) errors.push(`${dropped} ${dropped === 1 ? recordLabels[kind].singular : recordLabels[kind].plural} without a ${name.label.toLowerCase()} not added — a dose or frequency belongs to the named ${recordLabels[kind].singular} it was said with`);
      if (named.length) items[kind] = named;
      else delete items[kind];
    }
    let total = RECORD_KINDS.reduce((n, k) => n + (items[k]?.length ?? 0), 0);
    if (!total)
      return fail(
        errors.length
          ? `Nothing was added: ${errors.join('; ')}. Call add_care_plan again with every drug named — and the tasks, recalls and appointments the provider asked for.`
          : 'The care plan needs at least one medication, diagnosis, task, recall or appointment.',
      );

    if (PageRegistry.get(this.state().currentPageId ?? '')?.module !== 'summary' || !CarePlanRegistry.get()) {
      const nav = await this.goTo(PageRegistry.get('summary')!);
      if (!nav.ok) return nav;
    }
    const plan = await waitFor(() => CarePlanRegistry.get(), 4000);
    if (!plan) return fail('The Summary page did not open, so the care plan could not be shown.');
    // A record form on screen (the medications just added) is replaced by the plan without a gap: the plan
    // opens over it at once and the form closes behind — never "the dialog vanished and came back".
    const existing = FormRegistry.active();
    const replaced = existing?.isOpen() && !existing.instanceKey?.startsWith(CARE_PLAN_INSTANCE) ? existing : null;
    if (replaced && plan.isOpen()) {
      replaced.close();
      await waitFor(() => !replaced.isOpen(), 1500);
    }
    // A record the open plan already holds (every value given matches one of its tabs) is not added
    // twice — the model sometimes sends the whole plan again.
    if (plan.isOpen()) {
      const held = plan.entries();
      const same = (a: FieldValues, b: Record<string, unknown>) => Object.entries(a).every(([k, v]) => String(b[k] ?? '').toLowerCase() === String(v).toLowerCase());
      for (const kind of RECORD_KINDS) {
        const fresh = (items[kind] ?? []).filter((item) => !held.some((e) => e.kind === kind && same(item, e.values)));
        if (fresh.length) items[kind] = fresh;
        else delete items[kind];
      }
      total = RECORD_KINDS.reduce((n, k) => n + (items[k]?.length ?? 0), 0);
      if (!total) return fail('All of these are already in the care plan (see its tabs). Add only what the provider asked for that is not there yet — or stop.');
    }
    const before = plan.isOpen() ? plan.entries().length : 0;
    if (plan.isOpen()) plan.add(items);
    else plan.open(items, { instant: !!replaced });
    await waitFor(() => plan.isOpen() && plan.entries().length === before + total, 4000);
    if (replaced?.isOpen()) {
      replaced.close();
      await waitFor(() => !replaced.isOpen(), 1500);
    }
    await sleep(60);
    this.deps.setOpenForm(CARE_PLAN_FORM_ID);
    this.deps.setPendingConfirmation(null);
    this.deps.setPendingSlot(null);
    const next = this.remind(this.carePlanNextStep(modified, []));
    if (errors.length) next.data = { ...(next.data as Record<string, unknown> | undefined), not_taken: errors.map((e) => `${e} — left empty (the provider is asked if it is required); do not guess it`) };
    return next;
  }

  /** What the care plan needs next: the first missing required value, or the one confirmation for all of it. */
  private carePlanNextStep(modified: NonNullable<ToolResult['fieldsModified']>, notes: string[]): ToolResult {
    const plan = CarePlanRegistry.get();
    if (!plan?.isOpen()) return fail('The care plan is no longer open.');
    const entries = plan.entries();
    const nameOf = (kind: RecordKind, values: Record<string, unknown>) => {
      const primary = primaryField(FieldRegistry.getForm(kind)!);
      return primary && values[primary.name] ? String(values[primary.name]) : recordLabels[kind].singular;
    };
    const parts = RECORD_KINDS.map((kind) => {
      const of = entries.filter((e) => e.kind === kind);
      if (!of.length) return null;
      return `${of.length === 1 ? recordLabels[kind].singular : recordLabels[kind].plural} (${of.map((e) => nameOf(kind, e.values)).join(', ')})`;
    }).filter(Boolean);
    const lead = `Care plan for ${this.state().currentPatientName}: ${parts.join('; ')}.`;

    if (notes.length) {
      return fail(`${lead} Not applied: ${notes.join('; ')}. Call fill_open_form with corrected values (or ask the user if the value is unclear).`, { fieldsModified: modified });
    }
    for (const entry of entries) {
      const missing = FieldRegistry.missingRequired(entry.kind, entry.values);
      if (!missing.length) continue;
      const next = missing[0];
      const question = `What ${next.label.toLowerCase()} for the ${recordLabels[entry.kind].singular} "${nameOf(entry.kind, entry.values)}"?`;
      plan.focus(entry.id);
      this.deps.setPendingConfirmation(null);
      this.deps.setPendingSlot({ formId: entry.kind, field: next.name, label: next.label, question });
      FormRegistry.get(entry.kind, CARE_PLAN_INSTANCE + entry.id)?.focusField(next.name);
      return ask(`${lead} ${question}`, { fieldsModified: modified });
    }
    this.stage({
      kind: 'form',
      formId: CARE_PLAN_FORM_ID,
      formTitle: 'Care plan',
      summary: plan.summarize(),
      description: `Save all ${entries.length} records of the care plan for ${this.state().currentPatientName}`,
    });
    return ask(`${lead} Every tab is filled in — review it, then confirm to save all ${entries.length} records, or cancel.`, { fieldsModified: modified });
  }

  private nextStep(def: FormDefinition, controller: FormController, modified: NonNullable<ToolResult['fieldsModified']>, notes: string[]): ToolResult {
    const all = controller.entries ? controller.entries.getAll() : [controller.getValues()];
    const multi = all.length > 1;
    const primary = primaryField(def);
    // Records for several patients are told apart by their patient ("the appointment for Lily Martin").
    const severalPatients = new Set(all.map((v) => v.patient).filter(Boolean)).size > 1;
    const nameOf = (values: Record<string, unknown>, i: number) =>
      `${primary && values[primary.name] ? String(values[primary.name]) : `${def.title.toLowerCase()} ${i + 1}`}${severalPatients && values.patient ? ` for ${patientRefName(values.patient)}` : ''}`;
    const filled = modified.map((m) => `${FieldRegistry.resolveField(def.id, m.field)?.label ?? m.field}: ${m.value}`).join(', ');
    const lead = filled ? `${def.title} form: ${filled}.` : `${def.title} form is open.`;

    // Values that could not be applied go back to the model to correct; the turn is not over.
    if (notes.length) {
      return fail(`${lead} Not applied: ${notes.join('; ')}. Call fill_open_form with corrected values (or ask the user if the value is unclear).`, { fieldsModified: modified });
    }

    for (let i = 0; i < all.length; i++) {
      const missing = FieldRegistry.missingRequired(def.id, all[i]);
      if (!missing.length) continue;
      if (controller.entries && controller.entries.active() !== i) controller.entries.setActive(i);
      const next = missing[0];
      const question = `What ${next.label.toLowerCase()}${multi ? ` for ${nameOf(all[i], i)}` : ''}?`;
      this.deps.setPendingConfirmation(null);
      this.deps.setPendingSlot({ formId: def.id, field: next.name, label: next.label, question });
      controller.focusField(next.name);
      return ask(`${lead} ${question}`, { fieldsModified: modified });
    }

    this.stage({ kind: 'form', formId: def.id, formTitle: def.title, summary: controller.summarize(), description: def.sensitiveDescription });
    const what = multi ? `${def.title} form ready with ${all.length} entries — ${all.map(nameOf).join(', ')}.` : filled ? `${def.title} form ready — ${filled}.` : `${def.title} form is complete.`;
    return ask(`${what} Review it, then confirm to ${def.sensitiveDescription.toLowerCase()}, or cancel.`, { fieldsModified: modified });
  }

  /** A patient named in a record's Patient field: their reference ("Full Name (MRN)"), or why not. */
  private resolvePatientField(raw: FieldScalar): CoerceResult {
    const known = findPatientByRef(this.deps.allPatients(), raw);
    if (known) return { ok: true, value: patientRef(known) };
    const found = this.resolvePatient(String(raw));
    if ('ok' in found) return { ok: false, error: `patient: ${found.message}` };
    return { ok: true, value: patientRef(found.patient) };
  }

  /**
   * Find the patient each record names. Any that cannot be found for certain stops everything — a
   * record must never fall back to the selected patient because another one's name was unclear.
   * `first`: the first patient named (the care plan, which belongs to one patient, selects them).
   */
  private async resolveItemPatients(items: FieldValues[]): Promise<{ items: FieldValues[]; heard: string[]; first?: Patient } | ToolResult> {
    const all = this.deps.allPatients();
    const out: FieldValues[] = [];
    const heard: string[] = [];
    let first: Patient | undefined;
    for (const item of items) {
      const raw = item.patient;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        out.push(item);
        continue;
      }
      let patient = findPatientByRef(all, raw);
      if (!patient) {
        const found = this.resolvePatient(String(raw));
        if ('ok' in found) return { ...found, message: `Nothing was opened — ${found.message}` };
        patient = found.patient;
        if (found.heardAs) heard.push(`"${found.heardAs}" was taken as ${patient.fullName}`);
      }
      first ??= patient;
      out.push({ ...item, patient: patientRef(patient) });
    }
    return { items: out, heard, first };
  }

  /** A provider named in a field: the full name, or enough of it to identify exactly one provider. */
  private resolveProvider(field: string, raw: FieldScalar): CoerceResult {
    const names = this.deps.providerNames();
    const said = String(raw).trim().toLowerCase();
    const exact = names.find((n) => n.toLowerCase() === said);
    if (exact) return { ok: true, value: exact };
    const words = said.replace(/^(dr\.?|doctor)\s+/, '').split(/\s+/).filter(Boolean);
    const hits = names.filter((n) => words.every((w) => n.toLowerCase().split(/\s+/).includes(w)));
    if (hits.length === 1) return { ok: true, value: hits[0] };
    return { ok: false, error: `${field} must name one provider: ${(hits.length ? hits : names).join(', ')}` };
  }

  async fillOpenForm(fields: FieldValues): Promise<ToolResult> {
    const controller = FormRegistry.active();
    if (!controller) return fail('No form is open. Use a create_* or update_* tool to open one.');
    // A question the app asked during this very turn has not been answered by the provider yet:
    // the model filling it would be a guess (e.g. a dose nobody said).
    const slot = this.state().pendingSlot;
    if (this.origin === 'assistant' && slot && JSON.stringify(slot) !== this.slotAtTurnStart) {
      const answered = Object.keys(fields).find((name) => FieldRegistry.resolveField(slot.formId, name)?.name === slot.field);
      // A value the provider actually said ("Metformin") is theirs, not a guess — only unsaid ones are refused.
      const spoken = answered !== undefined && String(fields[answered]).trim().length > 1 && this.said.includes(String(fields[answered]).toLowerCase().trim());
      if (answered && !spoken) {
        const rest = { ...fields };
        delete rest[answered];
        // Refused for the model only: the provider is still asked the original question.
        if (!Object.keys(rest).length) return fail(`${slot.label} was not filled: the provider has not answered "${slot.question}" yet — never fill it yourself. If the provider asked for something that is not in the care plan yet, add only that (add_care_plan); otherwise stop.`);
        fields = rest;
      }
    }
    return this.fill(controller.formId, controller, [fields], 'active');
  }

  clearFormField(field: string): ToolResult {
    const controller = FormRegistry.active();
    if (!controller) return fail('No form is open.');
    // What this very turn put in the form, the provider has not asked to take out.
    if (this.preparedThisTurn()) return fail('The provider did not ask to clear anything — leave what was just filled in. Add whatever else they asked for, or stop.');
    const def = FieldRegistry.resolveField(controller.formId, field);
    if (!def) return fail(`"${field}" is not a field of the open form.`);
    controller.clearField(def.name);
    this.deps.setPendingConfirmation(null);
    return ok(`Cleared ${def.label}.`, { fieldsModified: [{ formId: controller.formId, field: def.name, value: '' }] });
  }

  async saveOpenForm(): Promise<ToolResult> {
    const pending = this.state().pendingConfirmation;
    // "Save it" while the save is waiting for a yes IS the yes — unless it was only just staged in this turn.
    if (pending?.kind === 'form') return this.confirm();
    if (pending) return ask(`${pending.description} — waiting for the user to confirm.`);
    if (CarePlanRegistry.isOpen()) return this.carePlanNextStep([], []);
    const controller = FormRegistry.active();
    if (!controller) return fail('There is no open form to save.');
    const def = FieldRegistry.getForm(controller.formId)!;
    return this.nextStep(def, controller, [], []);
  }

  /** The assistant is saving or cancelling what it prepared — a form closing now is its doing, not the provider's. */
  private settling = 0;
  isSettling() {
    return this.settling > 0;
  }

  /** The only place data is actually written or removed. */
  async confirm(): Promise<ToolResult> {
    this.settling++;
    try {
      return await this.confirmPending();
    } finally {
      this.settling--;
    }
  }

  private async confirmPending(): Promise<ToolResult> {
    const pending = this.state().pendingConfirmation;
    if (!pending) return fail('Nothing is waiting for confirmation.');
    if (this.origin === 'assistant' && this.turn !== null && this.pendingTurn === this.turn) {
      return fail(
        'Not confirmed: the provider has not said yes — this was only just prepared. If SAID asks for more records, add them now (add_* or add_care_plan); otherwise stop and let the provider confirm.',
      );
    }
    this.pendingTurn = null;

    if (pending.kind === 'inbox_file') {
      this.deps.setPendingConfirmation(null);
      const controller = InboxVoiceRegistry.get();
      if (!controller) return fail('The Inbox is no longer open, so nothing was changed.');
      controller.file(pending.inboxItemIds ?? [], pending.inboxFile !== false);
      return ok(pending.inboxFile !== false ? 'Record filed.' : 'Record moved back to unfiled.');
    }

    if (pending.kind === 'delete' && pending.recordKind && pending.recordIds?.length) {
      for (const id of pending.recordIds) await this.deps.deleteEntity(pending.recordKind, id);
      this.deps.setPendingConfirmation(null);
      const n = pending.recordIds.length;
      return ok(`Deleted all ${n} ${n === 1 ? recordLabels[pending.recordKind as RecordKind].singular : recordLabels[pending.recordKind as RecordKind].plural}.`);
    }
    if (pending.kind === 'delete' && pending.recordKind && pending.recordId) {
      await this.deps.deleteEntity(pending.recordKind, pending.recordId);
      this.deps.setPendingConfirmation(null);
      return ok(`${pending.summary[0]?.value ?? recordLabels[pending.recordKind].singular} deleted.`);
    }

    if (pending.formId === CARE_PLAN_FORM_ID) {
      const plan = CarePlanRegistry.get();
      if (!plan?.isOpen()) {
        this.deps.setPendingConfirmation(null);
        return fail('The care plan is no longer open, so nothing was saved.');
      }
      const errors = await plan.validate();
      if (errors.length) return fail(`The care plan cannot be saved yet: ${errors.slice(0, 3).join('; ')}.`);
      const saved = await plan.submit();
      this.deps.setPendingConfirmation(null);
      this.deps.setPendingSlot(null);
      this.deps.setOpenForm(null);
      return ok(`Care plan saved — ${saved} record${saved === 1 ? '' : 's'} added for ${this.state().currentPatientName}.`);
    }

    const controller = FormRegistry.get(pending.formId);
    if (!controller?.isOpen()) {
      this.deps.setPendingConfirmation(null);
      return fail('The form is no longer open, so nothing was saved.');
    }
    const errors = await controller.validate();
    if (errors.length) return fail(`The form cannot be saved yet: ${errors.slice(0, 3).join('; ')}.`);
    await controller.submit();
    this.deps.setPendingConfirmation(null);
    this.deps.setPendingSlot(null);
    this.deps.setOpenForm(null);
    return ok(`${pending.formTitle} saved.`);
  }

  cancel(): ToolResult {
    const pending = this.state().pendingConfirmation;
    // What this very turn prepared was not cancelled by the provider — they have not even seen it yet.
    // (Their "no" / "cancel" arrives in a later turn, like their "yes".)
    if (this.preparedThisTurn()) {
      return fail('The provider did not ask to cancel — what was just prepared stays open for them. Add whatever else they asked for, or stop.');
    }
    this.pendingTurn = null;
    this.deps.setPendingConfirmation(null);
    this.deps.setPendingSlot(null);
    if (pending?.kind === 'delete') return ok('Cancelled — nothing was deleted.');
    if (pending?.kind === 'inbox_file') return ok(`Cancelled — the record was not ${pending.inboxFile ? 'filed' : 'moved back to unfiled'}.`);    const active = FormRegistry.active();
    if (active) {
      active.close();
      this.deps.setOpenForm(null);
      return ok('Cancelled — the form was closed and nothing was saved.');
    }
    return ok('Cancelled.');
  }

  // ------------------------------------------------------------ information

  patientSummary(): ToolResult {
    const blocked = this.requirePatient('summarise the patient');
    if (blocked) return blocked;
    return ok(this.deps.describePatient(), { speak: true });
  }

  providerOverview(): ToolResult {
    const w = this.deps.getWorkload();
    if (!w) return fail('The signed-in account has no provider schedule.');
    const appt = (a: ProviderWorkload['today'][number]) => ({ id: a.id, patient: a.patientName, patientId: a.patientId, date: a.date, time: a.startTime, type: a.type, reason: a.reason, status: a.status });
    return ok(`Schedule and work queue for ${w.provider.fullName}.`, {
      speak: true,
      data: {
        provider: w.provider.fullName,
        today: w.today.map(appt),
        nextToday: w.nextToday ? appt(w.nextToday) : null,
        nextSevenDays: w.upcoming.map(appt),
        openTasks: w.openTasks.slice(0, 15).map((t) => ({ id: t.id, title: t.title, patient: t.patientName, due: t.dueDate, priority: t.priority, overdue: w.overdueTasks.includes(t) })),
        recallsDue: w.dueRecalls.slice(0, 15).map((r) => ({ id: r.id, reason: r.reason, patient: r.patientName, due: r.dueDate, overdue: w.overdueRecalls.includes(r) })),
        unfiledInbox: { total: w.unfiledInbox.length, needingAttention: w.unfiledInbox.filter((i) => i.attention).map((i) => ({ subject: i.subject, patient: i.patientName, category: i.category })) },
        panelSize: w.panel.length,
      },
    });
  }

  // ----------------------------------------------------------------- inbox

  private async ensureInbox(view: InboxView = 'all'): Promise<InboxVoiceController | ToolResult> {
    let controller = InboxVoiceRegistry.get();
    if (!controller) {
      const patientId = this.state().currentPatientId;
      this.deps.navigate(`/inbox/${view}${patientId ? `?patient=${encodeURIComponent(patientId)}` : ''}`);
      controller = await waitFor(() => InboxVoiceRegistry.get(), 5000);
      if (!controller) return fail('I couldn’t open the Inbox.');
    }
    const ready = controller;
    await waitFor(() => !ready.snapshot().loading, 5000);
    return ready;
  }

  private inboxList(controller: InboxVoiceController) {
    const snap = controller.snapshot();
    return snap.items.slice(0, 15).map((item, i) => ({ position: i + 1, subject: item.subject, category: item.category, patient: item.patientName, received: item.receivedAt.slice(0, 10), filed: snap.isFiled(item.id), attention: item.attention }));
  }

  /**
   * Whose Inbox records a request is about: a patient named in it (no need to select them first — another
   * agent may be selecting someone at the same time), every patient's, the selected one's, or — none of
   * these said — whatever the Inbox shows. Id null: every patient's.
   */
  private inboxScope(args: { patient?: string; scope?: 'selected_patient' | 'all_patients' }): { id: string | null; name?: string } | undefined | ToolResult {
    if (args.patient) {
      const found = this.resolvePatient(args.patient);
      if ('ok' in found) return found;
      return { id: found.patient.id, name: found.patient.fullName };
    }
    if (args.scope === 'all_patients') return { id: null };
    if (args.scope === 'selected_patient') {
      const state = this.state();
      if (!state.currentPatientId) return fail('No patient is selected, so the Inbox cannot be limited to one.');
      return { id: state.currentPatientId, name: state.currentPatientName ?? undefined };
    }
    return undefined;
  }

  private async setInboxScope(controller: InboxVoiceController, scope: { id: string | null }) {
    if (controller.snapshot().scopePatientId === scope.id) return;
    controller.setPatientScope(scope.id);
    await waitFor(() => controller.snapshot().scopePatientId === scope.id, 2000);
  }

  /** Whose records the Inbox shows, in words. */
  private inboxScopeName(scopePatientId: string | null, named?: string) {
    if (!scopePatientId) return ' for all patients';
    return ` for ${named ?? this.deps.allPatients().find((p) => p.id === scopePatientId)?.fullName ?? this.state().currentPatientName ?? 'the selected patient'}`;
  }

  async inboxShow(args: { category?: InboxView; scope?: 'selected_patient' | 'all_patients'; patient?: string; search?: string }): Promise<ToolResult> {
    const scope = this.inboxScope(args);
    if (scope && 'ok' in scope) return scope;
    const controller = await this.ensureInbox(args.category ?? 'all');
    if ('ok' in controller) return controller;
    if (args.category && controller.snapshot().view !== args.category) {
      controller.setView(args.category);
      await waitFor(() => controller.snapshot().view === args.category, 2500);
    }
    if (scope) await this.setInboxScope(controller, scope);
    if (args.search !== undefined) {
      controller.setQuery(args.search);
      await waitFor(() => controller.snapshot().query === args.search, 2000);
    }
    await sleep(40);
    const snap = controller.snapshot();
    const noun = inboxNoun[snap.view];
    const scopeText = this.inboxScopeName(snap.scopePatientId, scope?.name);
    return ok(`Showing ${snap.view === 'all' ? 'the whole Inbox' : categoryMeta[snap.view].label}${scopeText}${snap.query ? `, searched for "${snap.query}"` : ''}: ${snap.items.length} ${snap.items.length === 1 ? noun.one : noun.many}.`, {
      data: this.inboxList(controller),
    });
  }

  private resolveInboxTarget(controller: InboxVoiceController, target: number | 'this' | 'next' | 'previous' | 'last'): { item: InboxItem; position?: number } | ToolResult {
    const snap = controller.snapshot();
    const list = snap.items;
    if (target === 'this') {
      if (snap.openItem) return { item: snap.openItem };
      const ticked = snap.checkedIds.length === 1 ? list.find((i) => i.id === snap.checkedIds[0]) : undefined;
      return ticked ? { item: ticked } : fail('No Inbox record is open or selected.');
    }
    if (!list.length) return fail('The Inbox list on screen is empty.');
    if (target === 'next' || target === 'previous') {
      const open = snap.openItem;
      if (!open) return target === 'next' ? { item: list[0], position: 1 } : fail('No record is open.');
      let index = list.findIndex((i) => i.id === open.id);
      // The open record left the list (filed under "Unfiled only"): its neighbour moved into its place.
      if (index < 0 && this.lastInboxIndex >= 0) index = target === 'next' ? this.lastInboxIndex - 1 : this.lastInboxIndex;
      const next = index + (target === 'next' ? 1 : -1);
      if (next >= list.length) return fail('That was the last record in the list.');
      if (next < 0) return fail('This is the first record in the list.');
      return { item: list[next], position: next + 1 };
    }
    const position = target === 'last' ? list.length : target;
    if (position > list.length) return fail(`There is no ${ordinalWord(position)} record — the list has ${list.length}.`);
    return { item: list[position - 1], position };
  }

  async inboxOpen(target: number | 'this' | 'next' | 'previous' | 'last'): Promise<ToolResult> {
    const controller = await this.ensureInbox();
    if ('ok' in controller) return controller;
    const found = this.resolveInboxTarget(controller, target);
    if ('ok' in found) return found;
    const { item } = found;
    controller.open(item);
    await waitFor(() => controller.snapshot().openItem?.id === item.id, 2500);
    this.lastInboxIndex = controller.snapshot().items.findIndex((i) => i.id === item.id);
    return ok(`Opened ${categoryMeta[item.category].singular} "${item.subject}" for ${item.patientName}.${controller.snapshot().isFiled(item.id) ? ' It is already filed.' : ''}`, {
      data: { subject: item.subject, from: item.from, received: item.receivedAt, status: item.status, preview: item.preview, attention: item.attentionReason ?? null, body: item.body?.slice(0, 1200) ?? null, facts: item.meta },
    });
  }

  inboxClose(): ToolResult {
    const controller = InboxVoiceRegistry.get();
    if (!controller?.snapshot().openItem) return ok('No Inbox record is open.');
    controller.close();
    return ok('Closed the record.');
  }

  inboxFile(file: boolean, target: number | 'this' | 'next' | 'previous' | 'last'): ToolResult {
    const controller = InboxVoiceRegistry.get();
    if (!controller) return fail('The Inbox is not open.');
    const found = this.resolveInboxTarget(controller, target);
    if ('ok' in found) return found;
    const { item } = found;
    // The Inbox spans every patient: filing never depends on who is selected. The record is named with its
    // patient — in the confirmation, and in what is said back.
    const isFiled = controller.snapshot().isFiled(item.id);
    if (file === isFiled) return ok(`"${item.subject}" is already ${file ? 'filed' : 'unfiled'}.`);
    if (getConfirmFiling()) {
      this.stage({
        kind: 'inbox_file',
        formId: 'inbox',
        formTitle: file ? 'File this record?' : 'Unfile this record?',
        summary: [
          { label: 'Record', value: item.subject },
          { label: 'Type', value: categoryMeta[item.category].singular.replace(/^./, (c) => c.toUpperCase()) },
          { label: 'Patient', value: item.patientName },
          { label: 'Received', value: dayjs(item.receivedAt).format('D MMM YYYY') },
        ],
        description: file ? 'Mark this record as reviewed and filed' : 'Move this record back to the unfiled queue',
        inboxItemIds: [item.id],
        inboxFile: file,
      });
      return ask(`${file ? 'File' : 'Unfile'} "${item.subject}" for ${item.patientName}? Please confirm or cancel.`);
    }
    controller.file([item.id], file);
    return ok(file ? `Filed "${item.subject}" for ${item.patientName}.` : `Moved "${item.subject}" for ${item.patientName} back to unfiled.`);
  }

  /**
   * Comment on one Inbox record (the open one, or one by position) or on every record of a kind —
   * "Test is good on all abnormal records". Added at once, without a confirmation (the provider's choice:
   * a comment changes no clinical data, and each one can be deleted from the record).
   * "All" follows the Inbox's patient scope: the selected patient's records, or every patient's.
   */
  async inboxAddComment(args: { text: string; target?: number | 'this' | 'next' | 'previous' | 'last'; which?: 'abnormal' | 'normal' | 'needs_attention' | 'unfiled' | 'all'; category?: InboxView; patient?: string; scope?: 'selected_patient' | 'all_patients' }): Promise<ToolResult> {
    const text = String(args.text ?? '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (!text) return fail('What should the comment say? Nothing was added.');
    let scoped = this.inboxScope(args);
    if (scoped && 'ok' in scoped) return scoped;
    // Whose records a comment on "all normal records" goes on comes from what the provider said — never from
    // the patient the Inbox happens to open on (the selected one: "select Tom Baker and comment on all
    // patients' normal records" is every patient's). On screen already, the Inbox shows what they look at;
    // with nobody selected, it opens on every patient's records.
    const onScreen = !!InboxVoiceRegistry.get();
    if (!scoped && args.which) {
      if (EVERY_PATIENT.test(this.said)) scoped = { id: null };
      // Opening now, the Inbox would show the selected patient's records alone: whose was not said.
      else if (!onScreen && this.state().currentPatientId) return fail(`Whose ${args.which === 'all' ? '' : `${args.which.replace('_', ' ')} `}records? Call again with scope all_patients (every patient's), scope selected_patient, or patient (a name) — as the provider said it. Nothing was added.`);
    }
    const controller = await this.ensureInbox(args.category ?? 'all');
    if ('ok' in controller) return controller;
    if (args.category && controller.snapshot().view !== args.category) {
      controller.setView(args.category);
      await waitFor(() => controller.snapshot().view === args.category, 2500);
    }
    if (scoped) await this.setInboxScope(controller, scoped);
    const snap = controller.snapshot();

    let items: InboxItem[];
    let what: string;
    if (args.which) {
      const matches: Record<NonNullable<typeof args.which>, (i: InboxItem) => boolean> = {
        abnormal: (i) => i.status === 'Abnormal',
        normal: (i) => i.status === 'Normal',
        needs_attention: (i) => i.attention,
        unfiled: (i) => !snap.isFiled(i.id),
        all: () => true,
      };
      items = this.deps
        .inboxItems()
        .filter((i) => (!snap.scopePatientId || i.patientId === snap.scopePatientId) && (!args.category || args.category === 'all' || i.category === args.category) && matches[args.which!](i));
      const noun = inboxNoun[args.category ?? 'all'];
      const kind = { abnormal: 'abnormal ', normal: 'normal ', needs_attention: 'needing-attention ', unfiled: 'unfiled ', all: '' }[args.which];
      const scope = snap.scopePatientId ? this.inboxScopeName(snap.scopePatientId, scoped?.name) : scoped ? ' for all patients' : '';
      if (!items.length) return fail(`There are no ${kind}${noun.many} in the Inbox${scope}. Nothing was added.`);
      what = `${items.length} ${kind}${items.length === 1 ? noun.one : noun.many}${scope}`;
    } else {
      const found = this.resolveInboxTarget(controller, args.target ?? 'this');
      if ('ok' in found) return found;
      items = [found.item];
      what = `"${found.item.subject}" for ${found.item.patientName}`;
    }

    this.deps.addInboxComments(
      items.map((i) => i.id),
      text,
    );
    return ok(`Comment "${text}" added to ${what}.`, { speak: true });
  }

  inboxSelectPatient(): ToolResult {
    const item = InboxVoiceRegistry.get()?.snapshot().openItem;
    if (!item) return fail('No Inbox record is open.');
    if (item.patientId === this.state().currentPatientId) return ok(`${item.patientName} is already the selected patient.`);
    this.deps.setCurrentPatient(item.patientId);
    return ok(`${item.patientName} is now the selected patient.`);
  }

  // ------------------------------------------------ the provider's own appointments

  /**
   * One appointment to change — from the provider's own (`mine`: across their patients, named by patient)
   * or the selected patient's (`patient`: any provider, named by provider): by id or booking code, or by
   * name, narrowed by date and time. Several or none that fit: the model is told, with the candidates.
   */
  private findAppointment(scope: AppointmentScope, args: { appointment?: string; patient?: string; provider?: string; date?: string; time?: string }): { appointment: Appointment } | ToolResult {
    const all = scope === 'mine' ? this.deps.providerAppointments() : (this.deps.getRecords('appointment') as Appointment[]);
    const whose = scope === 'mine' ? 'of yours' : `of ${this.state().currentPatientName ?? 'the patient'}`;
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exact = args.appointment ? all.find((a) => a.id === args.appointment || key(a.code) === key(args.appointment!)) : undefined;
    if (exact) return { appointment: exact };
    const now = dayjs();
    let pool = all.filter((a) => !['Cancelled', 'No Show', 'Completed'].includes(a.status) && !dayjs(`${a.date}T${a.startTime}`).isBefore(now));
    // Mine are told apart by patient; a patient's by provider.
    const who = scope === 'mine' ? (args.patient ?? args.appointment) : (args.provider ?? args.appointment);
    const nameOf = (a: Appointment) => (scope === 'mine' ? a.patientName : a.providerName);
    if (who) {
      const named = pool.filter((a) => key(nameOf(a)).includes(key(who)) || key(who).includes(key(nameOf(a))));
      pool = named.length ? named : soundAlikes(who, pool, nameOf).matches.map((m) => m.item);
    }
    if (args.date) pool = pool.filter((a) => a.date === args.date);
    if (args.time) pool = pool.filter((a) => a.startTime === args.time);
    const brief = (a: Appointment) => ({ id: a.id, date: a.date, time: `${a.startTime}-${a.endTime}`, patient: a.patientName, provider: a.providerName, type: a.type, reason: a.reason, status: a.status });
    if (pool.length === 1) return { appointment: pool[0] };
    if (!pool.length)
      return fail(`No upcoming appointment ${whose} matches${who ? ` "${who}"` : ''}${args.date ? ` on ${args.date}` : ''}${args.time ? ` at ${args.time}` : ''}.`, {
        data: all.filter((a) => a.date >= now.format('YYYY-MM-DD') && a.status !== 'Cancelled').slice(0, 10).map(brief),
      });
    return fail(`${pool.length} appointments ${whose} match — ask the provider which one (date and time), or use its id.`, { data: pool.slice(0, 8).map(brief) });
  }

  /** Open My Appointments (the provider's own schedule) and wait for it. */
  private async ensureSchedule(): Promise<ScheduleController | ToolResult> {
    const page = PageRegistry.get('my-appointments')!;
    if (this.state().currentPageId !== page.id || !ScheduleRegistry.get()) {
      const nav = await this.goTo(page);
      if (!nav.ok) return nav;
    }
    return (await waitFor(() => ScheduleRegistry.get(), 4000)) ?? fail('My Appointments did not open.');
  }

  /** Where the cancel / reschedule dialogs live for a scope: My Appointments, or the patient's Appointments tab. */
  private async appointmentDialogs(scope: AppointmentScope): Promise<PatientAppointmentsController | ToolResult> {
    if (scope === 'mine') return this.ensureSchedule();
    const blocked = this.requirePatient("change a patient's appointment");
    if (blocked) return blocked;
    const tab = await this.ensureModule('appointment');
    if ('ok' in tab) return tab;
    return (await waitFor(() => PatientAppointmentsRegistry.get(), 4000)) ?? fail('The Appointments tab did not open.');
  }

  /** The provider's own appointments: shows them on My Appointments and returns them. */
  async myAppointments(args: { when?: ScheduleView; date?: string; patient?: string }): Promise<ToolResult> {
    const schedule = await this.ensureSchedule();
    if ('ok' in schedule) return schedule;
    const when = args.date ? 'all' : (args.when ?? 'upcoming');
    schedule.setView(when);
    schedule.setSearch(args.patient ?? '');
    const today = dayjs().format('YYYY-MM-DD');
    const inView = (a: Appointment) =>
      when === 'today' ? a.date === today : when === 'upcoming' ? a.date >= today && a.status !== 'Cancelled' : when === 'past' ? a.date < today : when === 'cancelled' ? a.status === 'Cancelled' : true;
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const rows = this.deps
      .providerAppointments()
      .filter((a) => inView(a) && (!args.date || a.date === args.date) && (!args.patient || key(a.patientName).includes(key(args.patient))))
      .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
    return ok(`${rows.length} ${when === 'all' ? '' : `${when} `}appointment${rows.length === 1 ? '' : 's'} of yours${args.date ? ` on ${args.date}` : ''}${args.patient ? ` with ${args.patient}` : ''}. My Appointments is open.`, {
      speak: true,
      data: rows.slice(0, 25).map((a) => ({
        id: a.id,
        date: a.date,
        time: `${a.startTime}-${a.endTime}`,
        patient: a.patientName,
        type: a.type,
        reason: a.reason,
        status: a.status,
        cancellationNote: a.cancellationNote,
        rescheduled: a.rescheduleHistory?.at(-1)?.comment,
      })),
    });
  }

  /** Cancel an appointment: its cancel dialog with the provider's note; saved on their yes; the patient is told why. */
  async cancelAppointment(scope: AppointmentScope, args: { appointment?: string; patient?: string; provider?: string; date?: string; time?: string; note?: string }): Promise<ToolResult> {
    const found = this.findAppointment(scope, args);
    if ('ok' in found) return found;
    const dialogs = await this.appointmentDialogs(scope);
    if ('ok' in dialogs) return dialogs;
    const a = found.appointment;
    if (!dialogs.openCancel(a.id)) return fail(`The appointment with ${a.patientName} on ${a.date} at ${a.startTime} cannot be cancelled (it is past, completed or already cancelled).`);
    const form = await waitFor(() => (FormRegistry.get('appointment_cancel')?.isOpen() ? FormRegistry.get('appointment_cancel') : undefined), 3000);
    if (!form) return fail('The cancel dialog did not open.');
    const filled = await this.fill('appointment_cancel', form, [args.note ? { cancellationNote: args.note } : {}], 'active');
    return { ...filled, message: `Cancelling ${a.patientName}'s appointment with ${a.providerName} on ${dayjs(a.date).format('D MMM')} at ${a.startTime} (the patient is told the reason). ${filled.message}` };
  }

  /** Move an appointment: its reschedule dialog, the new slot and the provider's comment; saved on their yes; the patient is told. */
  async rescheduleAppointment(
    scope: AppointmentScope,
    args: { appointment?: string; patient?: string; provider?: string; date?: string; time?: string; newDate?: string; newTime?: string; durationMinutes?: number; comment?: string },
  ): Promise<ToolResult> {
    const found = this.findAppointment(scope, args);
    if ('ok' in found) return found;
    const dialogs = await this.appointmentDialogs(scope);
    if ('ok' in dialogs) return dialogs;
    const a = found.appointment;
    if (!dialogs.openReschedule(a.id)) return fail(`The appointment with ${a.patientName} on ${a.date} at ${a.startTime} cannot be rescheduled (it is past, completed or cancelled).`);
    const form = await waitFor(() => (FormRegistry.get('appointment_reschedule')?.isOpen() ? FormRegistry.get('appointment_reschedule') : undefined), 3000);
    if (!form) return fail('The reschedule dialog did not open.');
    await sleep(80); // the dialog starts on the current slot
    const lead = `Rescheduling ${a.patientName}'s appointment with ${a.providerName} (now ${dayjs(a.date).format('D MMM')} at ${a.startTime}); the patient is told the new time and reason.`;
    const values: FieldValues = {};
    if (args.newDate) values.date = args.newDate;
    if (args.newTime) values.startTime = args.newTime;
    if (args.durationMinutes) values.durationMinutes = args.durationMinutes;
    if (args.comment) values.comment = args.comment;
    if (!args.newDate && !args.newTime) {
      // Nothing to move it to yet: the provider is asked, never a slot guessed.
      if (args.comment) await this.fill('appointment_reschedule', form, [{ comment: args.comment }], 'active');
      const question = `What new date and time for ${a.patientName}'s appointment?`;
      this.deps.setPendingConfirmation(null);
      this.deps.setPendingSlot({ formId: 'appointment_reschedule', field: 'startTime', label: 'New time', question });
      form.focusField('date');
      return ask(`${lead} ${question}`);
    }
    const filled = await this.fill('appointment_reschedule', form, [values], 'active');
    return { ...filled, message: `${lead} ${filled.message}` };
  }

  cancelMyAppointment(args: Parameters<AppRuntime['cancelAppointment']>[1]) {
    return this.cancelAppointment('mine', args);
  }

  rescheduleMyAppointment(args: Parameters<AppRuntime['rescheduleAppointment']>[1]) {
    return this.rescheduleAppointment('mine', args);
  }

  // ----------------------------------------------------------------- lists

  /** Search, filter and page the list on screen — through the same state its controls use. */
  async controlList(args: { search?: string; filter?: string; value?: string; clear?: boolean; page?: number | 'next' | 'previous' | 'first' | 'last' }): Promise<ToolResult> {
    const list = ListRegistry.active();
    if (!list) return fail('There is no list on screen. Open the Patients page or a Summary tab first.');
    const before = JSON.stringify(list.state());
    if (args.clear) list.clearAll();
    if (args.search !== undefined) {
      if (!list.searchable) return fail(`The ${list.name} list cannot be searched.`);
      list.setSearch(args.search);
    }
    if (args.filter) {
      const q = args.filter.toLowerCase();
      const filter = list.filters.find((f) => f.key.toLowerCase() === q || f.label.toLowerCase() === q);
      if (!filter) return fail(`The ${list.name} list has no "${args.filter}" filter. Filters: ${list.filters.map((f) => f.label).join(', ') || 'none'}.`);
      if (!args.value || /^(all|any|none|clear)$/i.test(args.value)) list.setFilter(filter.key, null);
      else {
        const option = filter.options.find((o) => o.toLowerCase() === args.value!.toLowerCase());
        if (!option) return fail(`${filter.label} can be: ${filter.options.join(', ')}.`);
        list.setFilter(filter.key, option);
      }
    }
    if (args.page !== undefined) {
      const { page, pageCount } = list.state();
      const target = args.page === 'next' ? page + 1 : args.page === 'previous' ? page - 1 : args.page === 'first' ? 1 : args.page === 'last' ? pageCount : args.page;
      if (target < 1 || target > pageCount) return fail(`There is no page ${target} — the ${list.name} list has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
      list.setPage(target);
    }
    // Report what the list shows once it has re-rendered, not the state from before the change.
    await waitFor(() => JSON.stringify(list.state()) !== before, 1000);
    const s = list.state();
    const filters = Object.entries(s.filters).map(([k, v]) => `${list.filters.find((f) => f.key === k)?.label ?? k}: ${v}`);
    return ok(`The ${list.name} list shows ${s.shown} of ${s.total}${s.search ? ` matching "${s.search}"` : ''}${filters.length ? ` (${filters.join(', ')})` : ''}, page ${s.page} of ${s.pageCount}.`);
  }

  // ------------------------------------------------------------ AI Summary

  async addExtractedItem(kind: RecordKind, position: number): Promise<ToolResult> {
    const summary = AiSummaryRegistry.get();
    if (!summary) return fail('The AI Summary tab is not open.');
    const items = summary.items().filter((i) => i.kind === kind);
    if (!summary.add(kind, position)) return fail(items.length ? `There are ${items.length} ${recordLabels[kind].plural} to add; there is no number ${position}.` : `The AI Summary has no ${recordLabels[kind].plural} to add.`);
    const form = await waitFor(() => FormRegistry.get(kind)?.isOpen() && FormRegistry.get(kind), 3000);
    if (!form) return fail(`The ${recordLabels[kind].singular} form did not open.`);
    await sleep(80);
    return this.fill(kind, form, [{}], 'active');
  }

  // ------------------------------------------------------------- summaries

  /**
   * A summary of what was asked about — any page, the dashboard, Inbox records, a patient's chart. Nothing on
   * screen moves: it opens in the Summary panel, and the reply is one line.
   */
  async summarize(what: string | undefined, opts: { llm?: ChatLLM | null; signal?: AbortSignal } = {}): Promise<ToolResult> {
    return (await this.summaryOf(what, opts)).result;
  }

  /** The same, with what was written (the Summary Agent's trace). */
  async summaryOf(what: string | undefined, opts: { llm?: ChatLLM | null; signal?: AbortSignal } = {}): Promise<{ result: ToolResult; outcome?: SummaryOutcome }> {
    if (!this.deps.summarize) return { result: fail('Summaries are not available here.') };
    // What the model said it is of; without it, the provider's own words this turn.
    const text = what?.trim() || this.said;
    // `said`: what the provider said this turn — what the summary is of when the task's words do not say.
    const outcome = await this.deps.summarize({ text, said: this.said, llm: opts.llm, signal: opts.signal });
    const result = ok(outcome.empty ? `${outcome.text} (The Summary panel shows it.)` : `Here's the summary — ${outcome.title}, ${outcome.scope}. It's open in the Summary panel.`, {
      data: { summary: outcome.text, of: outcome.title, scope: outcome.scope },
    });
    return { result, outcome };
  }

  // ------------------------------------------------------------- dashboard

  async setDashboardPanel(open: boolean): Promise<ToolResult> {
    if (!open) {
      this.deps.setDashboardPanel(false);
      return ok('Closed the dashboard summary.');
    }
    await this.goTo(PageRegistry.get('dashboard')!);
    this.deps.setDashboardPanel(true);
    return ok('Your dashboard summary is open on the right.');
  }

  // --------------------------------------------------------- configuration

  async aiConfiguration(): Promise<ToolResult> {
    const { llm } = this.deps.aiSettings();
    let installed: unknown = null;
    try {
      installed = (await this.deps.listModels(llm.provider, llm.apiUrl)).map((m) => ({ name: m.name, size: m.parameterSize, quantization: m.quantization, tool_calling: m.tools }));
    } catch (e) {
      installed = `the runtime is not reachable: ${(e as Error).message}`;
    }
    let speech: unknown;
    try {
      const c = await this.deps.getSpeechConfig();
      const current = c.models.find((m) => m.repo === c.settings.repo && m.gguf_file === c.settings.gguf_file);
      speech = {
        running: c.engine.engine,
        model: current?.label ?? c.settings.repo,
        backend: c.settings.backend,
        cpu_threads: c.settings.threads,
        pause_ms: c.settings.endpoint_ms,
        live_text_ms: c.settings.partial_ms,
        models: c.models.map((m) => ({ model: m.label, downloaded: m.downloaded, available: m.available, why_not: m.reason || undefined })),
        backends: c.backends.map((b) => ({ backend: b.id, installed: b.installed, available: b.available, why_not: b.reason || undefined })),
      };
    } catch (e) {
      speech = `the bridge is not reachable: ${(e as Error).message}`;
    }
    return ok('The AI configuration.', {
      speak: true,
      data: {
        language_model: { runtime: llm.provider, server: llm.apiUrl, model: llm.model, context_window: llm.numCtx, gpu_layers: llm.numGpu, timeout_seconds: Math.round(llm.timeoutMs / 1000), max_steps: llm.maxSteps },
        installed_models: installed,
        speech_recognition: speech,
      },
    });
  }

  async setLanguageModel(args: { model?: string; runtime?: LLMProviderKind; server_url?: string; context_window?: number; gpu_layers?: number; timeout_seconds?: number; max_steps?: number }): Promise<ToolResult> {
    const current = this.deps.aiSettings().llm;
    const next: AIConfig['llm'] = {
      ...current,
      provider: args.runtime ?? current.provider,
      apiUrl: args.server_url ?? current.apiUrl,
      numCtx: args.context_window ?? current.numCtx,
      numGpu: args.gpu_layers ?? current.numGpu,
      timeoutMs: args.timeout_seconds ? args.timeout_seconds * 1000 : current.timeoutMs,
      maxSteps: args.max_steps ?? current.maxSteps,
    };
    if (next.numCtx < 4096) return fail('The context window must be at least 4096 tokens: the tools alone take about 8k.');
    let models: ModelInfo[];
    try {
      models = await this.deps.listModels(next.provider, next.apiUrl);
    } catch (e) {
      return fail(`Cannot reach the ${next.provider} runtime at ${next.apiUrl}: ${(e as Error).message}`);
    }
    if (args.model) {
      const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const wanted = key(args.model);
      const exact = models.find((m) => m.name.toLowerCase() === args.model!.toLowerCase()) ?? models.find((m) => key(m.name) === wanted);
      const partial = models.filter((m) => key(m.name).includes(wanted));
      const model = exact ?? (partial.length === 1 ? partial[0] : undefined);
      if (!model) {
        return fail(partial.length > 1 ? `Several models match "${args.model}": ${partial.map((m) => m.name).join(', ')}.` : `No installed model matches "${args.model}". Installed: ${models.map((m) => m.name).join(', ') || 'none'}.`, {
          data: models.map((m) => ({ name: m.name, tool_calling: m.tools })),
        });
      }
      if (model.tools === false) return fail(`${model.name} cannot call tools, so the assistant cannot run on it. Choose a model with tool calling.`);
      next.model = model.name;
    } else if (!models.some((m) => m.name === next.model)) {
      return fail(`${next.model} is not installed in the ${next.provider} runtime at ${next.apiUrl}. Installed: ${models.map((m) => m.name).join(', ') || 'none'}.`);
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return ok(`The assistant already runs on ${current.model} with these settings.`, { final: true });
    this.deps.switchLanguageModel(next);
    const changed = next.model !== current.model ? `Switching to ${next.model}` : 'Applying the new language model settings';
    return ok(`${changed} — loading it takes about a minute; I'll say when it's ready.`, { final: true, speak: true });
  }

  async setSpeechRecognition(args: { model?: string; backend?: SttSettings['backend']; precision?: 'int8' | 'fp32'; cpu_threads?: number; pause_ms?: number; live_text_ms?: number }): Promise<ToolResult> {
    let config: SttConfig;
    try {
      config = await this.deps.getSpeechConfig();
    } catch (e) {
      return fail(`Cannot reach the speech bridge: ${(e as Error).message}`);
    }
    const next: SttSettings = { ...config.settings };
    if (args.model) {
      const q = args.model.toLowerCase();
      const hits = config.models.filter((m) => `${m.label} ${m.repo} ${m.gguf_file ?? ''}`.toLowerCase().includes(q));
      if (hits.length !== 1) {
        return fail(hits.length ? `Several speech models match "${args.model}": ${hits.map((m) => m.label).join('; ')}.` : `No speech model matches "${args.model}".`, {
          data: config.models.map((m) => ({ model: m.label, downloaded: m.downloaded, available: m.available, why_not: m.reason || undefined })),
        });
      }
      const model = hits[0];
      if (!model.available) return fail(`${model.label} cannot run here: ${model.reason}.`);
      Object.assign(next, { repo: model.repo, engine: model.engine, gguf_file: model.gguf_file });
      if (model.engine === 'onnx') {
        if (next.backend === 'vulkan') next.backend = 'cpu';
        next.precision ??= 'int8';
      }
    }
    if (args.backend) {
      // Parakeet (ONNX) and Omi (GGUF) run on different sets of devices.
      const devices = next.engine === 'onnx' ? (config.onnx_backends ?? []) : config.backends;
      const backend = devices.find((b) => b.id === args.backend);
      if (!backend) return fail(`${next.engine === 'onnx' ? 'Parakeet' : 'This model'} cannot run on ${args.backend.toUpperCase()}; it can use ${devices.map((b) => b.id.toUpperCase()).join(' or ')}.`);
      if (!backend.available) return fail(`The ${args.backend.toUpperCase()} backend is not available here: ${backend.reason}.`);
      next.backend = args.backend;
    }
    if (args.precision) {
      if (next.engine !== 'onnx') return fail('Only the Parakeet model has an int8 / fp32 choice.');
      next.precision = args.precision;
    }
    if (args.cpu_threads !== undefined) next.threads = args.cpu_threads;
    if (args.pause_ms !== undefined) next.endpoint_ms = args.pause_ms;
    if (args.live_text_ms !== undefined) next.partial_ms = args.live_text_ms;
    if (JSON.stringify(next) === JSON.stringify(config.settings)) return ok('Speech recognition already uses these settings.');
    try {
      const saved = await this.deps.saveSpeechConfig(next);
      return ok(`Speech recognition updated — ${saved.engine.engine}, pause ${saved.settings.endpoint_ms} ms.`, { speak: true });
    } catch (e) {
      return fail(`The speech settings were not changed: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------ application

  signOut(): ToolResult {
    this.deps.signOut();
    return ok('Signed out.', { final: true });
  }

  setSpokenReplies(on: boolean): ToolResult {
    this.deps.setSpokenReplies(on);
    return ok(on ? 'Spoken replies are on.' : 'Spoken replies are off.');
  }

  setSidebarCollapsed(collapsed: boolean): ToolResult {
    this.deps.setSidebarCollapsed(collapsed);
    return ok(collapsed ? 'Sidebar collapsed.' : 'Sidebar expanded.');
  }

  openHelp(): ToolResult {
    this.deps.openHelp();
    return ok('The list of what I can do is open.');
  }

  // ----------------------------------------------------------------- voice

  stopListening(): ToolResult {
    this.deps.stopListening();
    return ok('The microphone is off.');
  }

  takeNote(text?: string): ToolResult {
    this.deps.takeNote(text);
    if (text) return ok(`Opened the AI Summary and extracting the note${this.state().currentPatientId ? '' : ' — select a patient before saving the items'}.`);
    // Everything said next is the note, not a command: nothing else may run in this turn.
    return ask('Dictation is on — say the note; pause when you are done.', { final: true });
  }
}

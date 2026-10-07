/**
 * Every tool the assistant can call. The model chooses among these on its own;
 * nothing else decides what an utterance means.
 *
 * Schemas are generated from the registries rather than written out: page ids
 * and descriptions from the PageRegistry, record fields (names, types, select
 * options, format hints) from the FieldRegistry. Adding a field to a form or a
 * page to the app changes what the model is told automatically.
 *
 * The tool list is identical on every request (nothing session-specific is in
 * it), so the runtime keeps it in its prompt cache. Live data the model needs —
 * provider names, patients, records — comes back from the tools themselves.
 */
import { z } from 'zod';
import { FieldRegistry, type FieldDefinition } from '@/registry/fieldRegistry';
import { PageRegistry } from '@/registry/pageRegistry';
import { RECORD_KINDS, type RecordKind } from '@/types/records';
import type { FieldValues } from '@/types/ai';
import { LLM_PROVIDERS, type LLMProviderKind } from '@/services/ai/config';
import { defineTool, noArgs, type Tool } from './tool';

const plural: Record<RecordKind, string> = { medication: 'medications', diagnosis: 'diagnoses', task: 'tasks', recall: 'recalls', appointment: 'appointments' };

/** Accept an option in any letter case, return it exactly as the option is written. */
function optionEnum(options: string[]) {
  return z.preprocess((v) => (typeof v === 'string' ? (options.find((o) => o.toLowerCase() === v.trim().toLowerCase()) ?? v) : v), z.enum(options as [string, ...string[]]));
}

function fieldSchema(field: FieldDefinition): z.ZodTypeAny {
  // The field name already says what it is; the description only carries what the name does not.
  // Whether a field is required is not the model's concern: a value the provider did not say is left
  // out and the app asks for it — telling the model "required" only tempts it to make one up.
  const notes = [field.hint ?? ''].filter(Boolean);
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case 'number':
      schema = z.number();
      break;
    case 'checkbox':
      schema = z.boolean();
      break;
    case 'date':
      schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
      notes.push('YYYY-MM-DD');
      break;
    case 'time':
      schema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm');
      notes.push('HH:mm');
      break;
    case 'select':
      schema = field.options ? optionEnum(field.options) : z.string();
      if (field.optionsFrom === 'providers') notes.push("a provider's name");
      break;
    default:
      schema = z.string();
  }
  return notes.length ? schema.optional().describe(notes.join('; ')) : schema.optional();
}

/**
 * The fields of a form as an object schema: every field optional (the app asks for missing required ones).
 * A field under another name ("name" for the drug) is kept, not silently dropped: the app takes known
 * aliases as the field and tells the model about any other name — nothing said is lost without a word.
 */
function formSchema(formId: string) {
  const def = FieldRegistry.getForm(formId)!;
  return z.object(Object.fromEntries(def.fields.map((f) => [f.name, fieldSchema(f)]))).passthrough();
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);
/**
 * The same records for each of several patients ("…to each of Liam Martin, Harry White and Lily
 * Martin"): the app makes one copy per patient, so the model never has to repeat — or mix — them.
 */
const forPatients = z
  .array(z.string())
  .optional()
  .describe('"To each of" / "for all of" several patients: their full names here, and every record listed ONCE (no patient field) — each patient gets all of them. Only records that differ per patient carry their own patient field. Omit for the selected patient');
const recordKind = z.enum(RECORD_KINDS);
const inboxTarget = z
  .union([z.number().int().positive(), z.enum(['this', 'next', 'previous', 'last'])])
  .describe('A position in the Inbox list on screen (1 = first), or this / next / previous / last');

/** JSON sent as text is the JSON it holds. */
function parsedJson(v: unknown): unknown {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * The list an add_* tool takes, as small models send it: one record on its own (its fields at the top level, or
 * one object instead of a list), or the list as JSON text — read as the list it means. Nothing is added.
 */
export function listShaped(raw: Record<string, unknown>, key: string, fields: string[]): Record<string, unknown> {
  const out = { ...raw };
  let list = parsedJson(out[key]);
  if (list && !Array.isArray(list) && typeof list === 'object') list = [list];
  if (list === undefined) {
    const own = Object.fromEntries(Object.entries(out).filter(([k]) => fields.includes(k) && k !== 'patient'));
    if (Object.keys(own).length) {
      list = [own];
      for (const k of Object.keys(own)) delete out[k];
    }
  }
  if (Array.isArray(list)) out[key] = list.map((r) => parsedJson(r));
  if (out.for_patients !== undefined) out.for_patients = parsedJson(out.for_patients);
  return out;
}

export type RecordKindToolName = 'add_care_plan' | 'update_record' | 'delete_record' | 'list_records';

const CARE_PLAN_ALL_KINDS =
  'Add records of SEVERAL kinds at once — e.g. medications plus a diagnosis, a task, a recall and an appointment said in one request. Opens the Care Plan on the Summary: one tab per kind, one tab per record, all filled with what was said, saved together after one confirmation. Give patient to select that patient first. Each list uses the same fields as the matching add_* tool; a dose, frequency or duration said once after a list of drugs applies to each drug of the list (each medication gets its own copy), unless a drug was said with its own.';

/**
 * The tools that take a record kind, over these kinds only. With every kind they are the single
 * assistant's tools, word for word; a specialist of the multi-agent mode gets them over the kinds it owns
 * (the Medication Agent: medications only; the Appointments Agent: appointments only …). The same runtime
 * methods run either way — only what the model may ask for is narrower.
 */
export function recordKindTools(kinds: readonly RecordKind[] = RECORD_KINDS): Record<RecordKindToolName, Tool> {
  const all = kinds.length === RECORD_KINDS.length;
  const kindEnum = z.enum(kinds as [RecordKind, ...RecordKind[]]);
  const kindList = kinds.map((k) => plural[k]).join(', ');
  return {
    add_care_plan: defineTool({
      name: 'add_care_plan',
      description: all
        ? CARE_PLAN_ALL_KINDS
        : `Add records of SEVERAL kinds at once (${kindList}) said in one request. Opens the Care Plan on the Summary: one tab per kind, one tab per record, all filled with what was said, saved together after one confirmation. Give patient to select that patient first. Each list uses the same fields as the matching add_* tool; a dose, frequency or duration said once after a list of drugs applies to each drug of the list (each medication gets its own copy), unless a drug was said with its own.`,
      parameters: z.object({
        patient: z.string().optional().describe('Patient full name, id or MRN when the provider names one; omit for the selected patient'),
        for_patients: forPatients,
        ...Object.fromEntries(kinds.map((kind) => [plural[kind], z.array(formSchema(kind)).optional()])),
      }),
      progress: () => 'Opening the care plan…',
      run: (args, { runtime }) => {
        const { patient, for_patients, ...lists } = args as { patient?: string; for_patients?: string[] } & Record<string, FieldValues[] | undefined>;
        return runtime.addCarePlan({ patient, forPatients: for_patients, items: Object.fromEntries(RECORD_KINDS.map((kind) => [kind, lists[plural[kind]] ?? []])) });
      },
    }),
    update_record: defineTool({
      name: 'update_record',
      description:
        "Change an existing record of the selected patient (or the patient named): opens it for editing and writes only the given changes, then asks for confirmation. `changes` holds ONLY the fields the provider is changing, with the same names and values as the matching add_* tool (e.g. {\"frequency\": \"Twice daily\"}, {\"status\": \"Discontinued\"}) — never the record's other fields.",
      parameters: z.object({
        kind: kindEnum,
        record: z.string().describe("The record's id if you have it, otherwise its name/title as the user said it — no need to look it up first"),
        changes: z.record(z.string(), scalar).describe('Field name → new value, only the fields being changed'),
        patient: z.string().optional().describe('The patient the provider named, when not the selected one — they are selected first'),
      }),
      progress: ({ kind }) => `Opening the ${kind} for editing…`,
      run: ({ kind, record, changes, patient }, { runtime }) => runtime.updateRecord(kind, record, changes, patient),
    }),
    delete_record: defineTool({
      name: 'delete_record',
      description:
        'Delete a record of the selected patient (or the patient named) — or, with all: true, EVERY record of that kind ("delete all medications": no record, no other field). Shows what will be deleted and asks the provider to confirm; nothing is deleted until they do.',
      parameters: z.object({
        kind: kindEnum,
        record: z.string().optional().describe("One record: its id if you have it, otherwise its name/title as the user said it. Leave out with all: true"),
        all: z.boolean().optional().describe('true only when the provider asked to delete ALL of them ("delete all medications")'),
        patient: z.string().optional().describe('The patient the provider named, when not the selected one — they are selected first'),
      }),
      progress: ({ kind, all }) => (all ? `Gathering every ${kind}…` : `Finding the ${kind}…`),
      run: ({ kind, record, all, patient }, { runtime }) => runtime.deleteRecord(kind, record, { all: all === true, patient }),
    }),
    list_records: defineTool({
      name: 'list_records',
      description: "The SELECTED PATIENT's (or the named patient's) records of one kind (with ids), shown in their Summary tab — to answer questions about that patient's records or find a record's id. Not for the provider's own schedule (get_provider_overview).",
      parameters: z.object({
        kind: kindEnum,
        status: z.string().optional().describe('Only records with this status, e.g. Active, Open, Due'),
        search: z.string().optional().describe('Only records with these words in them (a drug, a condition, a title) — to search or get one'),
        patient: z.string().optional().describe('The patient the provider named, when not the selected one — they are selected first'),
      }),
      progress: ({ kind, search }) => (search ? `Searching the ${plural[kind]} for “${search}”…` : `Reading the ${plural[kind]}…`),
      run: ({ kind, status, search, patient }, { runtime }) => runtime.listRecords(kind, status, patient, search),
    }),
  };
}

export function buildTools(): Tool[] {
  const pages = PageRegistry.all();
  const pageIds = pages.map((p) => p.id) as [string, ...string[]];
  const pageList = pages.map((p) => `${p.id} (${p.title}${p.requiresPatient ? ', needs a patient' : ''})`).join(', ');
  const patientFields = formSchema('patient');
  const patientFieldNames = FieldRegistry.getForm('patient')!.fields.map((f) => f.name) as [string, ...string[]];
  const summaryTabs = PageRegistry.summaryTabs().map((p) => p.id) as [string, ...string[]];
  const kindTools = recordKindTools();

  const tools: Tool[] = [
    // ---------------------------------------------------------------- pages
    defineTool({
      name: 'open_page',
      description: `Open a page or a Summary tab: ${pageList}.`,
      parameters: z.object({ page: z.enum(pageIds).describe('Page id') }),
      progress: ({ page }) => `Opening ${PageRegistry.get(page)?.title ?? page}…`,
      run: ({ page }, { runtime }) => runtime.openPage(page),
    }),
    defineTool({
      name: 'go_back',
      description: 'Go back to the previous screen (in the Inbox: close the open record).',
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.goBack(),
    }),
    defineTool({
      name: 'scroll_page',
      description: 'Scroll the current page.',
      parameters: z.object({ direction: z.enum(['up', 'down', 'top', 'bottom']) }),
      run: async ({ direction }, { runtime }) => runtime.scroll(direction),
    }),
    defineTool({
      name: 'dashboard_summary_panel',
      description:
        "Show (or hide) the summary of the provider's day in the panel on the right of the Dashboard. Use it whenever the provider asks for a summary or overview of their day or dashboard; the summary is shown there, not in your reply.",
      parameters: z.object({ open: z.boolean() }),
      progress: () => 'Opening your dashboard summary…',
      run: ({ open }, { runtime }) => runtime.setDashboardPanel(open),
    }),
    defineTool({
      name: 'control_list',
      description:
        'Search, filter or page the list on screen (see CONTEXT: list on screen), e.g. {"filter": "Status", "value": "Active"}, {"page": "next"}, {"search": "khan"}, {"clear": true}.',
      parameters: z.object({
        search: z.string().optional().describe('Text to search for; "" clears the search'),
        filter: z.string().optional().describe('A filter of the list, by its name'),
        value: z.string().optional().describe('The option to filter by; "all" removes that filter'),
        clear: z.boolean().optional().describe('Clear the search and every filter'),
        page: z.union([z.number().int().positive(), z.enum(['next', 'previous', 'first', 'last'])]).optional(),
      }),
      run: (args, { runtime }) => runtime.controlList(args),
    }),
    defineTool({
      name: 'summarize',
      description:
        "Write a summary of anything in the app — the dashboard or the provider's day, Inbox records (\"all normal inbox records\", \"abnormal labs\", \"Tom Baker's unfiled radiology\"), any page or tab (\"this page\"), a patient's chart or one kind of their records. The app gathers the data and opens the summary in the Summary panel; reply with one short line. Never scroll, open pages or select anything for a summary.",
      parameters: z.object({
        what: z.string().optional().describe("What to summarize, in the provider's words (e.g. \"all inbox normal records\", \"my day\", \"Tom Baker's medications\"); leave out for the page on screen"),
      }),
      progress: () => 'Writing the summary…',
      run: ({ what }, { runtime }) => runtime.summarize(what),
    }),
    defineTool({
      name: 'patient_summary_panel',
      description: 'Show or hide the panel docked on the right that summarises the selected patient at a glance.',
      parameters: z.object({ open: z.boolean() }),
      run: async ({ open }, { runtime }) => runtime.setPatientPanel(open),
    }),

    // ------------------------------------------------------------- patients
    defineTool({
      name: 'search_patients',
      description: 'Find patients by name, MRN or phone. Shows the results on the Patients page (numbered in on-screen order) and returns them with their ids.',
      parameters: z.object({ query: z.string().min(1) }),
      progress: ({ query }) => `Searching patients for “${query}”…`,
      run: ({ query }, { runtime }) => runtime.searchPatients(query),
    }),
    defineTool({
      name: 'select_patient',
      description:
        'Make a patient the selected patient — the one the Summary, records and Inbox filing work on — and open their Summary (or the given Summary tab). Identify the patient by id, full name or MRN as the provider said it (no need to search first), or by position in the patient list on screen.',
      parameters: z.object({
        patient: z.string().optional().describe('Patient id, full name or MRN'),
        list_position: z.number().int().positive().optional().describe('Position in the patient search results on screen (1 = first)'),
        // "summary" (the Summary itself) is what selecting opens anyway — taken as no tab rather than
        // refused (qwen3.5:9b sent it every time and had to call again). The schema shown is unchanged.
        open_tab: z.preprocess((v) => (v === 'summary' ? undefined : v), z.enum(summaryTabs).optional()).describe('Summary tab to open after selecting'),
      }),
      progress: ({ patient }) => `Selecting ${patient ?? 'the patient'}…`,
      run: ({ patient, list_position, open_tab }, { runtime }) => runtime.selectPatient({ patient, position: list_position, page: open_tab }),
    }),
    defineTool({
      name: 'clear_selected_patient',
      description: 'Stop working on the selected patient (no patient selected afterwards).',
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.clearPatient(),
    }),
    defineTool({
      name: 'create_patient',
      description: 'Add a new patient: opens the new-patient form from any page, filled with whatever details were said (none is fine — the app asks for what is missing, and for confirmation before saving).',
      parameters: patientFields,
      progress: () => 'Opening the new patient form…',
      run: (fields, { runtime }) => runtime.createRecords('patient', [fields as FieldValues]),
    }),
    defineTool({
      name: 'edit_patient',
      description:
        "Change an existing patient's details: opens their form and changes only the fields given. With ask_for_field instead of changes, asks the user for that field's new value. Omit patient and list_position for the selected patient.",
      parameters: z.object({
        patient: z.string().optional().describe('Patient id, full name or MRN'),
        list_position: z.number().int().positive().optional().describe('Position in the patient search results on screen'),
        changes: z.record(z.string(), scalar).optional().describe('Only the fields to change — same names and formats as create_patient'),
        ask_for_field: z.enum(patientFieldNames).optional().describe('A field the user wants to change without having said the new value'),
      }),
      progress: () => 'Opening the patient for editing…',
      run: ({ patient, list_position, changes, ask_for_field }, { runtime }) =>
        runtime.editPatient({ patient, position: list_position, changes: changes as FieldValues | undefined, askFor: ask_for_field }),
    }),
    defineTool({
      name: 'delete_patient',
      description: 'Delete a patient. Shows the patient and asks the user to confirm; nothing is deleted until they do.',
      parameters: z.object({
        patient: z.string().optional().describe('Patient id, full name or MRN; omit for the selected patient'),
        list_position: z.number().int().positive().optional().describe('Position in the patient search results on screen'),
      }),
      run: ({ patient, list_position }, { runtime }) => runtime.deletePatient(patient, list_position),
    }),

    // -------------------------------------------------------------- records
    kindTools.add_care_plan,
    ...RECORD_KINDS.map((kind) =>
      defineTool({
        name: `add_${plural[kind]}`,
        description: `Add one or more ${plural[kind]} (and nothing else) for the selected patient or for the patients named — no need to select them first: opens the ${kind} form (one tab per patient, one tab per ${kind}) filled with what was said. The app asks for missing required fields and for confirmation before saving. When that form is already open (CONTEXT: open form), the new records are ADDED to it as more tabs — never save, confirm or cancel it first; saving is the provider's. With records of other kinds in the same request use add_care_plan.`,
        parameters: z.object({
          [plural[kind]]: z.array(formSchema(kind)).min(1),
          patient: z.string().optional().describe('ONE patient the provider named for all of these records (full name or MRN) — no need to select them first; omit for the selected patient'),
          for_patients: forPatients,
        }),
        progress: () => `Opening the ${kind} form…`,
        normalize: (raw) => listShaped(raw, plural[kind], FieldRegistry.getForm(kind)!.fields.map((f) => f.name)),
        run: (args, { runtime }) => {
          const { for_patients, patient, ...lists } = args as { for_patients?: string[]; patient?: string } & Record<string, FieldValues[]>;
          // One patient named for all of them: each record is theirs (a record naming its own patient keeps it).
          const items = patient && !for_patients?.length ? lists[plural[kind]].map((r) => (r.patient ? r : { ...r, patient })) : lists[plural[kind]];
          return runtime.createRecords(kind, items, for_patients);
        },
      }),
    ),
    kindTools.update_record,
    kindTools.delete_record,
    kindTools.list_records,

    // ---------------------------------------------------------------- forms
    defineTool({
      name: 'fill_open_form',
      description:
        'Set fields on the form that is open now (see CONTEXT: open form and its values) — e.g. {"frequency": "Twice daily"}. Use it to answer a pending question or to change what the form holds. Arguments are the form\'s own field names, in the same formats as the add_* tools.',
      parameters: z.object({}).catchall(scalar),
      progress: () => 'Filling the form…',
      run: (fields, { runtime }) => runtime.fillOpenForm(fields as FieldValues),
    }),
    defineTool({
      name: 'clear_form_field',
      description: 'Empty one field of the open form.',
      parameters: z.object({ field: z.string() }),
      run: async ({ field }, { runtime }) => runtime.clearFormField(field),
    }),
    defineTool({
      name: 'save_open_form',
      description: 'The user asked to save the open form. If a save is already waiting for their confirmation, this is that confirmation and it saves; otherwise it checks the form and asks them to confirm.',
      parameters: noArgs,
      run: (_, { runtime }) => runtime.saveOpenForm(),
    }),
    defineTool({
      name: 'confirm_pending_action',
      description:
        'Carry out the pending save / delete / filing shown in CONTEXT. Call it ONLY when the user has just said yes / confirm / save / delete it in reply to that pending confirmation — never on your own initiative.',
      parameters: noArgs,
      progress: () => 'Applying…',
      run: (_, { runtime }) => runtime.confirm(),
    }),
    defineTool({
      name: 'cancel_pending_action',
      description: 'The user said no / cancel / stop: drop the pending confirmation or question and close the open form without saving.',
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.cancel(),
    }),

    // ---------------------------------------------------------- information
    defineTool({
      name: 'get_provider_overview',
      description:
        "Data about the signed-in provider's own day (appointments today and this week, open tasks, recalls due, unfiled Inbox) to answer a specific question such as \"when is my next appointment\" — answer in one sentence. For a summary or overview of the day use dashboard_summary_panel instead.",
      parameters: noArgs,
      progress: () => 'Checking your schedule…',
      run: async (_, { runtime }) => runtime.providerOverview(),
    }),
    defineTool({
      name: 'get_patient_summary',
      description: "The selected patient's records in brief (conditions, medications, tasks, recalls, appointments) — to answer a question about the patient. A summary the provider asks for is summarize.",
      parameters: noArgs,
      progress: () => 'Summarising the patient…',
      run: async (_, { runtime }) => runtime.patientSummary(),
    }),

    // ------------------------------------------- the provider's own appointments
    // Appointments booked WITH the signed-in provider (their schedule), across patients. Not a patient's
    // appointments — those are that patient's records (add_appointments, update_record).
    defineTool({
      name: 'list_my_appointments',
      description:
        "The provider's OWN appointments (\"my appointments\", \"my schedule\", \"who am I seeing\"): shows them on My Appointments and returns them with the patient each one is with.",
      parameters: z.object({
        when: z.enum(['upcoming', 'today', 'past', 'cancelled', 'all']).optional().describe('Which ones; upcoming when not said'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('Only this day, YYYY-MM-DD'),
        patient: z.string().optional().describe("Only those with this patient (the patient's name)"),
      }),
      progress: () => 'Opening your appointments…',
      run: (args, { runtime }) => runtime.myAppointments(args),
    }),
    defineTool({
      name: 'cancel_my_appointment',
      description:
        "Cancel one of the provider's OWN booked appointments, with a cancellation note: opens its cancel dialog on My Appointments; cancelled only after the provider confirms. Identify it by id, or by the patient's name plus its date / time when needed.",
      parameters: z.object({
        appointment: z.string().optional().describe('The appointment id from list_my_appointments'),
        patient: z.string().optional().describe("The patient's name, when no id"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('Its date, YYYY-MM-DD'),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm').optional().describe('Its start time, HH:mm'),
        note: z.string().optional().describe("The cancellation note, in the provider's words; leave out when not said (they are asked)"),
      }),
      progress: () => 'Opening the appointment…',
      run: (args, { runtime }) => runtime.cancelMyAppointment(args),
    }),
    defineTool({
      name: 'reschedule_my_appointment',
      description:
        "Move one of the provider's OWN booked appointments to a new date / time, with a reschedule comment: opens its reschedule dialog on My Appointments; moved only after the provider confirms. Double bookings are refused.",
      parameters: z.object({
        appointment: z.string().optional().describe('The appointment id from list_my_appointments'),
        patient: z.string().optional().describe("The patient's name, when no id"),
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('When it is NOW (only to pick the right one), YYYY-MM-DD'),
        from_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm').optional().describe('Its start time NOW, HH:mm'),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('The date to MOVE it to, YYYY-MM-DD'),
        to_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm').optional().describe('The start time to MOVE it to, HH:mm'),
        duration_minutes: z.number().int().positive().optional(),
        comment: z.string().optional().describe("The reschedule comment, in the provider's words; leave out when not said (they are asked)"),
      }),
      progress: () => 'Opening the appointment…',
      run: ({ from_date, from_time, to_date, to_time, duration_minutes, ...rest }, { runtime }) =>
        runtime.rescheduleMyAppointment({ ...rest, date: from_date, time: from_time, newDate: to_date, newTime: to_time, durationMinutes: duration_minutes }),
    }),
    // The selected patient's appointments (with any provider) — the same two dialogs, on their Appointments tab.
    defineTool({
      name: 'cancel_patient_appointment',
      description:
        "Cancel one of the SELECTED PATIENT's appointments (with any provider), with a cancellation note: opens its cancel dialog on the patient's Appointments tab; cancelled only after the provider confirms; the patient is told the reason.",
      parameters: z.object({
        appointment: z.string().optional().describe('The appointment id (list_records appointment)'),
        provider: z.string().optional().describe("The provider it is with, when no id"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('Its date, YYYY-MM-DD'),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm').optional().describe('Its start time, HH:mm'),
        note: z.string().optional().describe("The cancellation note, in the provider's words; leave out when not said (they are asked)"),
      }),
      progress: () => 'Opening the appointment…',
      run: (args, { runtime }) => runtime.cancelAppointment('patient', args),
    }),
    defineTool({
      name: 'reschedule_patient_appointment',
      description:
        "Move one of the SELECTED PATIENT's appointments (with any provider) to a new date / time, with a reschedule comment: opens its reschedule dialog on the patient's Appointments tab; moved only after the provider confirms; the patient is told the new time and reason. Double bookings are refused.",
      parameters: z.object({
        appointment: z.string().optional().describe('The appointment id (list_records appointment)'),
        provider: z.string().optional().describe("The provider it is with, when no id"),
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('When it is NOW (only to pick the right one), YYYY-MM-DD'),
        from_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm').optional().describe('Its start time NOW, HH:mm'),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional().describe('The date to MOVE it to, YYYY-MM-DD'),
        to_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour HH:mm').optional().describe('The start time to MOVE it to, HH:mm'),
        duration_minutes: z.number().int().positive().optional(),
        comment: z.string().optional().describe("The reschedule comment, in the provider's words; leave out when not said (they are asked)"),
      }),
      progress: () => 'Opening the appointment…',
      run: ({ from_date, from_time, to_date, to_time, duration_minutes, ...rest }, { runtime }) =>
        runtime.rescheduleAppointment('patient', { ...rest, date: from_date, time: from_time, newDate: to_date, newTime: to_time, durationMinutes: duration_minutes }),
    }),

    // ---------------------------------------------------------------- inbox
    defineTool({
      name: 'inbox_show',
      description: 'Open the Inbox (lab results, radiology reports, referrals, discharge summaries) and set what it shows. Returns the list on screen, numbered.',
      parameters: z.object({
        category: z.enum(['all', 'lab', 'radiology', 'referral', 'discharge']).optional(),
        scope: z.enum(['selected_patient', 'all_patients']).optional().describe("Only the selected patient's items, or every patient's"),
        patient: z.string().optional().describe("Only this patient's items (name, MRN or id) — no need to select them first"),
        search: z.string().optional().describe('Text to search for; an empty string clears the search'),
      }),
      progress: () => 'Opening the Inbox…',
      run: (args, { runtime }) => runtime.inboxShow(args),
    }),
    defineTool({
      name: 'inbox_open_item',
      description: 'Open an Inbox record to read it. Returns its content.',
      parameters: z.object({ target: inboxTarget }),
      progress: () => 'Opening the record…',
      run: ({ target }, { runtime }) => runtime.inboxOpen(target),
    }),
    defineTool({
      name: 'inbox_file_item',
      description: 'File an Inbox record as reviewed (file = true) or move it back to unfiled (file = false) — any patient\'s record: no patient needs to be selected. May ask for confirmation.',
      parameters: z.object({ file: z.boolean(), target: inboxTarget.optional() }),
      run: async ({ file, target }, { runtime }) => runtime.inboxFile(file, target ?? 'this'),
    }),
    defineTool({
      name: 'inbox_add_comment',
      description:
        'Add a comment (the provider\'s words, e.g. "Test is good") to Inbox records: to one record (target), or to every record of a kind (which, e.g. all abnormal records). Every Inbox record is either Abnormal or Normal. Opens the Inbox itself and adds the comment at once.',
      parameters: z.object({
        text: z.string().describe('The comment, exactly as the provider said it'),
        which: z.enum(['abnormal', 'normal', 'needs_attention', 'unfiled', 'all']).optional().describe('Comment on every record of this kind (and say whose: scope or patient); leave out for one record'),
        category: z.enum(['all', 'lab', 'radiology', 'referral', 'discharge']).optional(),
        patient: z.string().optional().describe("With which: one named patient's records (name, MRN or id) — no need to select them first"),
        scope: z.enum(['selected_patient', 'all_patients']).optional().describe("With which: all_patients — every patient's records (\"all patients\", \"everyone's\"); selected_patient — the selected patient's (\"his\", \"this patient's\")"),
        target: inboxTarget.optional().describe('One record: its position in the list, or "this" for the open one'),
      }),
      progress: () => 'Preparing the comment…',
      run: (args, { runtime }) => runtime.inboxAddComment(args),
    }),
    defineTool({
      name: 'inbox_select_item_patient',
      description: "Make the open Inbox record's patient the selected patient.",
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.inboxSelectPatient(),
    }),

    // ------------------------------------------------------------ AI Summary
    defineTool({
      name: 'add_extracted_item',
      description: 'Open an item the AI Summary extracted from a note (see CONTEXT) in its form, pre-filled, to review and save.',
      parameters: z.object({ kind: recordKind, position: z.number().int().positive().default(1).describe('Which of the items of that kind (1 = first)') }),
      run: ({ kind, position }, { runtime }) => runtime.addExtractedItem(kind, position),
    }),

    // --------------------------------------------------------- configuration
    defineTool({
      name: 'get_ai_configuration',
      description: 'The AI models in use and what is available: the language model (runtime, model, settings) with every installed model, and the Omi Med STT speech model, backend, threads and timings with every model and backend this machine can run.',
      parameters: noArgs,
      progress: () => 'Reading the AI configuration…',
      run: (_, { runtime }) => runtime.aiConfiguration(),
    }),
    defineTool({
      name: 'set_language_model',
      description: 'Change the language model the assistant runs on, or its settings. The model must be installed (get_ai_configuration lists them) and able to call tools. Only give what the provider asked to change.',
      parameters: z.object({
        model: z.string().optional().describe('Installed model name, e.g. qwen3.5:2b'),
        runtime: z.enum(LLM_PROVIDERS as [LLMProviderKind, ...LLMProviderKind[]]).optional().describe('ollama = this computer; vllm; openrouter; openai-compatible; bridge'),
        server_url: z.string().optional(),
        context_window: z.number().int().optional().describe('Tokens'),
        gpu_layers: z.number().int().min(0).optional().describe('99 = whole model on the GPU, 0 = CPU'),
        timeout_seconds: z.number().int().positive().optional(),
        max_steps: z.number().int().min(1).max(12).optional(),
      }),
      progress: () => 'Changing the language model…',
      run: (args, { runtime }) => runtime.setLanguageModel(args),
    }),
    defineTool({
      name: 'set_speech_recognition',
      description: 'Change the speech recognition settings (Omi Med STT or NVIDIA Parakeet). Only give what the provider asked to change.',
      parameters: z.object({
        model: z.string().optional().describe('Words from the speech model name, e.g. "omi", "parakeet", "mlx 8-bit"'),
        backend: z.enum(['cpu', 'cuda', 'vulkan']).optional().describe('cuda = the GPU'),
        precision: z.enum(['int8', 'fp32']).optional().describe('Parakeet only'),
        cpu_threads: z.number().int().min(0).max(64).optional().describe('0 = automatic'),
        pause_ms: z.number().int().min(200).max(5000).optional().describe('The pause that ends a sentence'),
        live_text_ms: z.number().int().min(200).max(5000).optional().describe('How often the live text refreshes'),
      }),
      progress: () => 'Changing speech recognition…',
      run: (args, { runtime }) => runtime.setSpeechRecognition(args),
    }),

    // ------------------------------------------------------------ application
    defineTool({
      name: 'sign_out',
      description: 'Sign the provider out of the application.',
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.signOut(),
    }),
    defineTool({
      name: 'spoken_replies',
      description: 'Turn the spoken (read-aloud) replies on or off.',
      parameters: z.object({ on: z.boolean() }),
      run: async ({ on }, { runtime }) => runtime.setSpokenReplies(on),
    }),
    defineTool({
      name: 'sidebar',
      description: 'Collapse or expand the navigation sidebar.',
      parameters: z.object({ collapsed: z.boolean() }),
      run: async ({ collapsed }, { runtime }) => runtime.setSidebarCollapsed(collapsed),
    }),
    defineTool({
      name: 'show_help',
      description: 'Show the list of everything the assistant can do.',
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.openHelp(),
    }),

    // ---------------------------------------------------------------- voice
    defineTool({
      name: 'stop_listening',
      description: 'Turn the microphone off (the user said stop listening, mic off, that is all…).',
      parameters: noArgs,
      run: async (_, { runtime }) => runtime.stopListening(),
    }),
    defineTool({
      name: 'wait_for_more_speech',
      description: 'What was said is an unfinished fragment (cut off mid-sentence). Nothing is done; it is joined with what the user says next.',
      parameters: noArgs,
      run: async () => ({ ok: true, message: 'Waiting for the rest of the sentence.' }),
    }),
    defineTool({
      name: 'take_clinical_note',
      description:
        'The user is dictating a clinical note about the selected patient (findings, medications, diagnoses, follow-ups in running speech) rather than giving a command. Pass the note text; it opens in the AI Summary where the items are extracted for review. Without a note, starts dictation.',
      parameters: z.object({ note: z.string().optional().describe('The dictated note, word for word') }),
      run: async ({ note }, { runtime }) => runtime.takeNote(note),
    }),
    defineTool({
      name: 'record_note_findings',
      description: 'ONLY when the message says TASK: EXTRACT. Report every item found in the clinical note. Never use it for a spoken command.',
      parameters: z.object({
        ...Object.fromEntries(
          RECORD_KINDS.map((kind) => [plural[kind], z.array(z.record(z.string(), scalar)).optional().describe(`Items with the same fields as add_${plural[kind]}, plus "quote": the words of the note`)]),
        ),
        questions: z.array(z.string()).optional().describe('Anything ambiguous or incomplete, as a short question — instead of guessing'),
      }),
      run: async () => ({ ok: false, message: 'record_note_findings is only for extracting a note. For a dictated note use take_clinical_note.' }),
    }),
    defineTool({
      name: 'plan_steps',
      description: 'ONLY when the message says TASK: PLAN. Split what the provider said into the separate actions it asks for, in the order said. Never use it for a spoken command.',
      parameters: z.object({
        steps: z
          .array(z.string())
          .min(1)
          .describe(
            'One action per step, as a short instruction keeping every detail that belongs to it (names, drugs, doses, dates, times). Going to a page and selecting a patient is one step. Every record added for the same patient — medications, diagnoses, tasks, recalls, appointments, of one kind or several — is ONE step (they go into one care plan together); never a step per kind.',
          ),
      }),
      run: async () => ({ ok: false, message: 'plan_steps is only for planning. Carry out the request with the other tools.' }),
    }),
  ];
  return tools;
}

export const NOTE_FINDINGS_TOOL = 'record_note_findings';
export const WAIT_TOOL = 'wait_for_more_speech';
export const PLAN_TOOL = 'plan_steps';
export const recordPlural = plural;

/**
 * What the model is told, laid out for the prompt cache:
 *
 *   system prompt + tool schemas   static — identical on every request
 *   SESSION exchange               today's dates and the provider — changes once a day
 *   user message                   CONTEXT (time, page, patient, form, recent exchanges) + SAID
 *
 * Qwen 3.5 reads a prompt at only ~50 tokens/s on a 4 GB GPU, so every token sent again costs
 * ~20 ms. The first two parts are primed into the cache at warm-up; each utterance pays only for
 * its own CONTEXT and words. Earlier exchanges are summarised inside CONTEXT rather than sent as
 * chat messages, so the prompt keeps the same shape from one utterance to the next.
 */
import type { AIContext } from '@/types/ai';

export const SYSTEM_PROMPT = `You are the voice assistant of CareFlow, a clinic practice-management app. The signed-in user is a provider (doctor). You operate the app only by calling the tools provided.

The SESSION message gives today's date, the next days, dates further ahead and the provider. Each later user message has a CONTEXT block (time, page, selected patient, open form, pending question or confirmation, the last exchanges) followed by SAID: what the provider said. SAID is English from speech recognition: it may contain misheard or run-together words ("Admetformin" is "Add metformin", "Vilebis" may be "File this") — read it for what the provider most likely said. ALSO HEARD, when present, is the same speech from a second recogniser that was given the app's names (patients, drugs, diagnoses): where the two differ, it usually has names and drug names right, SAID usually has long sentences right — combine them into what was most likely said.

How to work:
- Work out what the provider wants from SAID and CONTEXT, then call the tool or tools that do it — several, in order, when the request has several parts.
- Use only what the provider said. Never invent drugs, doses, dates, names or ids. Leave out every field that was not said — including ones that seem obvious (route, status, priority, category, a reason, who diagnosed): the app fills defaults and asks for missing required values itself.
- A reason is only ever the provider's own words for that record: the kind of visit they named for an appointment or recall is its reason ("a follow-up appointment" → reason "Follow-up"; "recall him for an annual physical" → reason "Annual physical"). A word said for one record never becomes another record's reason ("follow-up" said for the appointment is not the recall's reason); a record whose reason was not said has none — leave it out, and the app asks the provider.
- A dose, frequency or duration said once after a list of drugs that have none of their own ("metformin, Panadol and gabapentin 500 mg twice daily for 30 days") applies to every drug of that list: give each medication its own copy. A drug said with its own dose keeps it ("metformin 500 mg, Panadol 1 g").
- Records for named patients need no patient to be selected first. The same records for each of several patients ("add Panadol and Metformin to Liam Martin and Harry White"): list the records once and put the patients' full names in for_patients. Records that differ per patient ("Panadol to Liam Martin, Metformin to Harry White"; "John at 6 pm, James at 7 pm"): one record each, with its own patient field. Never give one patient's record to another. Leave patients out for the selected patient.
- When a tool asks the provider something or waits for their confirmation, still do the other parts of the request; never answer that question yourself.
- Put values in the tools' formats: dates YYYY-MM-DD, resolving "today", "tomorrow", "next Friday", "in two weeks", "after 3 months" from the SESSION date, next days and in-dates; times as 24-hour HH:mm; a select field takes exactly one of its listed options ("twice a day" and "BID" are both "Twice daily"); a dose keeps its unit ("500 milligrams" is "500 mg").
- When one request adds records of more than one kind (medications, diagnoses, tasks, recalls, appointments), call add_care_plan once with all of them — naming the patient in it when the provider names one — instead of several add_* tools.
- The provider's own appointments ("my appointments", "my schedule", cancel or move one of mine) use list_my_appointments, cancel_my_appointment and reschedule_my_appointment; the selected patient's appointments are that patient's records (cancel_patient_appointment, reschedule_patient_appointment). Never mix the two.
- Any summary or overview the provider asks for ("summarize all inbox normal records", "summary of my day", "summarize this page", "summarize his medications") is ONE call to summarize — never scroll, open pages or select anything for it.
- Records and patients are best identified by the id from an earlier tool result; otherwise by the name the provider used.
- Saving and deleting always wait for the provider's confirmation. Call confirm_pending_action only when CONTEXT shows a pending confirmation and SAID is the provider agreeing to it (yes, confirm, save it, go ahead). If they refuse, call cancel_pending_action.
- When CONTEXT shows a pending question and SAID answers it, fill that field with fill_open_form.
- When SAID is an unfinished fragment, call wait_for_more_speech.
- When SAID is a clinical note being dictated (several findings, medications, diagnoses or follow-ups about the patient in running speech) rather than an instruction, call take_clinical_note with the note text.
- If a tool reports an error, fix the call and try again, or ask the provider when only they can resolve it (for example several patients or records match).
- When SAID is not addressed to the app (small talk, background speech), answer briefly without tools.
- When the tools are done, reply in one or two short sentences: what was done, or the answer that was asked for. Do not read out ids. Reply in English.`;

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** What holds for the whole day: sent once after the system prompt and cached with it. */
export function buildSessionMessage(ctx: AIContext): string {
  return [
    'SESSION',
    `today: ${ctx.today}`,
    `next days: ${ctx.nextDays}`,
    `in: ${ctx.laterDates}`,
    `provider (the user — "my", "I"): ${ctx.providerName ?? 'unknown'}`,
  ].join('\n');
}

/** The assistant's side of the SESSION exchange (a chat template needs one before the next user turn). */
export const SESSION_ACK = 'Ready.';

/** An earlier utterance and what came of it, shown in CONTEXT so follow-ups make sense. */
export interface Exchange {
  said: string;
  reply: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The per-utterance user message: the CONTEXT block, then what was said. */
/** Two transcripts that differ only in case, punctuation or spacing say the same thing. */
const sameWords = (a: string, b: string) => {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return words(a) === words(b);
};

export function buildUserMessage(
  said: string,
  ctx: AIContext,
  earlier: Exchange[] = [],
  alsoHeard?: string,
  step?: { index: number; total: number },
  /** Blocks between CONTEXT and SAID (multi-agent mode: the whole REQUEST, RESULTS FROM EARLIER TASKS). */
  sections: string[] = [],
): string {
  const lines = [
    `time: ${ctx.now}`,
    `page: ${ctx.currentPageId ? `${ctx.currentPageId} (${ctx.currentPageTitle})` : 'none'}`,
    `selected patient: ${ctx.currentPatientName ? `${ctx.currentPatientName} (id ${ctx.currentPatientId})` : 'none'}`,
  ];
  if (ctx.openForm) {
    const values = Object.entries(ctx.openForm.values)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${show(v)}`)
      .join(', ');
    lines.push(`open form: ${ctx.openForm.id}${ctx.openForm.entries > 1 ? ` (${ctx.openForm.entries} entries, showing the active one)` : ''} — ${values || 'empty'}`);
  }
  if (ctx.pendingQuestion) lines.push(`pending question: ${ctx.pendingQuestion.formId}.${ctx.pendingQuestion.field} — "${ctx.pendingQuestion.question}"`);
  if (ctx.pendingConfirmation)
    lines.push(
      `pending confirmation: ${ctx.pendingConfirmation.kind} — ${ctx.pendingConfirmation.description}${
        // Prepared by an earlier step of this same request: the provider has not seen it yet.
        step && step.index > 1 ? ' (prepared by an earlier step of this request — the provider confirms at the end; do not confirm it, do this step)' : ''
      }`,
    );
  if (ctx.inbox) lines.push(`inbox on screen: ${ctx.inbox.view}, ${ctx.inbox.items} items${ctx.inbox.query ? `, search "${ctx.inbox.query}"` : ''}${ctx.inbox.openItem ? `, open: "${ctx.inbox.openItem}"` : ''}`);
  if (ctx.patientSearch) lines.push(`patient search on screen: "${ctx.patientSearch.query}" — ${ctx.patientSearch.results} results`);
  if (ctx.list) {
    const f = Object.entries(ctx.list.filters).map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`list on screen: ${ctx.list.name} — ${ctx.list.shown} of ${ctx.list.total}, page ${ctx.list.page}/${ctx.list.pageCount}${ctx.list.search ? `, search "${ctx.list.search}"` : ''}${f ? `, filtered ${f}` : ''}${ctx.list.filterable ? `; filters: ${ctx.list.filterable}` : ''}`);
  }
  if (ctx.carePlan) lines.push(`care plan open (the open form is its record tab on screen): ${ctx.carePlan}`);
  if (ctx.extracted) lines.push(`AI Summary items waiting to be added: ${ctx.extracted}`);
  for (const e of earlier) lines.push(`earlier: "${clip(e.said, 120)}" → ${clip(e.reply, 120)}`);
  if (step) lines.push(`request: step ${step.index} of ${step.total} of a longer request — do only this step (the earlier lines show the steps before it; the rest follow)`);
  const second = alsoHeard && !sameWords(alsoHeard, said) ? `\nALSO HEARD: ${alsoHeard}` : '';
  const extra = sections.filter(Boolean).map((s) => `\n\n${s}`).join('');
  return `CONTEXT\n${lines.join('\n')}${extra}\n\nSAID: ${said}${second}`;
}

/**
 * The user message that asks for a long request to be split into its actions before any is carried out:
 * a small model doing "…metformin, a task, a recall and an appointment" in one go tends to stop part-way.
 */
export function buildPlanMessage(said: string, ctx: AIContext, earlier: Exchange[] = [], alsoHeard?: string): string {
  return `${buildUserMessage(said, ctx, earlier, alsoHeard)}

TASK: PLAN. Do not act yet. Call plan_steps with the separate actions SAID asks for, in the order said — each a short instruction that keeps every detail belonging to it (names, drugs, doses, dates, times). Never add, drop or change a detail; keep dates and times in the provider's words ("next Tuesday at 3 pm") — do not work them out. All the records SAID adds for the same patient — medications, diagnoses, tasks, recalls and appointments, of one kind or of several — are ONE step that keeps every one of them with its details: they are added together, in one care plan when there is more than one kind (split, the first form would close and a care plan open in its place). Records of one kind for several patients ("four appointments for Liam, Harry, Lucas and Lily") are ONE step that keeps every patient's name and every detail they share. If SAID is a single action, a question, an answer to a pending question or confirmation, or a clinical note being dictated, call plan_steps with SAID as the only step.`;
}

/** The user message that asks for a clinical note to be extracted into structured items. */
export function buildExtractionMessage(note: string, ctx: AIContext): string {
  return `${buildUserMessage('(none — this is an extraction task)', ctx)}

TASK: EXTRACT. Call record_note_findings once with every medication, diagnosis, task, recall and appointment in the clinical note below. Only what the note says; put the note's own words for each item in quote; put anything ambiguous in questions.
NOTE: ${note}`;
}

/**
 * The DATA of a summary: gathered by code from the app's own records, for what was asked (summaryTarget.ts).
 *
 * The same facts serve three readers: the Summary panel shows them (figures and lists), the Summary Agent's
 * model is given them as DATA to write from, and — when no model answers — `ruleSummary` writes the text from
 * them alone. Nothing here is generated, so nothing in a summary can be what the records do not hold.
 */
import dayjs from 'dayjs';
import type { Appointment, Diagnosis, Medication, Patient, Recall, Task } from '@/types/domain';
import type { RecordKind } from '@/types/records';
import { categoryMeta, type InboxCategory, type InboxItem } from '@/services/inbox/inboxModel';
import type { ProviderWorkload } from '@/services/provider/providerWorkload';
import { buildProviderNarrative } from '@/services/provider/providerNarrative';
import { buildPatientNarrative } from '@/services/records/patientNarrative';
import type { SummaryTarget } from './summaryTarget';

export type FactTone = 'primary' | 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface SummaryFacts {
  /** What is summarized, as a heading: "Normal Inbox records". */
  title: string;
  /** Whose / how much: "All patients · 5 records". */
  scope: string;
  stats: Array<{ label: string; value: string; tone?: FactTone }>;
  sections: Array<{ title: string; items: Array<{ text: string; detail?: string; tone?: FactTone }>; more?: number }>;
  /** Nothing to summarize — `emptyText` says so. */
  empty: boolean;
  emptyText?: string;
  /** The page it is about, to open from the panel. */
  link?: { label: string; path: string };
  /**
   * Inbox summaries: every record summarized, with its own priority — what the Safety Agent checks a summary's
   * "urgent" against (summaryWriter.unsupportedUrgency): only a record the data marks urgent may be called so.
   */
  inboxRows?: InboxRow[];
}

export interface InboxRow {
  patient: string;
  category: InboxCategory;
  subject: string;
  priority?: string;
  /** Its own priority is STAT, Urgent, Emergency or High. */
  urgent: boolean;
}

/** The priorities that make a record urgent (as the Inbox flags them), most urgent first. */
const URGENT_PRIORITIES = ['STAT', 'Emergency', 'Urgent', 'High'];
const isUrgent = (i: InboxItem) => URGENT_PRIORITIES.includes(i.priority ?? '') || /\b(stat|emergency|urgent|high) priority\b/i.test(i.attentionReason ?? '');
/** STAT first … High, then everything else. */
const urgencyRank = (i: InboxItem) => {
  const at = URGENT_PRIORITIES.indexOf(i.priority ?? '');
  return at >= 0 ? at : isUrgent(i) ? URGENT_PRIORITIES.length - 1 : URGENT_PRIORITIES.length;
};

/** What the collector reads — the store, as the voice controller hands it over. */
export interface SummarySource {
  patients: Patient[];
  selectedPatientId: string | null;
  /** A patient's records of one kind. */
  records(kind: RecordKind, patientId: string): unknown[];
  workload(): ProviderWorkload | null;
  inbox: InboxItem[];
  /** Inbox items filed (reviewed). */
  filedIds: string[];
  /** The signed-in provider's own appointments. */
  providerAppointments(): Appointment[];
  /** The AI configuration, as lines ("Master Agent: Qwen3.5 9B · Kaggle"). */
  configuration?(): string[];
}

const SHOWN = 30;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso?: string) => (iso ? dayjs(iso).format('D MMM YYYY') : '');
const time = (hhmm?: string) => (hhmm ? dayjs(`2000-01-01T${hhmm}`).format('h:mm A') : '');
const list = (items: string[], max = 3) => {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const joined = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '');
  return rest > 0 ? `${joined} and ${rest} more` : joined;
};
const countBy = <T,>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

function section(title: string, items: SummaryFacts['sections'][number]['items']): SummaryFacts['sections'][number] {
  return { title, items: items.slice(0, SHOWN), more: items.length > SHOWN ? items.length - SHOWN : undefined };
}

// ------------------------------------------------------------------------------------------- inbox

function inboxFacts(t: Extract<SummaryTarget, { kind: 'inbox' }>, src: SummarySource): SummaryFacts {
  const filed = new Set(src.filedIds);
  const patient = t.patientId ? src.patients.find((p) => p.id === t.patientId) : undefined;
  const rows = src.inbox
    .filter((i) => t.category === 'all' || i.category === t.category)
    .filter((i) => t.status === 'all' || i.status.toLowerCase() === t.status)
    .filter((i) => t.file === 'all' || (t.file === 'filed' ? filed.has(i.id) : !filed.has(i.id)))
    .filter((i) => !t.attention || i.attention)
    .filter((i) => !t.patientId || i.patientId === t.patientId)
    // Those needing attention first; among them, the most urgent by their own priority (STAT, Urgent …); then the newest.
    .sort((a, b) => (a.attention !== b.attention ? (a.attention ? -1 : 1) : urgencyRank(a) - urgencyRank(b) || b.receivedAt.localeCompare(a.receivedAt)));

  const what = [
    t.attention ? 'Flagged' : '',
    t.file === 'unfiled' ? 'unfiled' : t.file === 'filed' ? 'filed' : '',
    t.status === 'normal' ? 'normal' : t.status === 'abnormal' ? 'abnormal' : '',
    t.category === 'all' ? 'Inbox records' : categoryMeta[t.category as InboxCategory].plural,
  ]
    .filter(Boolean)
    .join(' ');
  const title = what.charAt(0).toUpperCase() + what.slice(1);
  const whose = patient ? patient.fullName : 'All patients';
  const patients = new Set(rows.map((r) => r.patientId)).size;
  const unfiled = rows.filter((r) => !filed.has(r.id)).length;
  const abnormal = rows.filter((r) => r.status === 'Abnormal').length;
  const attention = rows.filter((r) => r.attention);

  const line = (i: InboxItem) => ({
    text: `${i.subject} — ${i.patientName}`,
    detail: [
      categoryMeta[i.category].singular,
      i.status,
      i.result ? `${i.result.value}${i.result.referenceRange ? ` (ref ${i.result.referenceRange})` : ''}` : '',
      i.priority ? `${i.priority} priority` : '',
      day(i.receivedAt),
      filed.has(i.id) ? 'filed' : 'unfiled',
      i.attention ? `needs attention${i.attentionReason ? `: ${i.attentionReason}` : ''}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    tone: (i.attention ? 'error' : i.status === 'Abnormal' ? 'warning' : 'success') as FactTone,
  });

  const byCategory = countBy(rows, (r) => categoryMeta[r.category].plural);
  // The counts overlap — a record can be abnormal AND need attention: said outright, so they are never added up
  // ("14 need attention and 12 are abnormal" read as 26 of 25).
  const normal = rows.length - abnormal;
  const attentionAbnormal = attention.filter((r) => r.status === 'Abnormal').length;
  const attentionNormal = attention.length - attentionAbnormal;
  const why = (rs: InboxItem[]) => countBy(rs, (r) => r.attentionReason ?? 'flagged').map(([reason, n]) => `${n} ${reason.toLowerCase()}`).join(', ');
  const breakdown: SummaryFacts['sections'][number]['items'] = [
    { text: `${plural(rows.length, 'record')} in all: ${abnormal} abnormal and ${normal} normal (these two add up to ${rows.length}).` },
    ...(abnormal
      ? [{ text: `Of the ${abnormal} abnormal: ${attentionAbnormal === abnormal ? `all ${abnormal}` : String(attentionAbnormal)} need attention${attentionAbnormal < abnormal ? `, ${abnormal - attentionAbnormal} do not` : ''}.`, tone: 'warning' as FactTone }]
      : []),
    ...(normal ? [{ text: `Of the ${normal} normal: ${attentionNormal ? `${attentionNormal} need attention (${why(attention.filter((r) => r.status === 'Normal'))})${attentionNormal < normal ? `, ${normal - attentionNormal} do not` : ''}` : 'none needs attention'}.` }] : []),
    ...(attention.length < rows.length ? [{ text: `Not needing attention: ${rows.length - attention.length} of the ${rows.length}.` }] : []),
    ...(attention.length ? [{ text: `Need attention: ${attention.length} = ${attentionAbnormal} abnormal + ${attentionNormal} normal — the same records as above, not more of them.`, tone: 'error' as FactTone }] : []),
  ];
  // Which records are urgent is the records' own priority — said outright, so a summary never ranks them itself
  // (Bonsai called two Routine referrals "the most urgent" while a STAT result waited).
  const urgent = rows.filter(isUrgent).sort((a, b) => urgencyRank(a) - urgencyRank(b));
  const otherPriorities = countBy(rows.filter((r) => !isUrgent(r)), (r) => (r.priority ? `${r.priority} priority` : 'no priority given'));
  const priorities: SummaryFacts['sections'][number]['items'] = [
    urgent.length
      ? { text: `Urgent by their own priority: ${urgent.length} of the ${rows.length} — only these; rank no other record above them.`, tone: 'error' as FactTone }
      : { text: `None of the ${rows.length} is marked STAT, Emergency, Urgent or High priority — call none of them urgent.` },
    ...urgent.map((i) => ({ text: `${i.priority ?? 'Urgent'}: ${i.subject} — ${i.patientName}`, detail: categoryMeta[i.category].singular, tone: 'error' as FactTone })),
    ...(otherPriorities.length ? [{ text: `The rest: ${otherPriorities.map(([p, n]) => `${n} ${p}`).join(', ')}.` }] : []),
  ];
  return {
    title,
    scope: `${whose} · ${plural(rows.length, 'record')}`,
    stats: [
      { label: 'Records', value: String(rows.length), tone: 'primary' },
      { label: patient ? 'Unfiled' : 'Patients', value: String(patient ? unfiled : patients), tone: 'info' },
      { label: 'Abnormal', value: String(abnormal), tone: abnormal ? 'warning' : 'success' },
      { label: 'Need attention', value: String(attention.length), tone: attention.length ? 'error' : 'neutral' },
    ],
    sections: rows.length
      ? [
          section('How the counts overlap', breakdown),
          section('Priority (from the records)', priorities),
          ...(byCategory.length > 1 ? [section('By category', byCategory.map(([name, n]) => ({ text: `${n} ${name}` })))] : []),
          // Those needing attention come first; each says so itself (a heading saying it was read as true of all).
          section('Records', rows.map(line)),
          ...(!patient && patients > 1 ? [section('By patient', countBy(rows, (r) => r.patientName).map(([name, n]) => ({ text: `${name}: ${plural(n, 'record')}` })))] : []),
        ]
      : [],
    empty: rows.length === 0,
    emptyText: `There are no ${what.toLowerCase()}${patient ? ` for ${patient.fullName}` : ''}.`,
    link: { label: 'Open the Inbox', path: `/inbox/${t.category}${t.patientId ? `?patient=${encodeURIComponent(t.patientId)}` : ''}` },
    inboxRows: rows.map((i) => ({ patient: i.patientName, category: i.category, subject: i.subject, priority: i.priority, urgent: isUrgent(i) })),
  };
}

// --------------------------------------------------------------------------------------- dashboard

function dashboardFacts(src: SummarySource): SummaryFacts {
  const w = src.workload();
  if (!w) return { title: 'Your day', scope: 'Dashboard', stats: [], sections: [], empty: true, emptyText: 'This account has no provider schedule.', link: { label: 'Open the Dashboard', path: '/dashboard' } };
  const narrative = buildProviderNarrative(w);
  const flagged = w.unfiledInbox.filter((i) => i.attention);
  return {
    title: 'Your day',
    scope: `${w.provider.fullName} · ${dayjs().format('dddd, D MMM YYYY')}`,
    stats: [
      { label: 'Today', value: String(w.today.length), tone: 'primary' },
      { label: 'Next 7 days', value: String(w.upcoming.length), tone: 'info' },
      { label: 'Open tasks', value: String(w.openTasks.length), tone: w.overdueTasks.length ? 'error' : 'success' },
      { label: 'Recalls due', value: String(w.dueRecalls.length), tone: w.overdueRecalls.length ? 'warning' : 'neutral' },
    ],
    sections: [
      section('In brief', narrative.sections.map((s) => ({ text: `${s.title}: ${s.body}` }))),
      section(
        "Today's schedule",
        w.today.map((a) => ({ text: `${time(a.startTime)} ${a.patientName}`, detail: [a.type, a.reason, a.status].filter(Boolean).join(' · '), tone: (w.nextToday?.id === a.id ? 'primary' : undefined) as FactTone | undefined })),
      ),
      section('Needs attention', [
        ...w.overdueTasks.map((t) => ({ text: `Overdue task: ${t.title} — ${t.patientName}`, detail: `due ${day(t.dueDate)} · ${t.priority}`, tone: 'error' as FactTone })),
        ...w.overdueRecalls.map((r) => ({ text: `Overdue recall: ${r.reason} — ${r.patientName}`, detail: `due ${day(r.dueDate)}`, tone: 'warning' as FactTone })),
        ...flagged.map((i) => ({ text: `Inbox: ${i.subject} — ${i.patientName}`, detail: i.attentionReason ?? i.status, tone: 'info' as FactTone })),
      ]),
      section('Unfiled Inbox', [{ text: `${plural(w.unfiledInbox.length, 'unfiled record')}${flagged.length ? `, ${flagged.length} needing attention` : ''}` }]),
    ].filter((s) => s.items.length),
    empty: false,
    link: { label: 'Open the Dashboard', path: '/dashboard' },
  };
}

// ----------------------------------------------------------------------------------------- patient

const RECORD_TITLES: Record<RecordKind, string> = { medication: 'Medications', diagnosis: 'Diagnoses', task: 'Tasks', recall: 'Recalls', appointment: 'Appointments' };

function recordLine(kind: RecordKind, r: unknown): SummaryFacts['sections'][number]['items'][number] {
  switch (kind) {
    case 'medication': {
      const m = r as Medication;
      return { text: [m.name, m.dosage, m.frequency?.toLowerCase()].filter(Boolean).join(' '), detail: [m.status, m.route, m.duration, m.indication ? `for ${m.indication}` : '', m.startDate ? `since ${day(m.startDate)}` : ''].filter(Boolean).join(' · '), tone: m.status === 'Active' ? 'success' : 'neutral' };
    }
    case 'diagnosis': {
      const d = r as Diagnosis;
      return { text: `${d.description}${d.icd10 ? ` (${d.icd10})` : ''}`, detail: [d.status, d.severity, d.onsetDate ? `onset ${day(d.onsetDate)}` : ''].filter(Boolean).join(' · '), tone: d.status === 'Active' || d.status === 'Chronic' ? 'warning' : 'neutral' };
    }
    case 'task': {
      const t = r as Task;
      const overdue = (t.status === 'Open' || t.status === 'In Progress') && dayjs(t.dueDate).isBefore(dayjs().startOf('day'));
      return { text: t.title, detail: [t.status, t.priority, t.dueDate ? `due ${day(t.dueDate)}` : '', overdue ? 'overdue' : '', t.assignedTo].filter(Boolean).join(' · '), tone: overdue ? 'error' : t.status === 'Completed' ? 'success' : 'info' };
    }
    case 'recall': {
      const c = r as Recall;
      return { text: c.reason, detail: [c.status, c.type, c.dueDate ? `due ${day(c.dueDate)}` : '', c.priority].filter(Boolean).join(' · '), tone: c.status === 'Due' ? 'warning' : 'neutral' };
    }
    case 'appointment': {
      const a = r as Appointment;
      return { text: `${day(a.date)} ${time(a.startTime)} — ${a.type}`, detail: [a.reason, a.providerName, a.status].filter(Boolean).join(' · '), tone: a.status === 'Cancelled' || a.status === 'No Show' ? 'neutral' : 'info' };
    }
  }
}

function recordsFacts(kind: RecordKind, patient: Patient, src: SummarySource): SummaryFacts {
  const rows = src.records(kind, patient.id);
  const items = rows.map((r) => recordLine(kind, r));
  const byStatus = countBy(rows as Array<{ status: string }>, (r) => r.status);
  return {
    title: `${RECORD_TITLES[kind]}`,
    scope: `${patient.fullName} · ${plural(rows.length, RECORD_TITLES[kind].toLowerCase().replace(/s$/, ''), RECORD_TITLES[kind].toLowerCase())}`,
    stats: [{ label: 'Total', value: String(rows.length), tone: 'primary' as FactTone }, ...byStatus.slice(0, 3).map(([status, n]) => ({ label: status, value: String(n), tone: 'neutral' as FactTone }))],
    sections: rows.length ? [section(RECORD_TITLES[kind], items)] : [],
    empty: rows.length === 0,
    emptyText: `${patient.fullName} has no ${RECORD_TITLES[kind].toLowerCase()}.`,
    link: { label: `Open ${RECORD_TITLES[kind]}`, path: `/summary/${kind}` },
  };
}

function patientFacts(patient: Patient, src: SummarySource): SummaryFacts {
  const of = <T,>(kind: RecordKind) => src.records(kind, patient.id) as T[];
  const medications = of<Medication>('medication');
  const diagnoses = of<Diagnosis>('diagnosis');
  const tasks = of<Task>('task');
  const recalls = of<Recall>('recall');
  const appointments = of<Appointment>('appointment');
  const narrative = buildPatientNarrative({ patient, medications, diagnoses, tasks, recalls, appointments });
  const activeMeds = medications.filter((m) => m.status === 'Active');
  const activeDx = diagnoses.filter((d) => d.status === 'Active' || d.status === 'Chronic');
  const openTasks = tasks.filter((t) => t.status === 'Open' || t.status === 'In Progress');
  const dueRecalls = recalls.filter((r) => r.status === 'Due');
  const today = dayjs().format('YYYY-MM-DD');
  const upcoming = appointments.filter((a) => a.date >= today && !['Cancelled', 'No Show', 'Completed'].includes(a.status));
  return {
    title: 'Patient summary',
    scope: `${patient.fullName} · ${patient.age}y ${patient.gender} · MRN ${patient.mrn}`,
    stats: [
      { label: 'Active meds', value: String(activeMeds.length), tone: 'primary' },
      { label: 'Active problems', value: String(activeDx.length), tone: activeDx.length ? 'warning' : 'neutral' },
      { label: 'Open tasks', value: String(openTasks.length), tone: 'info' },
      { label: 'Recalls due', value: String(dueRecalls.length), tone: dueRecalls.length ? 'warning' : 'neutral' },
    ],
    sections: [
      section('In brief', narrative.sections.map((s) => ({ text: `${s.title}: ${s.body}` }))),
      section('Active problems', activeDx.map((d) => recordLine('diagnosis', d))),
      section('Active medications', activeMeds.map((m) => recordLine('medication', m))),
      section('Open tasks', openTasks.map((t) => recordLine('task', t))),
      section('Recalls due', dueRecalls.map((r) => recordLine('recall', r))),
      section('Upcoming appointments', upcoming.sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`)).map((a) => recordLine('appointment', a))),
    ].filter((s) => s.items.length),
    empty: false,
    link: { label: 'Open the Summary', path: '/summary' },
  };
}

// ------------------------------------------------------------------------------------- other pages

function patientsFacts(src: SummarySource): SummaryFacts {
  const all = src.patients;
  const byStatus = countBy(all, (p) => p.status);
  const byProvider = countBy(all, (p) => p.primaryProviderName);
  const recent = [...all].filter((p) => p.lastVisit).sort((a, b) => (b.lastVisit ?? '').localeCompare(a.lastVisit ?? ''));
  return {
    title: 'Patients',
    scope: plural(all.length, 'patient'),
    stats: [{ label: 'Patients', value: String(all.length), tone: 'primary' as FactTone }, ...byStatus.slice(0, 3).map(([s, n]) => ({ label: s, value: String(n), tone: 'neutral' as FactTone }))],
    sections: [
      section('By primary provider', byProvider.map(([name, n]) => ({ text: `${name}: ${plural(n, 'patient')}` }))),
      section('Seen most recently', recent.map((p) => ({ text: p.fullName, detail: `${p.age}y ${p.gender} · MRN ${p.mrn} · last visit ${day(p.lastVisit)}` }))),
    ].filter((s) => s.items.length),
    empty: all.length === 0,
    emptyText: 'There are no patients.',
    link: { label: 'Open Patients', path: '/patients' },
  };
}

function scheduleFacts(src: SummarySource): SummaryFacts {
  const today = dayjs().format('YYYY-MM-DD');
  const all = src.providerAppointments();
  const booked = all.filter((a) => a.date >= today && !['Cancelled', 'No Show', 'Completed'].includes(a.status)).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  const todays = booked.filter((a) => a.date === today);
  const week = booked.filter((a) => dayjs(a.date).diff(dayjs(today), 'day') < 7);
  const cancelled = all.filter((a) => a.date >= today && a.status === 'Cancelled');
  return {
    title: 'My appointments',
    scope: plural(booked.length, 'upcoming appointment'),
    stats: [
      { label: 'Today', value: String(todays.length), tone: 'primary' },
      { label: 'Next 7 days', value: String(week.length), tone: 'info' },
      { label: 'Upcoming', value: String(booked.length), tone: 'neutral' },
      { label: 'Cancelled', value: String(cancelled.length), tone: cancelled.length ? 'warning' : 'neutral' },
    ],
    sections: [
      section('Coming up', booked.map((a) => ({ text: `${day(a.date)} ${time(a.startTime)} — ${a.patientName}`, detail: [a.type, a.reason, a.status].filter(Boolean).join(' · ') }))),
      section('By visit type', countBy(booked, (a) => a.type).map(([t, n]) => ({ text: `${t}: ${n}` }))),
    ].filter((s) => s.items.length),
    empty: booked.length === 0,
    emptyText: 'You have no upcoming appointments.',
    link: { label: 'Open My Appointments', path: '/schedule' },
  };
}

function configurationFacts(src: SummarySource): SummaryFacts {
  const lines = src.configuration?.() ?? [];
  return {
    title: 'AI configuration',
    scope: 'Models and agents',
    stats: [],
    sections: lines.length ? [section('In use', lines.map((text) => ({ text })))] : [],
    empty: !lines.length,
    emptyText: 'The AI configuration could not be read.',
    link: { label: 'Open Configuration', path: '/configuration' },
  };
}

// ------------------------------------------------------------------------------------------- entry

/** The facts for a target, from the app's data. */
export function collectFacts(target: SummaryTarget, src: SummarySource): SummaryFacts {
  switch (target.kind) {
    case 'inbox':
      return inboxFacts(target, src);
    case 'dashboard':
      return dashboardFacts(src);
    case 'patients':
      return patientsFacts(src);
    case 'schedule':
      return scheduleFacts(src);
    case 'configuration':
      return configurationFacts(src);
    case 'patient': {
      const patient = src.patients.find((p) => p.id === (target.patientId ?? src.selectedPatientId));
      if (!patient) {
        return { title: target.records ? RECORD_TITLES[target.records] : 'Patient summary', scope: 'No patient', stats: [], sections: [], empty: true, emptyText: 'No patient is selected — say which patient to summarize.', link: { label: 'Open Patients', path: '/patients' } };
      }
      return target.records ? recordsFacts(target.records, patient, src) : patientFacts(patient, src);
    }
  }
}

/** The facts as the model reads them: DATA, plain lines. */
export function factsText(facts: SummaryFacts): string {
  if (facts.empty) return facts.emptyText ?? 'Nothing.';
  const lines: string[] = [];
  if (facts.stats.length) lines.push(facts.stats.map((s) => `${s.label}: ${s.value}`).join('; '));
  for (const s of facts.sections) {
    lines.push(`${s.title}:`);
    for (const i of s.items) lines.push(`- ${i.text}${i.detail ? ` (${i.detail})` : ''}`);
    if (s.more) lines.push(`- … and ${s.more} more`);
  }
  return lines.join('\n');
}

/** A summary written from the facts alone — what the panel shows when no model answers. */
export function ruleSummary(facts: SummaryFacts): string {
  if (facts.empty) return facts.emptyText ?? 'There is nothing to summarize.';
  const brief = facts.sections.find((s) => s.title === 'In brief');
  if (brief) return brief.items.map((i) => i.text.replace(/^[^:]+:\s*/, '')).join(' ');
  const stats = facts.stats.filter((s) => s.value !== '0').map((s) => `${s.value} ${s.label.toLowerCase()}`);
  const first = facts.sections.find((s) => s.items.length && s.title !== 'By category');
  const top = first ? list(first.items.map((i) => i.text), 3) : '';
  return [`${facts.title} — ${facts.scope}.`, stats.length ? `${list(stats, 4)}.` : '', top ? `${first!.title.replace(/\s*\(.*\)$/, '')}: ${top}.` : ''].filter(Boolean).join(' ');
}

import { useEffect, useMemo, useReducer, useRef } from 'react';
import { Button, Form, Tabs } from 'antd';
import { CalendarPlus, ListChecks, Pill, Plus, Repeat, Stethoscope } from 'lucide-react';
import dayjs, { type Dayjs } from 'dayjs';
import { useAppDispatch, useAppSelector } from '@/store';
import { providerSelectors } from '@/store/slices/providerSlice';
import { patientSelectors } from '@/store/slices/patientSlice';
import { recordSlices } from '@/store/slices/recordSlices';
import { useSelectedPatient } from '@/hooks/usePatientData';
import type { EntryStore } from '@/hooks';
import type { FieldValues } from '@/types/ai';
import type { RecordKind } from '@/types/records';
import type { Appointment, Diagnosis, Medication, Recall, Task } from '@/types/domain';
import { FieldRegistry } from '@/registry/fieldRegistry';
import { defaultValues } from '@/registry/recordDefaults';
import { FormGrid, FormSection } from '@/components/common';
import { RegisteredFormModal } from './RegisteredForm';
import { CheckboxField, DateField, NumberField, PatientSelectField, ProviderSelectField, SelectField, TextField, TimeField } from './fields';
import { findPatientByRef, patientRef, patientRefName } from '@/services/records/patientRef';
import { recordLabel } from '@/services/records/recordMapping';
import { batchConflicts, slotFromValues } from '@/services/appointments/conflicts';

export type { RecordKind };
type AnyValues = Record<string, unknown>;

const icons: Record<RecordKind, React.ReactNode> = {
  medication: <Pill size={18} />,
  diagnosis: <Stethoscope size={18} />,
  task: <ListChecks size={18} />,
  recall: <Repeat size={18} />,
  appointment: <CalendarPlus size={18} />,
};

const titles: Record<RecordKind, string> = {
  medication: 'Medication',
  diagnosis: 'Diagnosis',
  task: 'Task',
  recall: 'Recall',
  appointment: 'Appointment',
};

/**
 * Prefills reach a form as plain strings — from the Inbox cards, the AI Summary
 * extraction, and anything else that hands over values it read as text. Ant
 * Design's date and time pickers only accept Dayjs objects (a string makes them
 * call `.isValid()` on it and throw), so every incoming value is converted to
 * what its field actually expects before it is used as an initial value.
 *
 * Values the form has no field for are dropped rather than passed through.
 */
export function toFormInitialValues(formId: string, values: Record<string, unknown> = {}): AnyValues {
  const out: AnyValues = {};
  for (const [key, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const field = FieldRegistry.resolveField(formId, key);
    if (!field) continue;
    if (dayjs.isDayjs(raw)) {
      out[field.name] = raw;
      continue;
    }
    switch (field.type) {
      case 'date': {
        const parsed = dayjs(String(raw));
        if (parsed.isValid()) out[field.name] = parsed;
        break;
      }
      case 'time': {
        const text = String(raw).trim();
        const parsed = dayjs(`2000-01-01T${text.length === 4 ? `0${text}` : text}`);
        if (parsed.isValid()) out[field.name] = parsed;
        break;
      }
      case 'number': {
        const n = Number(String(raw).replace(/[^\d.-]/g, ''));
        if (!Number.isNaN(n)) out[field.name] = n;
        break;
      }
      case 'checkbox':
        out[field.name] = raw === true || raw === 'true' || raw === 'Yes';
        break;
      default:
        out[field.name] = typeof raw === 'boolean' ? raw : String(raw);
    }
  }
  return out;
}

const asDate = (v: unknown): string | undefined => (dayjs.isDayjs(v) ? (v as Dayjs).format('YYYY-MM-DD') : typeof v === 'string' && v ? v : undefined);
const asTime = (v: unknown): string | undefined => (dayjs.isDayjs(v) ? (v as Dayjs).format('HH:mm') : typeof v === 'string' && v ? v : undefined);
const str = (v: unknown, fallback = ''): string => (v === undefined || v === null || v === '' ? fallback : String(v));
const num = (v: unknown, fallback: number): number => (v === undefined || v === null || v === '' ? fallback : Number(v) || fallback);

/** Domain record -> antd form values (dates become Dayjs so the pickers show them). */
export function recordToFormValues(kind: RecordKind, row: Medication | Diagnosis | Task | Recall | Appointment): AnyValues {
  switch (kind) {
    case 'medication': {
      const m = row as Medication;
      return {
        medicationName: m.name, dosage: m.dosage, route: m.route, frequency: m.frequency, duration: m.duration,
        startDate: m.startDate ? dayjs(m.startDate) : undefined, endDate: m.endDate ? dayjs(m.endDate) : undefined,
        indication: m.indication, status: m.status, prescribedBy: m.prescribedBy, refills: m.refills ?? 0,
        isPRN: m.isPRN ?? false, instructions: m.instructions, notes: m.notes,
      };
    }
    case 'diagnosis': {
      const d = row as Diagnosis;
      return {
        description: d.description, icd10: d.icd10, status: d.status, severity: d.severity,
        onsetDate: d.onsetDate ? dayjs(d.onsetDate) : undefined, diagnosedBy: d.diagnosedBy, notes: d.notes,
      };
    }
    case 'task': {
      const t = row as Task;
      return {
        title: t.title, category: t.category, assignedTo: t.assignedTo, dueDate: t.dueDate ? dayjs(t.dueDate) : undefined,
        priority: t.priority, status: t.status, description: t.description,
      };
    }
    case 'recall': {
      const r = row as Recall;
      return {
        reason: r.reason, type: r.type, dueDate: r.dueDate ? dayjs(r.dueDate) : undefined,
        priority: r.priority, status: r.status, notes: r.notes,
      };
    }
    case 'appointment': {
      const a = row as Appointment;
      return {
        providerName: a.providerName, date: a.date ? dayjs(a.date) : undefined, startTime: a.startTime ? dayjs(`2000-01-01T${a.startTime}`) : undefined,
        durationMinutes: a.durationMinutes, type: a.type, reason: a.reason, locationName: a.locationName,
        status: a.status, priority: a.priority, isTelehealth: a.isTelehealth, notes: a.notes,
      };
    }
  }
}

/** Fresh-record defaults, so a dictated record is complete enough to save. */
// Shared with the Safety Agent: a value a form opens with is the application's own, not a model's guess.
export { defaultValues } from '@/registry/recordDefaults';

interface SaveContext {
  patientId: string;
  patientName: string;
  patientMrn: string;
  authorName: string;
  providerId?: string;
  existing?: Medication | Diagnosis | Task | Recall | Appointment;
}

/** antd form values -> the domain record that gets stored. Always bound to the selected patient. */
export function formValuesToRecord(kind: RecordKind, values: AnyValues, ctx: SaveContext): Record<string, unknown> {
  const base = { patientId: ctx.patientId, patientName: ctx.patientName };
  switch (kind) {
    case 'medication': {
      const prev = ctx.existing as Medication | undefined;
      return {
        ...base,
        name: str(values.medicationName, prev?.name ?? ''),
        dosage: str(values.dosage, prev?.dosage ?? ''),
        route: str(values.route, prev?.route ?? 'Oral'),
        frequency: str(values.frequency, prev?.frequency ?? ''),
        duration: str(values.duration, prev?.duration ?? 'Ongoing'),
        startDate: asDate(values.startDate) ?? prev?.startDate ?? dayjs().format('YYYY-MM-DD'),
        endDate: asDate(values.endDate),
        prescribedBy: str(values.prescribedBy, prev?.prescribedBy ?? ctx.authorName),
        indication: str(values.indication) || undefined,
        instructions: str(values.instructions) || undefined,
        notes: str(values.notes) || undefined,
        refills: num(values.refills, prev?.refills ?? 0),
        status: str(values.status, prev?.status ?? 'Active'),
        isPRN: values.isPRN === true,
      };
    }
    case 'diagnosis': {
      const prev = ctx.existing as Diagnosis | undefined;
      return {
        ...base,
        description: str(values.description, prev?.description ?? ''),
        icd10: str(values.icd10, prev?.icd10 ?? ''),
        status: str(values.status, prev?.status ?? 'Active'),
        severity: str(values.severity, prev?.severity ?? 'Moderate'),
        onsetDate: asDate(values.onsetDate) ?? prev?.onsetDate ?? dayjs().format('YYYY-MM-DD'),
        resolvedDate: str(values.status) === 'Resolved' ? prev?.resolvedDate ?? dayjs().format('YYYY-MM-DD') : undefined,
        diagnosedBy: str(values.diagnosedBy, prev?.diagnosedBy ?? ctx.authorName),
        notes: str(values.notes) || undefined,
      };
    }
    case 'task': {
      const prev = ctx.existing as Task | undefined;
      const status = str(values.status, prev?.status ?? 'Open');
      return {
        ...base,
        title: str(values.title, prev?.title ?? ''),
        category: str(values.category, prev?.category ?? 'Follow-up'),
        description: str(values.description) || undefined,
        assignedTo: str(values.assignedTo, prev?.assignedTo ?? ctx.authorName),
        dueDate: asDate(values.dueDate) ?? prev?.dueDate ?? dayjs().add(7, 'day').format('YYYY-MM-DD'),
        priority: str(values.priority, prev?.priority ?? 'Normal'),
        status,
        createdBy: prev?.createdBy ?? ctx.authorName,
        createdAt: prev?.createdAt ?? new Date().toISOString(),
        completedAt: status === 'Completed' ? prev?.completedAt ?? new Date().toISOString() : undefined,
      };
    }
    case 'recall': {
      const prev = ctx.existing as Recall | undefined;
      return {
        ...base,
        reason: str(values.reason, prev?.reason ?? ''),
        type: str(values.type, prev?.type ?? 'Follow-up'),
        dueDate: asDate(values.dueDate) ?? prev?.dueDate ?? dayjs().add(1, 'month').format('YYYY-MM-DD'),
        priority: str(values.priority, prev?.priority ?? 'Normal'),
        status: str(values.status, prev?.status ?? 'Due'),
        notes: str(values.notes) || undefined,
        createdBy: prev?.createdBy ?? ctx.authorName,
        createdAt: prev?.createdAt ?? new Date().toISOString(),
      };
    }
    case 'appointment': {
      const prev = ctx.existing as Appointment | undefined;
      const start = asTime(values.startTime) ?? prev?.startTime ?? '09:00';
      const duration = num(values.durationMinutes, prev?.durationMinutes ?? 30);
      const end = dayjs(`2000-01-01T${start}`).add(duration, 'minute').format('HH:mm');
      return {
        ...base,
        code: prev?.code ?? `APT-${Math.floor(100000 + Math.random() * 899999)}`,
        patientMrn: ctx.patientMrn,
        providerId: prev?.providerId ?? ctx.providerId ?? 'unknown',
        providerName: str(values.providerName, prev?.providerName ?? ''),
        date: asDate(values.date) ?? prev?.date ?? dayjs().format('YYYY-MM-DD'),
        startTime: start,
        endTime: end,
        durationMinutes: duration,
        type: str(values.type, prev?.type ?? 'Follow-up'),
        locationId: prev?.locationId ?? 'loc-1',
        locationName: str(values.locationName, prev?.locationName ?? 'Riverside Medical Center'),
        room: prev?.room,
        status: str(values.status, prev?.status ?? 'Scheduled'),
        reason: str(values.reason, prev?.reason ?? ''),
        notes: str(values.notes) || undefined,
        priority: str(values.priority, prev?.priority ?? 'Routine'),
        createdAt: prev?.createdAt ?? new Date().toISOString(),
        checkedInAt: prev?.checkedInAt,
        isTelehealth: values.isTelehealth === true,
        reminderSent: prev?.reminderSent ?? false,
      };
    }
  }
}

interface Props {
  kind: RecordKind;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Editing an existing record; omitted when adding a new one. */
  record?: Medication | Diagnosis | Task | Recall | Appointment;
  /** Values to pre-fill a new record with (used by the AI Summary). */
  prefill?: FieldValues;
  onSaved?: () => void;
}

/**
 * The create/edit dialog for the five patient record types.
 *
 * It registers itself with the FormRegistry under its record kind, so the voice
 * executor opens, fills, validates and submits exactly the same form the user
 * sees — nothing is saved until the form is submitted.
 */
export function RecordFormModal({ kind, open, onOpen, onClose, record, prefill, onSaved }: Props) {
  const dispatch = useAppDispatch();
  const patient = useSelectedPatient();
  const user = useAppSelector((s) => s.auth.user);
  const providers = useAppSelector(providerSelectors.selectAll);
  const patients = useAppSelector(patientSelectors.selectAll);
  const [form] = Form.useForm<AnyValues>();
  // Every record slice has the same shape; picking one concrete type keeps the
  // dispatch calls below monomorphic instead of a five-way thunk union.
  const slice = recordSlices[kind] as (typeof recordSlices)['medication'];
  const authorName = user?.fullName ?? 'Unknown';
  // An appointment is with the signed-in provider unless another one is named (as in the care plan).
  const ownProvider = providers.find((p) => p.id === user?.providerId)?.fullName;
  const editing = !!record;

  // New records are for the selected patient unless their Patient field is changed (each tab its own).
  const recordPatient = record ? patients.find((p) => p.id === record.patientId) : undefined;
  const defaultPatient = recordPatient ?? patient;
  const defaultRef = defaultPatient ? patientRef(defaultPatient) : undefined;
  const initialValues = useMemo<AnyValues>(() => {
    if (record) return { ...recordToFormValues(kind, record), patient: defaultRef };
    return { ...defaultValues(kind, authorName), ...(kind === 'appointment' && ownProvider ? { providerName: ownProvider } : {}), patient: defaultRef, ...toFormInitialValues(kind, prefill) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, record, authorName, ownProvider, defaultRef, JSON.stringify(prefill ?? {})]);

  // Multi-entry support: "add panadol and metformin" fills one record tab each, saved together after a
  // single review. Records are grouped into numbered main tabs (Tab 1, Tab 2…), one patient per tab —
  // each tab its own workspace: its patient, its records, and that patient's existing chart.
  const itemsRef = useRef<AnyValues[]>([{}]);
  /** The main tab each record belongs to (parallel to itemsRef). */
  const tabIdsRef = useRef<string[]>(['t0']);
  const tabCounter = useRef(1);
  const activeRef = useRef(0);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const count = itemsRef.current.length;
  const primaryName = { medication: 'medicationName', diagnosis: 'description', task: 'title', recall: 'reason', appointment: 'reason' }[kind];
  const liveLabel = Form.useWatch(primaryName, form) as string | undefined;
  const livePatient = Form.useWatch('patient', form) as string | undefined;

  // Re-seed the form whenever it is opened for a different record (edit vs add).
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(initialValues as never);
    itemsRef.current = [{}];
    tabIdsRef.current = ['t0'];
    tabCounter.current = 1;
    activeRef.current = 0;
    rerender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues]);

  /** A record's patient: the one on screen read live; one never given a patient is the default one. */
  const patientOf = (i: number): string | undefined => {
    // Read from the form itself, not the watched value: the assistant adds several records in one go,
    // before a re-render could bring the watch up to date.
    if (i === activeRef.current) return (form.getFieldValue('patient') as string | undefined) || undefined;
    const it = itemsRef.current[i];
    return 'patient' in it ? (it.patient as string | undefined) || undefined : defaultRef;
  };
  const entryPatients = itemsRef.current.map((_, i) => patientOf(i));
  const tabOrder = [...new Set(tabIdsRef.current)];
  const activeTab = tabIdsRef.current[activeRef.current];
  const tabPatient = (tab: string) => entryPatients[tabIdsRef.current.indexOf(tab)];
  const distinctPatients = [...new Set(entryPatients.filter(Boolean))];
  const entryLabels = itemsRef.current.map((it, i) => (i === activeRef.current ? liveLabel : (it[primaryName] as string)) || `${titles[kind]} ${i + 1}`);

  // One patient per tab: changing it on any record of the tab changes it for the whole tab.
  useEffect(() => {
    if (!open || editing) return;
    const tab = tabIdsRef.current[activeRef.current];
    itemsRef.current = itemsRef.current.map((it, i) => (i !== activeRef.current && tabIdsRef.current[i] === tab ? { ...it, patient: livePatient } : it));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePatient]);

  const snapshotActive = () => {
    const live = form.getFieldsValue(true) as AnyValues;
    itemsRef.current = itemsRef.current.map((it, i) => (i === activeRef.current ? live : it));
  };
  const load = (values: AnyValues) => {
    form.resetFields();
    form.setFieldsValue({ ...initialValues, ...values } as never);
  };
  const switchTo = (index: number) => {
    if (index === activeRef.current || index < 0 || index >= itemsRef.current.length) return;
    snapshotActive();
    activeRef.current = index;
    load(itemsRef.current[index]);
    rerender();
  };
  /**
   * A new record — in `tab`, or (from the assistant) in the tab of the patient it names: a patient not in
   * any tab yet gets a new tab.
   */
  const addEntry = (values: AnyValues = {}, tab?: string) => {
    const named = 'patient' in values ? (values.patient as string | undefined) || undefined : defaultRef;
    const existing = named ? itemsRef.current.findIndex((_, i) => patientOf(i) === named) : -1;
    const target = tab ?? (existing >= 0 ? tabIdsRef.current[existing] : `t${tabCounter.current++}`);
    snapshotActive();
    itemsRef.current = [...itemsRef.current, values];
    tabIdsRef.current = [...tabIdsRef.current, target];
    activeRef.current = itemsRef.current.length - 1;
    load(values);
    rerender();
    return activeRef.current;
  };
  /** A new, empty tab: no patient chosen yet. */
  const addTab = () => addEntry({ patient: undefined }, `t${tabCounter.current++}`);
  const removeEntry = (index: number) => {
    if (itemsRef.current.length <= 1) return;
    snapshotActive();
    itemsRef.current = itemsRef.current.filter((_, i) => i !== index);
    tabIdsRef.current = tabIdsRef.current.filter((_, i) => i !== index);
    activeRef.current = Math.min(activeRef.current > index ? activeRef.current - 1 : activeRef.current, itemsRef.current.length - 1);
    load(itemsRef.current[activeRef.current]);
    rerender();
  };
  const removeTab = (tab: string) => {
    if (tabOrder.length <= 1) return;
    snapshotActive();
    const keep = tabIdsRef.current.map((t) => t !== tab);
    const activeKept = keep[activeRef.current];
    itemsRef.current = itemsRef.current.filter((_, i) => keep[i]);
    tabIdsRef.current = tabIdsRef.current.filter((_, i) => keep[i]);
    activeRef.current = activeKept ? keep.slice(0, activeRef.current).filter(Boolean).length : 0;
    load(itemsRef.current[activeRef.current]);
    rerender();
  };

  const entries: EntryStore<AnyValues> = {
    get items() {
      return itemsRef.current;
    },
    get active() {
      return activeRef.current;
    },
    setActive: switchTo,
    add: (values) => addEntry(values),
  };

  const submit = async (values: AnyValues) => {
    // An existing record stays with its patient; a new one goes to the patient its tab names — never to
    // anyone by default.
    const target = record ? recordPatient : findPatientByRef(patients, values.patient);
    if (!target) throw new Error('Choose the patient for every tab before saving.');
    const provider = providers.find((p) => p.fullName === values.providerName);
    const payload = formValuesToRecord(kind, values, {
      patientId: target.id,
      patientName: target.fullName,
      patientMrn: target.mrn,
      authorName,
      providerId: provider?.id,
      existing: record,
    });
    if (record) await dispatch(slice.update({ id: record.id, patch: payload as never })).unwrap();
    else await dispatch(slice.create(payload as never)).unwrap();
    onSaved?.();
  };

  // No double booking: every appointment in the dialog against what is booked, and against each other.
  const booked = useAppSelector(recordSlices.appointment.selectors.selectAll);
  const checkAll =
    kind === 'appointment'
      ? (all: Record<string, unknown>[]) =>
          batchConflicts(
            booked,
            all.map((v) => {
              const who = record ? recordPatient : findPatientByRef(patients, v.patient);
              const provider = providers.find((p) => p.fullName === v.providerName);
              return slotFromValues(v, { id: record?.id, patientId: who?.id, patientName: who?.fullName, providerId: provider?.id });
            }),
          )
      : undefined;

  const noun = titles[kind].toLowerCase();
  const tabRecords = entryLabels.flatMap((label, i) => (tabIdsRef.current[i] === activeTab ? [{ key: String(i), label, closable: true }] : []));
  const header = editing ? undefined : (
    <>
      <Tabs
        className="entry-patient-tabs"
        type="editable-card"
        size="small"
        activeKey={activeTab}
        onChange={(tab) => switchTo(tabIdsRef.current.indexOf(tab))}
        onEdit={(tab, action) => (action === 'add' ? addTab() : removeTab(String(tab)))}
        addIcon={<Plus size={14} aria-label="Add tab" />}
        items={tabOrder.map((tab, n) => ({ key: tab, label: `Tab ${n + 1}`, closable: tabOrder.length > 1 }))}
        tabBarExtraContent={
          <Button size="small" type="text" icon={<Plus size={14} />} onClick={() => addEntry({ patient: tabPatient(activeTab) }, activeTab)}>
            Add {noun}
          </Button>
        }
        style={{ marginBottom: 6 }}
      />
      {tabRecords.length > 1 && (
        <Tabs
          className="entry-record-tabs"
          type="editable-card"
          size="small"
          hideAdd
          activeKey={String(activeRef.current)}
          onChange={(k) => switchTo(Number(k))}
          onEdit={(key, action) => {
            if (action === 'remove') removeEntry(Number(key));
          }}
          items={tabRecords}
          style={{ marginBottom: 6 }}
        />
      )}
      <PatientRecordsGlance patientRef={livePatient} />
    </>
  );

  const title = editing ? `Edit ${titles[kind]}` : `Add ${titles[kind]}${count > 1 ? ` (${count})` : ''}`;
  const emptyTab = tabOrder.findIndex((tab) => !tabPatient(tab));
  const who = distinctPatients.length > 1 ? `${distinctPatients.length} patients` : patientRefName(distinctPatients[0]) || undefined;
  const description = editing
    ? `Update this ${noun} for ${who ?? 'the patient'}.`
    : emptyTab >= 0
      ? `Choose the patient for Tab ${emptyTab + 1} — nothing is saved for a tab without one.`
      : count > 1
        ? `${count} ${noun}s will be saved for ${who} once you confirm.`
        : `This ${noun} will be saved for ${who}.`;

  return (
    <RegisteredFormModal<AnyValues>
      formId={kind}
      title={title}
      icon={icons[kind]}
      description={description}
      open={open}
      onOpen={onOpen}
      onClose={onClose}
      onSubmit={submit}
      initialValues={initialValues}
      form={form}
      entries={editing ? undefined : entries}
      submitLabel={editing ? `Update ${titles[kind]}` : undefined}
      header={header}
      checkAll={checkAll}
    >
      {({ fc }) => <RecordFields kind={kind} fc={fc} lockPatient={editing} />}
    </RegisteredFormModal>
  );
}

const glanceKinds: Array<{ kind: RecordKind; one: string; many: string }> = [
  { kind: 'medication', one: 'medication', many: 'medications' },
  { kind: 'diagnosis', one: 'diagnosis', many: 'diagnoses' },
  { kind: 'task', one: 'task', many: 'tasks' },
  { kind: 'recall', one: 'recall', many: 'recalls' },
  { kind: 'appointment', one: 'appointment', many: 'appointments' },
];

/**
 * The chart of the patient a tab is for — their medications, diagnoses, tasks, recalls and appointments
 * as they are now — so the provider sees what exists while adding more. Only that patient's; with no
 * patient chosen, nothing (never another patient's records).
 */
function PatientRecordsGlance({ patientRef: ref }: { patientRef?: string }) {
  const patients = useAppSelector(patientSelectors.selectAll);
  const lists: Record<RecordKind, Array<{ id: string; patientId: string }>> = {
    medication: useAppSelector(recordSlices.medication.selectors.selectAll),
    diagnosis: useAppSelector(recordSlices.diagnosis.selectors.selectAll),
    task: useAppSelector(recordSlices.task.selectors.selectAll),
    recall: useAppSelector(recordSlices.recall.selectors.selectAll),
    appointment: useAppSelector(recordSlices.appointment.selectors.selectAll),
  };
  const patient = findPatientByRef(patients, ref);
  if (!patient) {
    return <div className="patient-glance is-empty">Choose this tab&apos;s patient to see their records.</div>;
  }
  const mine = glanceKinds.map((g) => ({ ...g, rows: lists[g.kind].filter((r) => r.patientId === patient.id) }));
  return (
    <details className="patient-glance" open>
      <summary>
        <strong>{patient.fullName}&apos;s records</strong>
        <span className="muted"> — {mine.map((m) => `${m.rows.length} ${m.rows.length === 1 ? m.one : m.many}`).join(' · ')}</span>
      </summary>
      <div className="patient-glance-grid">
        {mine.map(({ kind, many, rows }) => (
          <div key={kind} className="patient-glance-col">
            <div className="patient-glance-head">{many.charAt(0).toUpperCase() + many.slice(1)}</div>
            {rows.length ? (
              <ul>
                {rows.slice(0, 4).map((r) => (
                  <li key={r.id}>{recordLabel(kind, r as never)}</li>
                ))}
                {rows.length > 4 && <li className="muted">+{rows.length - 4} more</li>}
              </ul>
            ) : (
              <div className="muted">No {many} found</div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

export function RecordFields({ kind, fc, lockPatient }: { kind: RecordKind; fc: (name: string) => string | undefined; lockPatient?: boolean }) {
  const formId = kind;
  const who = <PatientSelectField formId={formId} fc={fc} span={2} disabled={lockPatient} />;
  switch (kind) {
    case 'medication':
      return (
        <>
          <FormSection title="Medication">
            <FormGrid cols={2}>
              {who}
              <TextField formId={formId} name="medicationName" fc={fc} span={2} placeholder="e.g. Amoxicillin" />
              <TextField formId={formId} name="dosage" fc={fc} placeholder="e.g. 500 mg" />
              <SelectField formId={formId} name="route" fc={fc} />
              <SelectField formId={formId} name="frequency" fc={fc} />
              <TextField formId={formId} name="duration" fc={fc} placeholder="e.g. 7 days" />
              <DateField formId={formId} name="startDate" fc={fc} />
              <DateField formId={formId} name="endDate" fc={fc} help="Leave empty for ongoing medication" />
            </FormGrid>
          </FormSection>
          <FormSection title="Clinical detail">
            <FormGrid cols={2}>
              <TextField formId={formId} name="indication" fc={fc} placeholder="Reason for medication" />
              <SelectField formId={formId} name="status" fc={fc} />
              <ProviderSelectField formId={formId} name="prescribedBy" fc={fc} label="Prescribed By" />
              <NumberField formId={formId} name="refills" fc={fc} min={0} max={12} />
              <CheckboxField formId={formId} name="isPRN" fc={fc} />
            </FormGrid>
          </FormSection>
          <FormSection title="Instructions">
            <FormGrid cols={2}>
              <TextField formId={formId} name="instructions" fc={fc} span={2} textarea rows={2} placeholder="e.g. Take with food" />
              <TextField formId={formId} name="notes" fc={fc} span={2} textarea rows={2} />
            </FormGrid>
          </FormSection>
        </>
      );
    case 'diagnosis':
      return (
        <>
          <FormSection title="Diagnosis">
            <FormGrid cols={2}>
              {who}
              <TextField formId={formId} name="description" fc={fc} span={2} placeholder="e.g. Hypertension" />
              <TextField formId={formId} name="icd10" fc={fc} placeholder="e.g. I10" help="Optional — leave empty if unknown" />
              <DateField formId={formId} name="onsetDate" fc={fc} />
              <SelectField formId={formId} name="status" fc={fc} />
              <SelectField formId={formId} name="severity" fc={fc} />
              <ProviderSelectField formId={formId} name="diagnosedBy" fc={fc} label="Diagnosed By" span={2} />
            </FormGrid>
          </FormSection>
          <FormSection title="Notes">
            <FormGrid cols={2}>
              <TextField formId={formId} name="notes" fc={fc} span={2} textarea rows={3} />
            </FormGrid>
          </FormSection>
        </>
      );
    case 'task':
      return (
        <>
          <FormSection title="Task">
            <FormGrid cols={2}>
              {who}
              <TextField formId={formId} name="title" fc={fc} span={2} placeholder="e.g. Blood pressure monitoring" />
              <SelectField formId={formId} name="category" fc={fc} />
              <ProviderSelectField formId={formId} name="assignedTo" fc={fc} label="Assigned To" />
              <DateField formId={formId} name="dueDate" fc={fc} />
              <SelectField formId={formId} name="priority" fc={fc} />
              <SelectField formId={formId} name="status" fc={fc} span={2} />
            </FormGrid>
          </FormSection>
          <FormSection title="Details">
            <FormGrid cols={2}>
              <TextField formId={formId} name="description" fc={fc} span={2} textarea rows={3} placeholder="What exactly needs to happen?" />
            </FormGrid>
          </FormSection>
        </>
      );
    case 'recall':
      return (
        <>
          <FormSection title="Recall">
            <FormGrid cols={2}>
              {who}
              <TextField formId={formId} name="reason" fc={fc} span={2} placeholder="e.g. Blood pressure review" />
              <SelectField formId={formId} name="type" fc={fc} />
              <DateField formId={formId} name="dueDate" fc={fc} />
              <SelectField formId={formId} name="priority" fc={fc} />
              <SelectField formId={formId} name="status" fc={fc} />
            </FormGrid>
          </FormSection>
          <FormSection title="Notes">
            <FormGrid cols={2}>
              <TextField formId={formId} name="notes" fc={fc} span={2} textarea rows={3} />
            </FormGrid>
          </FormSection>
        </>
      );
    case 'appointment':
      return (
        <>
          <FormSection title="When">
            <FormGrid cols={2}>
              {who}
              {/* A booked appointment is moved or cancelled with a reason — and the patient told — never just edited. */}
              <DateField formId={formId} name="date" fc={fc} disabled={lockPatient} help={lockPatient ? 'To move it, use Reschedule — the patient is told why.' : undefined} />
              <TimeField formId={formId} name="startTime" fc={fc} disabled={lockPatient} />
              <NumberField formId={formId} name="durationMinutes" fc={fc} min={5} max={240} suffix="min" />
              <SelectField formId={formId} name="type" fc={fc} />
            </FormGrid>
          </FormSection>
          <FormSection title="Who and where">
            <FormGrid cols={2}>
              <ProviderSelectField formId={formId} name="providerName" fc={fc} />
              <SelectField formId={formId} name="locationName" fc={fc} />
              <SelectField formId={formId} name="status" fc={fc} disabled={lockPatient} help={lockPatient ? 'To cancel it, use Cancel — the patient is told why.' : undefined} />
              <SelectField formId={formId} name="priority" fc={fc} />
              <CheckboxField formId={formId} name="isTelehealth" fc={fc} />
            </FormGrid>
          </FormSection>
          <FormSection title="Reason">
            <FormGrid cols={2}>
              <TextField formId={formId} name="reason" fc={fc} span={2} placeholder="e.g. Blood pressure follow-up" />
              <TextField formId={formId} name="notes" fc={fc} span={2} textarea rows={2} />
            </FormGrid>
          </FormSection>
        </>
      );
  }
}

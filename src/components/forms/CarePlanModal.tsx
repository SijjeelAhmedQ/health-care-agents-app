import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Form, Modal, Tabs, message, type FormInstance } from 'antd';
import { AlertTriangle, CheckCircle2, ClipboardList, MessageCircleQuestion, Mic, Plus, Save, X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store';
import { providerSelectors } from '@/store/slices/providerSlice';
import { patientSelectors } from '@/store/slices/patientSlice';
import { findPatientByRef, patientRef, patientRefName } from '@/services/records/patientRef';
import { batchConflicts, slotFromValues } from '@/services/appointments/conflicts';
import { recordSlices } from '@/store/slices/recordSlices';
import { voiceActions } from '@/store/slices/voiceSlice';
import { useSelectedPatient } from '@/hooks/usePatientData';
import { useRegisteredForm } from '@/hooks';
import { FieldRegistry } from '@/registry/fieldRegistry';
import { FormRegistry } from '@/registry/formRegistry';
import { CARE_PLAN_FORM_ID, CARE_PLAN_INSTANCE, CarePlanRegistry, type CarePlanController, type CarePlanItems } from '@/registry/carePlanRegistry';
import { RECORD_KINDS, type RecordKind } from '@/types/records';
import type { FieldValues } from '@/types/ai';
import { AppModal } from '@/components/common/AppModal';
import { InlineEmpty } from '@/components/common';
import { RecordIcon } from '@/components/common/recordIcons';
import { RecordFields, defaultValues, formValuesToRecord, toFormInitialValues } from './RecordForms';

type AnyValues = Record<string, unknown>;

interface Entry {
  id: string;
  kind: RecordKind;
  /** What the entry was opened with (registry format); the live values are in its form. */
  values: FieldValues;
}

const titles: Record<RecordKind, { one: string; many: string }> = {
  medication: { one: 'Medication', many: 'Medications' },
  diagnosis: { one: 'Diagnosis', many: 'Diagnoses' },
  task: { one: 'Task', many: 'Tasks' },
  recall: { one: 'Recall', many: 'Recalls' },
  appointment: { one: 'Appointment', many: 'Appointments' },
};

/** The field that names a record, used as its tab label (Metformin, Hypertension…). */
const primaryField: Record<RecordKind, string> = { medication: 'medicationName', diagnosis: 'description', task: 'title', recall: 'reason', appointment: 'reason' };

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * The Care Plan: every record dictated in one breath — medications, diagnoses,
 * tasks, recalls, appointments — in one dialog on the Summary page, one tab per
 * kind and one tab per record inside it, each pre-filled and saved together
 * after a single review. Mounted by the Summary page; opened by the assistant
 * (add_care_plan) or the "Care plan" button.
 */
export function CarePlanHost() {
  const dispatch = useAppDispatch();
  const patient = useSelectedPatient();
  const user = useAppSelector((s) => s.auth.user);
  const providers = useAppSelector(providerSelectors.selectAll);
  const patients = useAppSelector(patientSelectors.selectAll);
  const booked = useAppSelector(recordSlices.appointment.selectors.selectAll);
  const pending = useAppSelector((s) => s.voice.pendingConfirmation);
  const slot = useAppSelector((s) => s.voice.pendingSlot);
  const [open, setOpen] = useState(false);
  /** Opened in place of a record form on screen: no zoom-in, so the dialog does not seem to close and reopen. */
  const [instant, setInstant] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeKind, setActiveKind] = useState<RecordKind>('medication');
  const [activeEntry, setActiveEntry] = useState<Partial<Record<RecordKind, string>>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const forms = useRef(new Map<string, FormInstance<AnyValues>>());
  const nextId = useRef(0);

  const authorName = user?.fullName ?? 'Unknown';

  // A plan belongs to one patient: switching patient drops it.
  const patientId = patient?.id;
  useEffect(() => {
    setOpen(false);
    setEntries([]);
  }, [patientId]);
  // An appointment defaults to the signed-in provider, as the assistant is told.
  const ownProvider = providers.find((p) => p.id === user?.providerId)?.fullName;

  const makeEntries = (items: CarePlanItems): Entry[] =>
    RECORD_KINDS.flatMap((kind) => (items[kind] ?? []).map((values) => ({ id: `e${++nextId.current}`, kind, values })));

  const focus = useCallback((id: string, list: Entry[]) => {
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    setActiveKind(entry.kind);
    setActiveEntry((prev) => ({ ...prev, [entry.kind]: id }));
  }, []);

  const reset = useCallback(() => {
    setOpen(false);
    setEntries([]);
    setActiveEntry({});
    setLabels({});
  }, []);

  /** Drop what the assistant was waiting on for this dialog — it is gone. */
  const releaseVoice = useCallback(() => {
    if (pending?.formId === CARE_PLAN_FORM_ID) dispatch(voiceActions.setPendingConfirmation(null));
    if (slot && FormRegistry.get(slot.formId)?.instanceKey?.startsWith(CARE_PLAN_INSTANCE)) dispatch(voiceActions.setPendingSlot(null));
  }, [dispatch, pending, slot]);

  const severalPatients = new Set(entries.map((e) => e.values.patient).filter(Boolean)).size > 1;
  const entryLabel = (e: Entry) =>
    `${labels[e.id] || String(e.values[primaryField[e.kind]] ?? '') || `${titles[e.kind].one} ${entries.filter((x) => x.kind === e.kind).indexOf(e) + 1}`}${severalPatients && e.values.patient ? ` · ${patientRefName(e.values.patient)}` : ''}`;

  const validate = async (): Promise<{ errors: string[]; firstBad?: string }> => {
    if (!entries.length) return { errors: ['The care plan is empty.'] };
    const errors: string[] = [];
    let firstBad: string | undefined;
    for (const e of entries) {
      const form = forms.current.get(e.id);
      if (!form) continue;
      try {
        await form.validateFields();
      } catch (err) {
        const fields = (err as { errorFields?: Array<{ errors: string[] }> }).errorFields ?? [];
        if (!fields.length) continue;
        firstBad ??= e.id;
        errors.push(...fields.map((f) => `${titles[e.kind].one} "${entryLabel(e)}": ${f.errors[0]}`));
      }
    }
    return { errors, firstBad };
  };

  /** Who each record is for: the patient its form names (the selected patient unless changed). */
  const entryPatient = (values: AnyValues) => findPatientByRef(patients, values.patient) ?? patient;

  const submit = async (): Promise<number> => {
    if (!patient) throw new Error('No patient is selected — select a patient before saving.');
    const { errors, firstBad } = await validate();
    if (errors.length) {
      if (firstBad) focus(firstBad, entries);
      throw new Error(errors.slice(0, 3).join('; '));
    }
    // No double booking — checked for the whole plan before any of it is saved.
    const clashes = batchConflicts(
      booked,
      entries
        .filter((e) => e.kind === 'appointment')
        .map((e) => {
          const values = forms.current.get(e.id)?.getFieldsValue(true) as AnyValues;
          const who = entryPatient(values);
          return slotFromValues(values, { patientId: who?.id, patientName: who?.fullName, providerId: providers.find((p) => p.fullName === values.providerName)?.id });
        }),
    );
    if (clashes.length) throw new Error(clashes[0]);
    setSaving(true);
    let saved = 0;
    const savedFor = new Set<string>();
    try {
      for (const e of entries) {
        const values = forms.current.get(e.id)?.getFieldsValue(true) as AnyValues;
        const provider = providers.find((p) => p.fullName === values.providerName);
        const target = entryPatient(values)!;
        savedFor.add(target.fullName);
        const payload = formValuesToRecord(e.kind, values, { patientId: target.id, patientName: target.fullName, patientMrn: target.mrn, authorName, providerId: provider?.id });
        const slice = recordSlices[e.kind] as (typeof recordSlices)['medication'];
        await dispatch(slice.create(payload as never)).unwrap();
        saved++;
      }
    } catch (err) {
      // What was saved stays saved; only the rest is left in the dialog.
      const savedIds = new Set(entries.slice(0, saved).map((e) => e.id));
      setEntries((prev) => prev.filter((e) => !savedIds.has(e.id)));
      throw err;
    } finally {
      setSaving(false);
    }
    message.success(`${saved} record${saved === 1 ? '' : 's'} saved for ${savedFor.size > 1 ? `${savedFor.size} patients` : [...savedFor][0]}`);
    releaseVoice();
    reset();
    FormRegistry.settled(CARE_PLAN_FORM_ID, true);
    return saved;
  };

  const summarize = () =>
    entries.map((e) => {
      const values = FormRegistry.get(e.kind, CARE_PLAN_INSTANCE + e.id)?.getValues() ?? e.values;
      const def = FieldRegistry.getForm(e.kind)!;
      const key = def.fields.filter((f) => (f.required || ['patient', 'duration', 'route'].includes(f.name)) && f.name !== primaryField[e.kind] && hasValue(values[f.name]));
      return {
        label: `${titles[e.kind].one}: ${String(values[primaryField[e.kind]] ?? entryLabel(e))}`,
        value: key.map((f) => `${f.label}: ${String(values[f.name])}`).join(', ') || '—',
      };
    });

  // The assistant's handle on the dialog; always reads the latest state.
  const live = useRef({ open, entries, submit, summarize, validate, focus, reset, releaseVoice });
  live.current = { open, entries, submit, summarize, validate, focus, reset, releaseVoice };
  useEffect(() => {
    const controller: CarePlanController = {
      isOpen: () => live.current.open,
      open: (items, options) => {
        const list = makeEntries(items);
        setInstant(!!options?.instant);
        setEntries(list);
        setLabels({});
        setActiveEntry(Object.fromEntries(RECORD_KINDS.map((k) => [k, list.find((e) => e.kind === k)?.id])));
        setActiveKind(list[0]?.kind ?? 'medication');
        setOpen(true);
      },
      add: (items) => {
        const added = makeEntries(items);
        if (!added.length) return;
        setEntries((prev) => [...prev, ...added]);
        setActiveKind(added[0].kind);
        setActiveEntry((prev) => ({ ...prev, ...Object.fromEntries(added.map((e) => [e.kind, e.id])), [added[0].kind]: added[0].id }));
        setOpen(true);
      },
      entries: () =>
        live.current.entries
          .filter((e) => forms.current.has(e.id))
          .map((e) => ({ id: e.id, kind: e.kind, values: FormRegistry.get(e.kind, CARE_PLAN_INSTANCE + e.id)?.getValues() ?? {} })),
      focus: (id) => live.current.focus(id, live.current.entries),
      close: () => live.current.reset(),
      validate: async () => (await live.current.validate()).errors,
      submit: () => live.current.submit(),
      summarize: () => live.current.summarize(),
    };
    return CarePlanRegistry.register(controller);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addBlank = (kind: RecordKind) => {
    const [entry] = makeEntries({ [kind]: [{}] });
    setEntries((prev) => [...prev, entry]);
    setActiveEntry((prev) => ({ ...prev, [kind]: entry.id }));
    setActiveKind(kind);
  };

  const remove = (id: string) => {
    const rest = entries.filter((e) => e.id !== id);
    const gone = entries.find((e) => e.id === id)!;
    setEntries(rest);
    if (activeEntry[gone.kind] === id) setActiveEntry((prev) => ({ ...prev, [gone.kind]: rest.find((e) => e.kind === gone.kind)?.id }));
  };

  const requestClose = () => {
    const done = () => {
      releaseVoice();
      reset();
      FormRegistry.settled(CARE_PLAN_FORM_ID, false);
    };
    if (saving) return;
    if (!entries.length) return done();
    Modal.confirm({
      title: 'Discard this care plan?',
      icon: <AlertTriangle size={20} color="#d97706" style={{ marginRight: 12, flexShrink: 0 }} />,
      content: 'Nothing has been saved yet. Closing now discards every record in it.',
      okText: 'Discard',
      okButtonProps: { danger: true },
      cancelText: 'Keep editing',
      centered: true,
      onOk: done,
    });
  };

  const saveAll = async () => {
    try {
      await submit();
    } catch (err) {
      message.error((err as Error).message || 'The care plan could not be saved.');
    }
  };

  const registerForm = useCallback((id: string, form: FormInstance<AnyValues> | null) => {
    if (form) forms.current.set(id, form);
    else forms.current.delete(id);
  }, []);
  const setLabel = useCallback((id: string, label: string) => setLabels((prev) => (prev[id] === label ? prev : { ...prev, [id]: label })), []);

  if (!open) return null;

  const awaitingSave = pending?.formId === CARE_PLAN_FORM_ID;
  const planSlot = slot && FormRegistry.get(slot.formId)?.instanceKey?.startsWith(CARE_PLAN_INSTANCE) ? slot : null;

  // Only the kinds the plan holds get a tab (no Diagnosis tab when no diagnosis was said).
  const shownKinds = RECORD_KINDS.filter((kind) => entries.some((e) => e.kind === kind));
  const missingKinds = RECORD_KINDS.filter((kind) => !shownKinds.includes(kind));
  const currentKind = shownKinds.includes(activeKind) ? activeKind : shownKinds[0];

  const kindTabs = shownKinds.map((kind) => {
    const ofKind = entries.filter((e) => e.kind === kind);
    const current = activeEntry[kind] ?? ofKind[0]?.id;
    return {
      key: kind,
      forceRender: true,
      label: (
        <span className="summary-tab-label">
          <RecordIcon kind={kind} /> {titles[kind].one}
          <span className="summary-tab-count">{ofKind.length}</span>
        </span>
      ),
      children: (
        <Tabs
          type="editable-card"
          size="small"
          className="care-plan-entries"
          activeKey={current}
          onChange={(id) => setActiveEntry((prev) => ({ ...prev, [kind]: id }))}
          onEdit={(key, action) => (action === 'add' ? addBlank(kind) : remove(String(key)))}
          addIcon={<Plus size={14} aria-label={`Add ${titles[kind].one.toLowerCase()}`} />}
          items={ofKind.map((e) => ({
            key: e.id,
            forceRender: true,
            label: entryLabel(e),
            children: (
              <PlanEntryForm
                entry={e}
                active={open && currentKind === kind && current === e.id}
                initial={{ ...defaultValues(kind, authorName), patient: patient ? patientRef(patient) : undefined, ...(kind === 'appointment' && ownProvider ? { providerName: ownProvider } : {}) }}
                onRegister={registerForm}
                onLabel={setLabel}
                onFocus={() => focus(e.id, live.current.entries)}
                onClosePlan={() => live.current.reset()}
                onSubmitPlan={async () => void (await live.current.submit())}
              />
            ),
          }))}
        />
      ),
    };
  });

  const addKindMenu = missingKinds.length ? (
    <Dropdown menu={{ items: missingKinds.map((kind) => ({ key: kind, icon: <RecordIcon kind={kind} />, label: titles[kind].one })), onClick: ({ key }) => addBlank(key as RecordKind) }} trigger={['click']}>
      <Button size="small" icon={<Plus size={14} />}>Add</Button>
    </Dropdown>
  ) : null;

  const planPatients = [...new Set(entries.map((e) => patientRefName(e.values.patient) || patient?.fullName || ''))].filter(Boolean);

  return (
    <AppModal
      open
      size="xl"
      icon={<ClipboardList size={18} />}
      title={`Care plan${entries.length ? ` (${entries.length})` : ''}`}
      description={patient ? `Every record below is saved for ${planPatients.length > 1 ? `its patient (${planPatients.join(', ')})` : patient.fullName} once you confirm — nothing is saved yet.` : 'Select a patient first.'}
      onClose={requestClose}
      maskClosable={false}
      {...(instant ? { transitionName: '', maskTransitionName: '' } : {})}
      className="care-plan-modal"
      footerHint={<span className="form-required-hint"><span className="mark">*</span> Required field</span>}
      footer={
        <>
          <Button icon={<X size={14} />} onClick={requestClose} disabled={saving}>Cancel</Button>
          <Button type="primary" icon={<Save size={14} />} loading={saving} disabled={!entries.length} onClick={() => void saveAll()}>
            Save all{entries.length ? ` (${entries.length})` : ''}
          </Button>
        </>
      }
    >
      {(awaitingSave || planSlot) && (
        <div className="voice-banner" role="alert" aria-live="polite">
          <div className="voice-banner-icon"><Mic size={18} /></div>
          <div className="voice-banner-body">
            <div className="voice-banner-head"><span className="voice-banner-title">Filled by voice</span></div>
            <div className="voice-banner-text">Please review every tab before saving — nothing has been saved yet.</div>
            {planSlot ? (
              <div className="voice-banner-status is-question">
                <MessageCircleQuestion size={14} />
                <span><strong>{planSlot.question}</strong> — the assistant is waiting for the {planSlot.label.toLowerCase()}.</span>
              </div>
            ) : (
              <div className="voice-banner-status is-ready">
                <CheckCircle2 size={14} />
                <span>Say <strong>“save it”</strong> or click <strong>Save all</strong> to confirm.</span>
              </div>
            )}
          </div>
        </div>
      )}
      {shownKinds.length ? (
        <Tabs className="care-plan-kinds" activeKey={currentKind} onChange={(k) => setActiveKind(k as RecordKind)} items={kindTabs} tabBarExtraContent={addKindMenu} />
      ) : (
        <div className="care-plan-empty">
          <InlineEmpty>This care plan is empty.</InlineEmpty>
          {addKindMenu}
        </div>
      )}
    </AppModal>
  );
}

interface EntryProps {
  entry: Entry;
  /** The record tab on screen — the one "the open form" means to the assistant. */
  active: boolean;
  initial: AnyValues;
  onRegister: (id: string, form: FormInstance<AnyValues> | null) => void;
  onLabel: (id: string, label: string) => void;
  onFocus: () => void;
  onClosePlan: () => void;
  onSubmitPlan: () => Promise<void>;
}

/** One record of the care plan: the kind's normal fields, in a form of its own. */
function PlanEntryForm({ entry, active, initial, onRegister, onLabel, onFocus, onClosePlan, onSubmitPlan }: EntryProps) {
  const [form] = Form.useForm<AnyValues>();
  // Seeded once: afterwards the form holds the truth (typed edits, voice corrections).
  const initialValues = useMemo(() => ({ ...initial, ...toFormInitialValues(entry.kind, entry.values) }), [entry.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onRegister(entry.id, form);
    return () => onRegister(entry.id, null);
  }, [entry.id, form, onRegister]);

  const name = Form.useWatch(primaryField[entry.kind], form) as string | undefined;
  useEffect(() => {
    if (name) onLabel(entry.id, String(name));
  }, [entry.id, name, onLabel]);

  const { fieldClass } = useRegisteredForm<AnyValues>({
    formId: entry.kind,
    form,
    isOpen: active,
    open: onFocus,
    close: onClosePlan,
    onSubmit: onSubmitPlan,
    instanceKey: CARE_PLAN_INSTANCE + entry.id,
  });

  return (
    <Form<AnyValues> form={form} name={`care-plan-${entry.id}`} layout="vertical" initialValues={initialValues} requiredMark>
      <RecordFields kind={entry.kind} fc={fieldClass} />
    </Form>
  );
}

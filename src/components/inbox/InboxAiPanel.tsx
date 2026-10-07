import { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Input, Select, Tooltip, message } from 'antd';
import { Check, ChevronDown, FileText, ListChecks, Mail, Pill, Sparkles, Stethoscope, Repeat, UserRound, X } from 'lucide-react';
import dayjs from 'dayjs';
import { useAppDispatch } from '@/store';
import { recordSlices } from '@/store/slices/recordSlices';
import { usePatientOverview } from '@/hooks/usePatientData';
import { buildPatientNarrative } from '@/services/records/patientNarrative';
import { FieldRegistry } from '@/registry/fieldRegistry';
import {
  buildResultSummary,
  buildSuggestions,
  type InboxSuggestion,
  type SuggestionField,
  type SuggestionKind,
} from '@/services/inbox/inboxInsights';
import { formValuesToRecord, RecordFormModal, type RecordKind } from '@/components/forms/RecordForms';
import type { InboxItem } from '@/services/inbox/inboxModel';
import type { Patient } from '@/types/domain';

/** Each record type gets its own mark, so the stack is scannable at a glance. */
const kindIcon: Record<SuggestionKind, React.ReactNode> = {
  medication: <Pill size={14} />,
  diagnosis: <Stethoscope size={14} />,
  recall: <Repeat size={14} />,
  task: <ListChecks size={14} />,
  email: <Mail size={14} />,
};

interface Props {
  item?: InboxItem;
  patient?: Patient;
  /** Only the patient being worked on can have records written to them. */

  unfiledCount: number;
  /** Make this item's patient the one being worked on. */

}

/** Card values, keyed by suggestion id then field key. */
type Values = Record<string, Record<string, string>>;

const initialValues = (suggestions: InboxSuggestion[]): Values =>
  Object.fromEntries(suggestions.map((s) => [s.id, Object.fromEntries(s.fields.map((f) => [f.key, f.value]))]));

/**
 * The assistant column: what this patient looks like, what this item says, and
 * the four records that can be raised from it.
 *
 * Each card can be completed three ways — type in it and press Add, open Quick
 * edit for the rest of the fields, or open the full form. All three end in the
 * same record; nothing is written until one of them is confirmed.
 */
export function InboxAiPanel({ item, patient, unfiledCount }: Props) {
  const dispatch = useAppDispatch();
  // The item's own patient — records are added for them, whoever is selected elsewhere.
  const overview = usePatientOverview(patient?.id ?? null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [fullForm, setFullForm] = useState<{ kind: RecordKind; prefill: Record<string, string> } | null>(null);

  const suggestions = useMemo(() => (item ? buildSuggestions(item) : []), [item]);

  // A new item is a fresh set of cards.
  useEffect(() => {
    setValues(initialValues(suggestions));
    setExpanded(null);
    setDismissed(new Set());
  }, [suggestions]);

  const narrative = useMemo(
    () =>
      patient
        ? buildPatientNarrative({
            patient,
            medications: overview.medications,
            diagnoses: overview.diagnoses,
            tasks: overview.tasks,
            recalls: overview.recalls,
            appointments: overview.appointments,
          })
        : null,
    [patient, overview],
  );

  if (!item) {
    return (
      <aside className="ibx-ai" aria-label="Assistant">
        <p className="ibx-ai-idle">Open an item to see its summary and the records you can raise from it.</p>
      </aside>
    );
  }

  const valuesFor = (s: InboxSuggestion) => values[s.id] ?? Object.fromEntries(s.fields.map((f) => [f.key, f.value]));
  const setField = (s: InboxSuggestion, key: string, value: string) =>
    setValues((prev) => ({ ...prev, [s.id]: { ...valuesFor(s), [key]: value } }));

  /** Required fields the card still needs before it can be added directly. */
  const missingFor = (s: InboxSuggestion): string[] => {
    if (s.kind === 'email') return [];
    const current = valuesFor(s);
    const filled = Object.fromEntries(Object.entries(current).filter(([, v]) => v !== ''));
    // The card is always for the Inbox record's own patient, so it has no Patient field to fill.
    return FieldRegistry.missingRequired(s.kind, filled)
      .filter((f) => f.optionsFrom !== 'patients')
      .map((f) => f.label);
  };

  const add = async (s: InboxSuggestion) => {
    const current = valuesFor(s);
    if (s.kind === 'email') {
      void navigator.clipboard?.writeText(current.message ?? '');
      message.success('Draft copied — nothing was sent');
      return;
    }
    if (!patient) return;
    const missing = missingFor(s);
    if (missing.length) {
      message.warning(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} needed first`);
      setExpanded(s.id);
      return;
    }
    setSaving(s.id);
    try {
      const payload = formValuesToRecord(s.kind as RecordKind, current, {
        patientId: patient.id,
        patientName: patient.fullName,
        patientMrn: patient.mrn,
        authorName: patient.primaryProviderName,
      });
      // Every record slice has the same shape; one concrete type keeps the dispatch monomorphic.
      const slice = recordSlices[s.kind as RecordKind] as (typeof recordSlices)['medication'];
      await dispatch(slice.create(payload as never)).unwrap();
      message.success(`${s.label.replace('ADD ', '').toLowerCase()} added for ${patient.fullName}`);
      setDismissed((prev) => new Set(prev).add(s.id));
      setExpanded(null);
    } finally {
      setSaving(null);
    }
  };

  const openFullForm = (s: InboxSuggestion) => {
    // Whatever has been typed into the card carries into the form.
    setFullForm({ kind: s.kind as RecordKind, prefill: valuesFor(s) });
  };

  const renderField = (s: InboxSuggestion, field: SuggestionField) => {
    const value = valuesFor(s)[field.key] ?? '';
    const id = `${s.id}:${field.key}`;
    const control =
      field.type === 'textarea' ? (
        <Input.TextArea id={id} autoSize={{ minRows: 2, maxRows: 8 }} value={value} onChange={(e) => setField(s, field.key, e.target.value)} />
      ) : field.type === 'select' ? (
        <Select
          id={id}
          className="ibx-q-select"
          value={value || undefined}
          placeholder={`Select ${field.label.toLowerCase()}`}
          onChange={(v) => setField(s, field.key, v)}
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      ) : field.type === 'date' ? (
        <DatePicker
          id={id}
          className="ibx-q-select"
          format="DD/MM/YYYY"
          /* The card holds text; the picker only ever sees a real date. */
          value={value && dayjs(value).isValid() ? dayjs(value) : undefined}
          onChange={(d) => setField(s, field.key, d ? d.format('YYYY-MM-DD') : '')}
        />
      ) : (
        <Input id={id} value={value} placeholder={field.placeholder} onChange={(e) => setField(s, field.key, e.target.value)} />
      );

    return (
      <div key={field.key} className="ibx-field">
        <label className="ibx-q-label" htmlFor={id}>
          {field.label}
          {field.required && <span className="ibx-req"> *</span>}
        </label>
        {control}
      </div>
    );
  };

  const visible = suggestions.filter((s) => !dismissed.has(s.id));

  return (
    <aside className="ibx-ai" aria-label="Assistant">
      <section className="ibx-ai-card is-result">
        <h3>
          <Sparkles size={13} aria-hidden /> Result summary
        </h3>
        <p>{buildResultSummary(item)}</p>
      </section>

      {narrative && (
        <section className="ibx-ai-card is-patient">
          <h3>
            <UserRound size={13} aria-hidden /> Patient summary <span>· {dayjs().format('D MMM YYYY')}</span>
          </h3>
          <p>{narrative.sections.slice(1, 4).map((s) => s.body).join(' ')}</p>
        </section>
      )}

      <div className="ibx-ai-actions-head">
        <h3>Add to record</h3>
        <span className="ibx-ai-count" aria-label={`${visible.length} suggestions`}>
          {visible.length}
        </span>
      </div>
      {unfiledCount > 0 && <p className="ibx-ai-sub">Nothing is saved until you press Add. {unfiledCount} unfiled in this list.</p>}

      {!patient && (
        <div className="ibx-ai-gate">
          <p>This item is not linked to a patient record, so nothing can be added from it.</p>
        </div>
      )}

      <div className="ibx-cards">
        {visible.map((s) => {
          const isOpen = expanded === s.id;
          const cardValues = valuesFor(s);
          const primary = s.fields.find((f) => f.primary);
          const secondary = s.fields.find((f) => f.secondary);
          const rest = s.fields.filter((f) => !f.primary && !f.secondary);
          const missing = missingFor(s);
          const blocked = s.kind !== 'email' && !patient;
          const ready = missing.length === 0;

          // The collapsed row says what would be added, or what is still needed.
          const dateField = s.fields.find((f) => f.type === 'date');
          const dateValue = dateField ? cardValues[dateField.key] : '';
          const hint = ready
            ? [primary ? cardValues[primary.key] : '', dateValue ? dayjs(dateValue).format('DD/MM/YYYY') : '']
                .filter(Boolean)
                .join(' · ')
            : `Needs ${missing.join(', ').toLowerCase()}`;

          return (
            <section key={s.id} className={`ibx-card is-${s.kind} ${isOpen ? 'is-open' : ''} ${ready ? 'is-ready' : 'is-blank'}`}>
              <div className="ibx-card-row">
                <button
                  type="button"
                  className="ibx-card-head"
                  onClick={() => setExpanded(isOpen ? null : s.id)}
                  aria-expanded={isOpen}
                  aria-controls={`${s.id}:body`}
                >
                  <span className="ibx-card-icon" aria-hidden>{kindIcon[s.kind]}</span>
                  <span className="ibx-card-text">
                    <span className="ibx-card-label">{s.kind === 'email' ? 'Draft message' : s.label.replace('ADD ', '').toLowerCase()}</span>
                    <span className="ibx-card-hint">{hint || 'Enter details'}</span>
                  </span>
                  <ChevronDown size={14} className="ibx-card-chev" aria-hidden />
                </button>

                <Tooltip
                  title={
                    blocked
                      ? `Select ${item.patientName} first`
                      : !ready
                        ? `${missing.join(' and ')} still needed — opens the fields`
                        : s.kind === 'email'
                          ? 'Copy this draft'
                          : `Add it to ${item.patientName}'s record now`
                  }
                >
                  <Button
                    className="ibx-card-add"
                    size="small"
                    type="primary"
                    icon={<Check size={12} />}
                    loading={saving === s.id}
                    disabled={blocked}
                    /* The visible label is short; the accessible name says which record it adds. */
                    aria-label={s.kind === 'email' ? 'Copy draft message' : s.actionLabel}
                    onClick={() => (ready ? void add(s) : setExpanded(s.id))}
                  >
                    {s.kind === 'email' ? 'Copy' : 'Add'}
                  </Button>
                </Tooltip>
              </div>

              {isOpen && (
                <div className="ibx-card-body" id={`${s.id}:body`}>
                  {primary && renderField(s, primary)}
                  {rest.map((f) => renderField(s, f))}
                  {secondary && renderField(s, secondary)}

                  <p className="ibx-sugg-basis">{s.basis}</p>

                  <div className="ibx-card-actions">
                    <Button size="small" danger icon={<X size={12} />} onClick={() => setDismissed((p) => new Set(p).add(s.id))}>
                      Dismiss
                    </Button>
                    <span className="ibx-card-actions-spacer" />
                    {s.kind !== 'email' && (
                      <Tooltip title={blocked ? `Select ${item.patientName} first` : 'Open the full form with what you have typed'}>
                        <Button size="small" icon={<FileText size={12} />} disabled={blocked} onClick={() => openFullForm(s)}>
                          Full form
                        </Button>
                      </Tooltip>
                    )}
                    <Button
                      size="small"
                      type="primary"
                      icon={<Check size={12} />}
                      loading={saving === s.id}
                      disabled={blocked}
                      onClick={() => void add(s)}
                    >
                      {s.actionLabel}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {!visible.length && <p className="ibx-ai-idle">All cards dismissed for this item.</p>}

      {fullForm && (
        <RecordFormModal
          kind={fullForm.kind}
          open
          onOpen={() => undefined}
          onClose={() => setFullForm(null)}
          prefill={fullForm.prefill}
          onSaved={() => {
            message.success(`Saved for ${item.patientName}`);
            setFullForm(null);
          }}
        />
      )}
    </aside>
  );
}

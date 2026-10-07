import { useState, type ReactNode } from 'react';
import { Button, Card, Form, Modal, Space, message, type FormInstance } from 'antd';
import { AlertTriangle, CheckCircle2, MessageCircleQuestion, Mic, Save, X } from 'lucide-react';
import { useRegisteredForm, type EntryStore } from '@/hooks';
import { useAppSelector } from '@/store';
import { FieldRegistry } from '@/registry/fieldRegistry';
import { FormRegistry } from '@/registry/formRegistry';
import { AppModal, type ModalSize } from '@/components/common/AppModal';

export interface FormHelpers<T> {
  form: FormInstance<T>;
  /** className for a Form.Item that was just filled by voice */
  fc: (name: string) => string | undefined;
}

interface BaseProps<T extends object> {
  formId: string;
  title: string;
  onSubmit: (values: T) => Promise<void> | void;
  initialValues?: Partial<T>;
  children: (helpers: FormHelpers<T>) => ReactNode;
  submitLabel?: string;
  instanceKey?: string;
  extraActions?: ReactNode;
}

interface ModalFormProps<T extends object> extends BaseProps<T> {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Preferred over `width` — sm/md/lg/xl keep dialog widths consistent. */
  size?: ModalSize;
  width?: number;
  description?: string;
  icon?: ReactNode;
  /** Supply the form instance when the dialog needs it outside (e.g. to switch between entry tabs). */
  form?: FormInstance<T>;
  /** Multi-entry forms: every entry is saved, in order, with one confirmation. */
  entries?: EntryStore<T>;
  /** Rendered above the fields, inside the form (e.g. the entry tabs). */
  header?: ReactNode;
  /** Checks across every entry before anything is saved (e.g. no double booking); one message per problem. */
  checkAll?: (all: Record<string, unknown>[]) => string[];
}

/**
 * Shown whenever the assistant has written into this form: lists the voice-filled fields and what
 * happens next (a pending question, or "say save it"). Stays until the form is saved or closed.
 */
function VoiceBanner({ formId, fields }: { formId: string; fields: string[] }) {
  const pending = useAppSelector((s) => s.voice.pendingConfirmation);
  const slot = useAppSelector((s) => s.voice.pendingSlot);
  const def = FieldRegistry.getForm(formId);
  const awaitingSave = pending?.formId === formId;
  const question = slot?.formId === formId ? slot : null;
  if (!fields.length && !awaitingSave && !question) return null;

  const labels = fields.map((name) => def?.fields.find((f) => f.name === name)?.label ?? name);
  const submitLabel = def?.submitLabel ?? 'Save';

  return (
    <div className="voice-banner" role="alert" aria-live="polite">
      <div className="voice-banner-icon"><Mic size={18} /></div>
      <div className="voice-banner-body">
        <div className="voice-banner-head">
          <span className="voice-banner-title">Filled by voice</span>
          {labels.length > 0 && <span className="voice-banner-count">{labels.length} field{labels.length === 1 ? '' : 's'}</span>}
        </div>
        <div className="voice-banner-text">
          Please review {labels.length ? 'these values' : 'the form'} before saving — nothing has been saved yet.
        </div>
        {labels.length > 0 && (
          <div className="voice-banner-chips">
            {labels.map((l) => <span key={l} className="voice-banner-chip">{l}</span>)}
          </div>
        )}
        {question ? (
          <div className="voice-banner-status is-question">
            <MessageCircleQuestion size={14} />
            <span><strong>{question.question}</strong> — the assistant is waiting for the {question.label.toLowerCase()}.</span>
          </div>
        ) : awaitingSave ? (
          <div className="voice-banner-status is-ready">
            <CheckCircle2 size={14} />
            <span>Say <strong>“save it”</strong> or click <strong>{submitLabel}</strong> to confirm.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A modal-hosted form that is registered for voice control.
 *
 * Replaces the former slide-out shell: same props and the same FormRegistry contract
 * (open / close / isOpen / submit), rendered as a centred dialog that goes full-screen on phones.
 */
export function RegisteredFormModal<T extends object>({ formId, title, description, icon, open, onOpen, onClose, onSubmit, initialValues, children, submitLabel, size = 'lg', width, instanceKey, extraActions, form: externalForm, entries, header, checkAll }: ModalFormProps<T>) {
  const [form] = Form.useForm<T>(externalForm);
  const [saving, setSaving] = useState(false);
  const def = FieldRegistry.getForm(formId);

  const submit = async (values: T) => {
    setSaving(true);
    try {
      // With entry tabs the active tab is validated by antd; the others were snapshotted when the user (or voice) left them.
      const all = entries ? entries.items.map((snap, i) => (i === entries.active ? values : ({ ...initialValues, ...snap } as T))) : [values];
      // Every tab is checked before anything is saved: a record still missing a required value (its patient,
      // a dose…) is shown, and none of them is saved — never half the set.
      const incomplete = entries ? all.findIndex((v) => FieldRegistry.missingRequired(formId, v as Record<string, unknown>).length > 0) : -1;
      if (entries && incomplete >= 0) {
        const missing = FieldRegistry.missingRequired(formId, all[incomplete] as Record<string, unknown>).map((f) => f.label.toLowerCase());
        entries.setActive(incomplete);
        throw new Error(`Record ${incomplete + 1} still needs its ${missing.join(', ')} — nothing was saved.`);
      }
      const problems = checkAll?.(all as Record<string, unknown>[]) ?? [];
      if (problems.length) throw new Error(`${problems[0]} Nothing was saved.`);
      for (const v of all) await onSubmit(v);
      message.success(all.length > 1 ? `${all.length} ${title.replace(/^add\s+/i, '').toLowerCase()}s saved` : `${title} saved`);
      form.resetFields();
      onClose();
      FormRegistry.settled(formId, true);
    } catch (e) {
      // Said on screen, and passed on: the assistant's "yes" must not report a save that did not happen.
      message.error((e as Error).message);
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const { fieldClass, voiceFilledFields } = useRegisteredForm<T>({ formId, form, isOpen: open, open: onOpen, close: () => { form.resetFields(); onClose(); }, onSubmit: submit, instanceKey, entries, checkAll });

  /** Closing with data in the form asks first — a mis-click should never lose a dictated medication. */
  const requestClose = () => {
    if (!saving && form.isFieldsTouched()) {
      Modal.confirm({
        title: 'Discard this entry?',
        icon: <AlertTriangle size={20} color="#d97706" style={{ marginRight: 12, flexShrink: 0 }} />,
        content: 'Nothing has been saved yet. Closing now discards what you entered.',
        okText: 'Discard',
        okButtonProps: { danger: true },
        cancelText: 'Keep editing',
        centered: true,
        onOk: () => { form.resetFields(); onClose(); FormRegistry.settled(formId, false); },
      });
      return;
    }
    form.resetFields();
    onClose();
    FormRegistry.settled(formId, false);
  };

  const action = submitLabel ?? def?.submitLabel ?? 'Save';

  return (
    <AppModal
      open={open}
      title={title}
      description={description}
      icon={icon}
      size={size}
      width={width}
      onClose={requestClose}
      maskClosable={false}
      footerHint={<span className="form-required-hint"><span className="mark">*</span> Required field</span>}
      footer={
        <>
          {extraActions}
          <Button icon={<X size={14} />} onClick={requestClose} disabled={saving}>Cancel</Button>
          <Button type="primary" icon={<Save size={14} />} loading={saving} onClick={() => form.submit()}>
            {action}
          </Button>
        </>
      }
    >
      <VoiceBanner formId={formId} fields={voiceFilledFields} />
      {header && <div className="app-modal-entries">{header}</div>}
      <Form<T> form={form} layout="vertical" initialValues={initialValues as never} onFinish={(v) => void submit(v).catch(() => undefined)} requiredMark scrollToFirstError>
        {children({ form, fc: fieldClass })}
      </Form>
    </AppModal>
  );
}

interface CardProps<T extends object> extends BaseProps<T> {
  onCancel?: () => void;
  loading?: boolean;
  successMessage?: string;
  /** Shown to the left of the sticky action bar. */
  hint?: ReactNode;
}

/** A page-level form (e.g. Patient Registration) registered for voice control. */
export function RegisteredFormCard<T extends object>({ formId, title, onSubmit, onCancel, initialValues, children, submitLabel, instanceKey, extraActions, loading, successMessage, hint }: CardProps<T>) {
  const [form] = Form.useForm<T>();
  const [saving, setSaving] = useState(false);
  const def = FieldRegistry.getForm(formId);

  const submit = async (values: T) => {
    setSaving(true);
    try {
      await onSubmit(values);
      clearVoiceFilled();
      message.success(successMessage ?? `${title} saved`);
      FormRegistry.settled(formId, true);
    } finally {
      setSaving(false);
    }
  };

  const { fieldClass, voiceFilledFields, clearVoiceFilled } = useRegisteredForm<T>({ formId, form, isOpen: true, open: () => undefined, close: () => form.resetFields(), onSubmit: submit, instanceKey });

  const reset = () => {
    if (!form.isFieldsTouched()) { onCancel?.(); FormRegistry.settled(formId, false); return; }
    Modal.confirm({
      title: 'Clear this form?',
      icon: <AlertTriangle size={20} color="#d97706" style={{ marginRight: 12, flexShrink: 0 }} />,
      content: 'Everything you have entered will be removed.',
      okText: 'Clear form',
      okButtonProps: { danger: true },
      cancelText: 'Keep editing',
      centered: true,
      onOk: () => { form.resetFields(); clearVoiceFilled(); onCancel?.(); FormRegistry.settled(formId, false); },
    });
  };

  return (
    <Card loading={loading}>
      <VoiceBanner formId={formId} fields={voiceFilledFields} />
      <Form<T> form={form} layout="vertical" initialValues={initialValues as never} onFinish={(v) => void submit(v)} requiredMark scrollToFirstError>
        {children({ form, fc: fieldClass })}
        <div className="sticky-actions">
          <span className="sticky-actions-hint">{hint ?? <span className="form-required-hint"><span className="mark">*</span> Required field</span>}</span>
          {extraActions}
          <Space>
            <Button onClick={reset} disabled={saving}>Clear</Button>
            <Button type="primary" htmlType="submit" icon={<Save size={14} />} loading={saving}>
              {submitLabel ?? def?.submitLabel ?? 'Save'}
            </Button>
          </Space>
        </div>
      </Form>
    </Card>
  );
}

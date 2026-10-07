import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Tooltip, message } from 'antd';
import {
  Activity, Archive, ArchiveRestore, ArrowRight, CalendarPlus, Check, ChevronDown, ChevronLeft, ChevronUp, CircleAlert, CircleCheck,
  Ellipsis, EyeOff, Inbox, ListChecks, Lock, Mail, Phone, Repeat, TriangleAlert, UserRound, UserRoundCheck,
} from 'lucide-react';
import dayjs from 'dayjs';
import { useAppDispatch, useAppSelector } from '@/store';
import { setCurrentPatient } from '@/store/slices/patientSlice';
import { usePatientOverview } from '@/hooks/usePatientData';
import { buildPatientNarrative } from '@/services/records/patientNarrative';
import { priorityOf } from '@/services/inbox/inboxInsights';
import { categoryMeta, type InboxItem } from '@/services/inbox/inboxModel';
import type { Patient } from '@/types/domain';
import { AppModal } from '@/components/common/AppModal';
import { RecordFormModal, type RecordKind } from '@/components/forms/RecordForms';
import { patientRef } from '@/services/records/patientRef';
import { hashColor, initials } from '@/utils/format';
import { InboxAiPanel } from './InboxAiPanel';
import { InboxComments } from './InboxComments';
import { CategoryIcon, PriorityMark, StatusLabel, fullWhen, relativeWhen } from './inboxUi';

export type ItemFlags = { portal: boolean; confidential: boolean; inactive: boolean };

interface Props {
  item: InboxItem;
  patient?: Patient;
  filed: boolean;
  onToggleFiled: (item: InboxItem) => void;
  /** File this item and open the next one in the list. */
  onFileAndNext: (item: InboxItem) => void;
  /** Position within the filtered queue. */
  position: { index: number; total: number };
  onPrevious: () => void;
  onNext: () => void;
  /** Per-item presentation flags, kept out of the clinical record. */
  flags: ItemFlags;
  onToggleFlag: (flag: keyof ItemFlags) => void;
  onBack: () => void;
  showBack: boolean;
  unfiledCount: number;
}

const flagMeta: Record<keyof ItemFlags, { label: string; chip: string; icon: React.ReactNode }> = {
  portal: { label: 'Do not show on Portal', chip: 'Hidden from portal', icon: <EyeOff size={12} aria-hidden /> },
  confidential: { label: 'Confidential', chip: 'Confidential', icon: <Lock size={12} aria-hidden /> },
  inactive: { label: 'Inactive', chip: 'Inactive', icon: <Archive size={12} aria-hidden /> },
};

const bodyHeading: Record<InboxItem['category'], string> = {
  lab: 'Result',
  radiology: 'Report',
  referral: 'Referral',
  discharge: 'Summary',
};

/**
 * One item, read top to bottom: whose it is, what it is and how urgent, what it
 * says, the facts behind it — and, beside it, what can be done about it.
 */
export function InboxDetail({
  item,
  patient,
  filed,
  onToggleFiled,
  onFileAndNext,
  position,
  onPrevious,
  onNext,
  flags,
  onToggleFlag,
  onBack,
  showBack,
  unfiledCount,
}: Props) {
  const dispatch = useAppDispatch();
  // The item's own patient: the Inbox never depends on who is selected elsewhere in the app.
  const overview = usePatientOverview(patient?.id ?? null);
  const currentPatientId = useAppSelector((s) => s.patients.currentPatientId);
  const [followUp, setFollowUp] = useState<RecordKind | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // A new item starts at its top; on small screens focus moves to it for screen readers.
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    if (showBack) titleRef.current?.focus({ preventScroll: true });
  }, [item.id, showBack]);

  const isCurrentPatient = !!patient && patient.id === currentPatientId;
  const meta = categoryMeta[item.category];
  const level = priorityOf(item);
  const narrative =
    patient
      ? buildPatientNarrative({
          patient,
          medications: overview.medications,
          diagnoses: overview.diagnoses,
          tasks: overview.tasks,
          recalls: overview.recalls,
          appointments: overview.appointments,
        })
      : null;
  const activeFlags = (Object.keys(flags) as Array<keyof ItemFlags>).filter((k) => flags[k]);
  const hasNext = position.index < position.total;

  const moreItems = [
    { key: 'task', icon: <ListChecks size={14} />, label: 'Create task', disabled: !patient },
    { key: 'recall', icon: <Repeat size={14} />, label: 'Create recall', disabled: !patient },
    { key: 'appointment', icon: <CalendarPlus size={14} />, label: 'Book appointment', disabled: !patient },
    { key: 'summary', icon: <Activity size={14} />, label: 'Clinical summary', disabled: !narrative },
    { type: 'divider' as const },
    { key: 'file', icon: filed ? <ArchiveRestore size={14} /> : <Archive size={14} />, label: filed ? 'Unfile this item' : 'File this item' },
    { type: 'divider' as const },
    {
      type: 'group' as const,
      label: 'Inbox view flags',
      children: (Object.keys(flagMeta) as Array<keyof ItemFlags>).map((k) => ({
        key: `flag:${k}`,
        icon: <span className={`ibx-menu-check ${flags[k] ? 'is-on' : ''}`}>{flags[k] && <Check size={11} />}</span>,
        label: flagMeta[k].label,
      })),
    },
  ];

  const runAction = (key: string) => {
    if (key === 'summary') setSummaryOpen(true);
    else if (key === 'file') onToggleFiled(item);
    else if (key.startsWith('flag:')) onToggleFlag(key.slice(5) as keyof ItemFlags);
    else setFollowUp(key as RecordKind);
  };

  const selectPatient = () => {
    dispatch(setCurrentPatient(item.patientId));
    message.success(`${item.patientName} is now the selected patient`);
  };

  return (
    <article className="ibx-detail" aria-labelledby="ibx-detail-title">
      {/* ---- sticky action bar ---- */}
      <div className="ibx-dbar">
        {showBack && (
          <Button type="text" icon={<ChevronLeft size={16} />} onClick={onBack} className="ibx-back">
            Inbox
          </Button>
        )}
        <div className="ibx-dbar-nav">
          <Tooltip title="Previous (K)">
            <Button type="text" size="small" icon={<ChevronUp size={16} />} onClick={onPrevious} disabled={position.index <= 1} aria-label="Previous item" />
          </Tooltip>
          <Tooltip title="Next (J)">
            <Button type="text" size="small" icon={<ChevronDown size={16} />} onClick={onNext} disabled={!hasNext} aria-label="Next item" />
          </Tooltip>
          <span className="ibx-dbar-pos" aria-live="polite">
            {position.index > 0 ? (
              <>
                <b>{position.index}</b> of {position.total}
              </>
            ) : (
              'Not in this list'
            )}
          </span>
        </div>

        <div className="ibx-dbar-actions">
          {filed ? (
            <Tooltip title="Move it back to the unfiled queue (E)">
              <Button icon={<ArchiveRestore size={14} />} onClick={() => onToggleFiled(item)}>
                Unfile
              </Button>
            </Tooltip>
          ) : (
            <>
              <Tooltip title="Mark as reviewed (E)">
                <Button icon={<Archive size={14} />} onClick={() => onToggleFiled(item)}>
                  File
                </Button>
              </Tooltip>
              {hasNext && (
                <Button type="primary" onClick={() => onFileAndNext(item)} className="ibx-file-next">
                  File &amp; next <ArrowRight size={14} aria-hidden />
                </Button>
              )}
            </>
          )}
          <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: moreItems, onClick: ({ key }) => runAction(key) }}>
            <Button icon={<Ellipsis size={16} />} aria-label="More actions" />
          </Dropdown>
        </div>
      </div>

      <div className="ibx-dscroll" ref={scrollRef} data-scroll-region="inbox-item">
        <div className="ibx-dgrid">
          <div className="ibx-doc">
            {/* ---- patient ---- */}
            <section className="ibx-patient" aria-label="Patient">
              <span className="ibx-patient-avatar" style={{ background: `${hashColor(item.patientName)}1f`, color: hashColor(item.patientName) }} aria-hidden>
                {initials(item.patientName)}
              </span>
              <div className="ibx-patient-main">
                <div className="ibx-patient-name">
                  {item.patientName}
                  {isCurrentPatient && (
                    <span className="ibx-patient-current">
                      <UserRoundCheck size={12} aria-hidden /> Current patient
                    </span>
                  )}
                </div>
                {patient ? (
                  <div className="ibx-patient-facts sep-list">
                    <span>
                      NHI <b>{patient.mrn}</b>
                    </span>
                    <span>
                      {patient.gender}, {patient.age} yrs
                    </span>
                    <span>DOB {dayjs(patient.dateOfBirth).format('DD/MM/YYYY')}</span>
                    <span className="ibx-hide-sm">{patient.language}</span>
                  </div>
                ) : (
                  <div className="ibx-patient-facts">
                    <span>Not linked to a patient record</span>
                  </div>
                )}
                {patient && (
                  <div className="ibx-patient-contact sep-list">
                    <a href={`tel:${patient.phone.replace(/[^\d+]/g, '')}`}>
                      <Phone size={12} aria-hidden /> {patient.phone}
                    </a>
                    <a href={`mailto:${patient.email}`} className="ibx-hide-sm">
                      <Mail size={12} aria-hidden /> {patient.email}
                    </a>
                  </div>
                )}
              </div>
              <div className="ibx-patient-actions">
                {!isCurrentPatient && (
                  <Tooltip title={`Open ${item.patientName}'s chart elsewhere in the app — not needed for anything in the Inbox`}>
                    <Button size="small" icon={<UserRound size={14} />} disabled={!item.patientId} onClick={selectPatient}>
                      Select patient
                    </Button>
                  </Tooltip>
                )}
                <Tooltip title={narrative ? 'Built from this patient’s records' : 'This item is not linked to a patient record'}>
                  <Button size="small" icon={<Activity size={14} />} disabled={!narrative} onClick={() => setSummaryOpen(true)}>
                    Clinical summary
                  </Button>
                </Tooltip>
              </div>
            </section>

            {/* ---- what it is ---- */}
            <header className="ibx-dhead">
              <div className="ibx-dhead-kicker">
                <span className={`ibx-kicker is-${item.category}`}>
                  <CategoryIcon view={item.category} size={13} /> {meta.label}
                </span>
                <span className="ibx-dhead-when" title={fullWhen(item.receivedAt)}>
                  {meta.dateLabel} {dayjs(item.receivedAt).format('D MMM YYYY')} · {relativeWhen(item.receivedAt)}
                </span>
              </div>
              <h2 id="ibx-detail-title" ref={titleRef} tabIndex={-1}>
                {item.subject}
              </h2>
              <div className="ibx-dhead-status">
                <StatusLabel item={item} />
                <PriorityMark item={item} />
                {filed ? (
                  <span className="ibx-filed-mark is-filed">
                    <CircleCheck size={13} aria-hidden /> Filed
                  </span>
                ) : (
                  <span className="ibx-filed-mark">
                    <Inbox size={13} aria-hidden /> Unfiled
                  </span>
                )}
                {activeFlags.map((k) => (
                  <span key={k} className="ibx-flag-chip">
                    {flagMeta[k].icon} {flagMeta[k].chip}
                  </span>
                ))}
              </div>
              <p className="ibx-dhead-from">
                {meta.fromLabel}: <b>{item.from}</b>
              </p>
            </header>

            {item.attention && item.attentionReason && (
              <div className={`ibx-callout is-${level === 'critical' ? 'critical' : 'high'}`} role="note">
                {level === 'critical' ? <CircleAlert size={16} aria-hidden /> : <TriangleAlert size={16} aria-hidden />}
                <div>
                  <b>{item.attentionReason}</b>
                  <span>Review before routine items.</span>
                </div>
              </div>
            )}

            {/* ---- what it says ---- */}
            <section className="ibx-section" aria-labelledby="ibx-sec-body">
              <h3 id="ibx-sec-body" className="ibx-section-title">
                {bodyHeading[item.category]}
              </h3>
              {item.result ? (
                <div className={`ibx-result ${item.result.abnormal ? 'is-abnormal' : ''}`}>
                  <div className="ibx-result-main">
                    <span className="ibx-result-test">{item.result.test}</span>
                    <span className="ibx-result-value">{item.result.value}</span>
                  </div>
                  <dl className="ibx-result-facts">
                    <div>
                      <dt>Reference range</dt>
                      <dd>{item.result.referenceRange ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Interpretation</dt>
                      <dd className="ibx-result-flag">
                        {item.result.abnormal ? (
                          <>
                            <CircleAlert size={13} aria-hidden /> Outside range
                          </>
                        ) : (
                          <>
                            <CircleCheck size={13} aria-hidden /> Within range
                          </>
                        )}
                      </dd>
                    </div>
                    {item.result.specimen && (
                      <div>
                        <dt>Specimen</dt>
                        <dd>{item.result.specimen}</dd>
                      </div>
                    )}
                  </dl>
                  {item.result.notes && <p className="ibx-result-notes">{item.result.notes}</p>}
                </div>
              ) : (
                <div className="ibx-report">{item.body ?? item.preview}</div>
              )}
            </section>

            {/* ---- facts behind it ---- */}
            <section className="ibx-section" aria-labelledby="ibx-sec-details">
              <h3 id="ibx-sec-details" className="ibx-section-title">
                Details
              </h3>
              <dl className="ibx-facts">
                {item.meta.map((m) => (
                  <div key={m.label}>
                    <dt>{m.label}</dt>
                    <dd>{m.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <InboxComments itemId={item.id} />
          </div>

          {/* ---- what to do about it ---- */}
          <div className="ibx-assist">
            <InboxAiPanel item={item} patient={patient} unfiledCount={unfiledCount} />
          </div>
        </div>
      </div>

      {followUp && (
        <RecordFormModal
          key={`${item.id}-${followUp}`}
          kind={followUp}
          open
          onOpen={() => undefined}
          onClose={() => setFollowUp(null)}
          prefill={{
            // For the item's patient — whoever is selected elsewhere.
            ...(patient ? { patient: patientRef(patient) } : {}),
            ...(followUp === 'task'
              ? { title: `Review ${item.subject}`, category: item.category === 'referral' ? 'Referral' : 'Lab Follow-up' }
              : followUp === 'recall'
                ? { reason: `Follow up ${item.subject}`, type: item.category === 'lab' ? 'Lab Test' : 'Follow-up' }
                : { reason: `Discuss ${item.subject}`, type: 'Follow-up' }),
          }}
          onSaved={() => {
            message.success(`Saved for ${item.patientName}`);
            setFollowUp(null);
          }}
        />
      )}

      {summaryOpen && narrative && (
        <AppModal
          open
          title="Clinical summary"
          description={`Built from ${item.patientName}'s own records — no generated clinical content.`}
          icon={<Activity size={18} />}
          size="lg"
          onClose={() => setSummaryOpen(false)}
          footer={
            <Button
              type="primary"
              icon={<Mail size={14} />}
              onClick={() => {
                void navigator.clipboard?.writeText(narrative.text);
                message.success('Summary copied');
              }}
            >
              Copy summary
            </Button>
          }
        >
          <dl className="narrative">
            {narrative.sections.map((s) => (
              <div key={s.title}>
                <dt>{s.title}</dt>
                <dd>{s.body}</dd>
              </div>
            ))}
          </dl>
        </AppModal>
      )}
    </article>
  );
}

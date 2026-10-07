import { useMemo } from 'react';
import { Button, Tooltip } from 'antd';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, CalendarDays, Inbox, ListChecks, Repeat, Sparkles, TriangleAlert, Volume2, X } from 'lucide-react';
import dayjs from 'dayjs';
import { useAppDispatch } from '@/store';
import { uiActions } from '@/store/slices/uiSlice';
import { setCurrentPatient } from '@/store/slices/patientSlice';
import { useProviderWorkload } from '@/hooks/useProviderData';
import { useDockWidth } from '@/hooks/useDockWidth';
import { buildProviderNarrative } from '@/services/provider/providerNarrative';
import { speak } from '@/services/ai/speech';
import { Avatar, InlineEmpty, StatusTag } from '@/components/common';
import { PageRegistry } from '@/registry/pageRegistry';
import { formatDate, formatTime } from '@/utils/format';
import type { RecordKind } from '@/types/records';

/**
 * The provider's dashboard summary, docked to the right of the Dashboard as a
 * side panel (the way a browser side panel sits beside the page): the day at a
 * glance, the schedule, what needs attention, and the day in words. It is
 * resizable by dragging its left edge, and opened and closed from the
 * Dashboard or by the assistant — which keeps its own reply short and leaves
 * the summary here.
 */
export function DashboardSummaryPanel() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { workload, loading } = useProviderWorkload();
  const narrative = useMemo(() => (workload ? buildProviderNarrative(workload) : null), [workload]);
  const { startDrag } = useDockWidth('careflow.dashboardPanel.width');

  const close = () => dispatch(uiActions.setDashboardPanelOpen(false));
  const openPatient = (patientId: string, kind: RecordKind) => {
    dispatch(setCurrentPatient(patientId));
    navigate(PageRegistry.recordTab(kind).path);
  };

  return (
    <aside className="dash-dock" aria-label="Dashboard summary">
      <div
        className="dash-dock-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the summary panel"
        onPointerDown={startDrag}
      />
      <header className="dash-dock-head">
        <span className="dash-dock-mark" aria-hidden>
          <Sparkles size={15} />
        </span>
        <div className="dash-dock-title">
          <strong>Dashboard summary</strong>
          <span>{dayjs().format('dddd, D MMM YYYY')}</span>
        </div>
        <Tooltip title="Read it aloud">
          <Button type="text" size="small" className="dash-dock-icon-btn" aria-label="Read the dashboard summary aloud" icon={<Volume2 size={15} />} onClick={() => narrative && speak(narrative.text, { force: true })} />
        </Tooltip>
        <Tooltip title="Close">
          <Button type="text" size="small" className="dash-dock-icon-btn" aria-label="Close the dashboard summary" icon={<X size={16} />} onClick={close} />
        </Tooltip>
      </header>

      <div className="dash-dock-body">
        {!workload ? (
          <InlineEmpty>{loading ? 'Loading your day…' : 'This account has no provider schedule.'}</InlineEmpty>
        ) : (
          <>
            <section className="dash-dock-patient">
              <Avatar name={workload.provider.fullName} size={38} />
              <div>
                <strong>{workload.provider.fullName}</strong>
                <span className="muted">
                  {workload.provider.specialty} · {workload.provider.locationName}
                </span>
                <span className="muted">{workload.panel.length} patients on your panel</span>
              </div>
            </section>

            <section className="dash-dock-stats" aria-label="Your day in numbers">
              <div className="dash-dock-stat is-primary">
                <span className="dash-dock-stat-value">{workload.today.length}</span>
                <span className="dash-dock-stat-label">Today</span>
                <span className="dash-dock-stat-hint">{workload.nextToday ? `next ${formatTime(workload.nextToday.startTime)}` : 'nothing left today'}</span>
              </div>
              <div className="dash-dock-stat is-info">
                <span className="dash-dock-stat-value">{workload.upcoming.length}</span>
                <span className="dash-dock-stat-label">Next 7 days</span>
                <span className="dash-dock-stat-hint">booked</span>
              </div>
              <div className={`dash-dock-stat ${workload.overdueTasks.length ? 'is-error' : 'is-success'}`}>
                <span className="dash-dock-stat-value">{workload.openTasks.length}</span>
                <span className="dash-dock-stat-label">Open tasks</span>
                <span className="dash-dock-stat-hint">{workload.overdueTasks.length ? `${workload.overdueTasks.length} overdue` : 'none overdue'}</span>
              </div>
              <div className={`dash-dock-stat ${workload.overdueRecalls.length ? 'is-warning' : 'is-neutral'}`}>
                <span className="dash-dock-stat-value">{workload.dueRecalls.length}</span>
                <span className="dash-dock-stat-label">Recalls due</span>
                <span className="dash-dock-stat-hint">{workload.overdueRecalls.length ? `${workload.overdueRecalls.length} past due` : 'on time'}</span>
              </div>
            </section>

            {narrative && (
              <section className="dash-dock-section dash-dock-narrative">
                <h3>
                  <Sparkles size={13} aria-hidden /> Your day
                </h3>
                {narrative.sections.map((s) => (
                  <p key={s.title}>{s.body}</p>
                ))}
              </section>
            )}

            <section className="dash-dock-section">
              <h3>
                <CalendarDays size={13} aria-hidden /> Today's schedule <span className="dash-dock-count">{workload.today.length}</span>
              </h3>
              {workload.today.length ? (
                <ul className="dash-dock-list">
                  {workload.today.map((a) => (
                    <li key={a.id} className={workload.nextToday?.id === a.id ? 'is-next' : undefined}>
                      <button type="button" className="dash-dock-link" onClick={() => openPatient(a.patientId, 'appointment')}>
                        <strong>{formatTime(a.startTime)}</strong> {a.patientName}
                        <span className="muted">{a.type}</span>
                      </button>
                      <StatusTag status={a.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <InlineEmpty>No appointments today.</InlineEmpty>
              )}
            </section>

            <section className="dash-dock-section">
              <h3>
                <TriangleAlert size={13} aria-hidden /> Needs attention
              </h3>
              {workload.overdueTasks.slice(0, 4).map((t) => (
                <button key={t.id} type="button" className="dash-dock-row is-danger dash-dock-link" onClick={() => openPatient(t.patientId, 'task')}>
                  <ListChecks size={14} aria-hidden />
                  <div>
                    <strong>{t.title}</strong>
                    <span className="muted">
                      {t.patientName} · due {formatDate(t.dueDate)}
                    </span>
                  </div>
                </button>
              ))}
              {workload.overdueRecalls.slice(0, 3).map((r) => (
                <button key={r.id} type="button" className="dash-dock-row is-warning dash-dock-link" onClick={() => openPatient(r.patientId, 'recall')}>
                  <Repeat size={14} aria-hidden />
                  <div>
                    <strong>{r.reason}</strong>
                    <span className="muted">
                      {r.patientName} · due {formatDate(r.dueDate)}
                    </span>
                  </div>
                </button>
              ))}
              {workload.unfiledInbox
                .filter((i) => i.attention)
                .slice(0, 3)
                .map((i) => (
                  <button key={i.id} type="button" className="dash-dock-row is-info dash-dock-link" onClick={() => navigate(`/inbox/${i.category}?patient=${encodeURIComponent(i.patientId)}`)}>
                    <Inbox size={14} aria-hidden />
                    <div>
                      <strong>{i.subject}</strong>
                      <span className="muted">
                        {i.patientName} · {i.attentionReason ?? i.status}
                      </span>
                    </div>
                  </button>
                ))}
              {!workload.overdueTasks.length && !workload.overdueRecalls.length && !workload.unfiledInbox.some((i) => i.attention) && <InlineEmpty>Nothing is overdue or flagged.</InlineEmpty>}
            </section>

            {workload.upcoming.length > 0 && (
              <section className="dash-dock-section">
                <h3>
                  <CalendarClock size={13} aria-hidden /> Coming up <span className="dash-dock-count">{workload.upcoming.length}</span>
                </h3>
                <ul className="dash-dock-list">
                  {workload.upcoming.slice(0, 6).map((a) => (
                    <li key={a.id}>
                      <button type="button" className="dash-dock-link" onClick={() => openPatient(a.patientId, 'appointment')}>
                        <strong>{formatDate(a.date, 'ddd D MMM')}</strong> {formatTime(a.startTime)} · {a.patientName}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * One task, end to end: what it was, its lifecycle, every reassignment, and its execution trace — each
 * handshake, model call and tool call in the order it happened. Opened from any task label.
 */
import { Drawer, Steps, Timeline } from 'antd';
import { ArrowRight, Repeat2 } from 'lucide-react';
import type { MonitorEvent, MonitorTask } from '@/types/monitor';
import { EVENT_LABELS, partyTitle, taskIssue, taskTrace } from '@/services/ai/monitor/views';
import { useResponsive } from '@/hooks';
import { AgentLabel, fmtDateTime, fmtDuration, fmtTime, pretty, TaskStatusPill, useMonitorView } from './parts';

const COLOR: Record<MonitorEvent['level'], string> = { ok: 'green', info: 'gray', running: 'blue', warning: 'orange', error: 'red' };

/** The lifecycle as steps: Created → Assigned → Accepted → In progress → Completed (or where it stopped). */
function Lifecycle({ task }: { task: MonitorTask }) {
  const end = task.status === 'FAILED' ? 'Failed' : task.status === 'CANCELLED' ? 'Cancelled' : task.status === 'WAITING_FOR_USER' ? 'Waiting for provider' : 'Completed';
  const reached = task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'CANCELLED' ? 4 : task.status === 'IN_PROGRESS' || task.status === 'WAITING_FOR_USER' ? 3 : task.assignedAt ? 1 : 0;
  const bad = task.status === 'FAILED' || task.status === 'CANCELLED';
  return (
    <Steps
      size="small"
      className="mon-lifecycle"
      current={reached}
      status={bad ? 'error' : task.status === 'COMPLETED' ? 'finish' : 'process'}
      items={[
        { title: 'Created', description: fmtTime(task.createdAt) },
        { title: 'Assigned', description: task.assignedAt ? fmtTime(task.assignedAt) : undefined },
        { title: 'Accepted', description: task.startedAt ? fmtTime(task.startedAt) : undefined },
        { title: 'In progress', description: task.status === 'WAITING_FOR_USER' ? 'waiting' : undefined },
        { title: end, description: task.finishedAt ? fmtTime(task.finishedAt) : undefined },
      ]}
    />
  );
}

function TraceItem({ e }: { e: MonitorEvent }) {
  const detail = e.type === 'tool.called' ? pretty(e.args) : e.error ?? e.response;
  return (
    <div className="mon-trace-item">
      <div className="mon-trace-head">
        <span className="mono muted">{fmtTime(e.at)}</span>
        <strong>{EVENT_LABELS[e.type]}</strong>
        {e.from && e.to && (
          <span className="mon-flow">
            {partyTitle(e.from)} <ArrowRight size={12} /> {partyTitle(e.to)}
          </span>
        )}
        {e.tool && <code className="mono">{e.tool}()</code>}
        {e.attempt && e.attempt > 1 && e.type === 'tool.called' && <span className="mon-tag is-warn">retry #{e.attempt - 1}</span>}
        {e.model && <span className="mon-tag">{e.model}</span>}
        {e.durationMs !== undefined && <span className="muted">{fmtDuration(e.durationMs)}</span>}
      </div>
      <div className="mon-trace-text">{e.summary}</div>
      {detail && <pre className="mon-pre">{detail}</pre>}
    </div>
  );
}

export function TaskTraceDrawer({ taskKey, onClose }: { taskKey: string | null; onClose: () => void }) {
  const { m, now } = useMonitorView();
  const { isMobile } = useResponsive();
  const task = taskKey ? m.tasks[taskKey] : undefined;
  const events = task ? taskTrace(m, task.key) : [];
  const issue = task ? taskIssue(task, m, now) : null;
  const deps = task?.dependsOn.map((k) => m.tasks[k]).filter(Boolean) ?? [];
  return (
    <Drawer
      open={!!task}
      onClose={onClose}
      width={isMobile ? '100%' : 760}
      title={
        task ? (
          <span className="mon-drawer-title">
            Task {task.label} <TaskStatusPill status={task.status} />
          </span>
        ) : (
          'Task'
        )
      }
      destroyOnClose
    >
      {task && (
        <div className="mon-trace">
          <p className="mon-trace-instruction">{task.instruction}</p>
          <dl className="mon-kv">
            <dt>Request</dt>
            <dd>“{task.request}”</dd>
            <dt>Created by</dt>
            <dd>
              <AgentLabel party={task.createdBy} />
            </dd>
            <dt>Assigned agent</dt>
            <dd>
              <AgentLabel party={task.agent} />
            </dd>
            <dt>Model</dt>
            <dd>{task.model ?? m.models[task.agent]?.model ?? '—'}</dd>
            <dt>Execution</dt>
            <dd>
              {task.executionType} · {task.route === 'fast' ? 'fast path (one task)' : 'planned'}
            </dd>
            <dt>Depends on</dt>
            <dd>{deps.length ? deps.map((d) => `${d.label} (${partyTitle(d.agent)})`).join(', ') : '—'}</dd>
            <dt>Created</dt>
            <dd>{fmtDateTime(task.createdAt)}</dd>
            <dt>Started</dt>
            <dd>{fmtDateTime(task.startedAt)}</dd>
            <dt>Finished</dt>
            <dd>{fmtDateTime(task.finishedAt)}</dd>
            <dt>Duration</dt>
            <dd>{task.startedAt ? fmtDuration((task.finishedAt ?? now) - task.startedAt) : '—'}</dd>
            {task.retryCount > 0 && (
              <>
                <dt>Retries</dt>
                <dd>{task.retryCount}</dd>
              </>
            )}
            {task.result && (
              <>
                <dt>Result</dt>
                <dd>{task.result}</dd>
              </>
            )}
            {task.waitingFor && (
              <>
                <dt>Waiting for</dt>
                <dd>{task.waitingFor}</dd>
              </>
            )}
            {issue && (
              <>
                <dt>Issue</dt>
                <dd className="mon-bad">
                  <strong>{issue.category}:</strong> {issue.reason}
                  {issue.action && issue.action !== '—' && <div className="muted">Action: {issue.action}</div>}
                </dd>
              </>
            )}
          </dl>

          <h3 className="mon-sub">Lifecycle</h3>
          <Lifecycle task={task} />

          {task.reassignments.length > 0 && (
            <>
              <h3 className="mon-sub">
                <Repeat2 size={15} /> Reassignments
              </h3>
              <ol className="mon-chain">
                <li>
                  <AgentLabel party={task.reassignments[0].from} />
                </li>
                {task.reassignments.map((r, i) => (
                  <li key={i}>
                    <span className="mon-chain-why">
                      ✗ {r.reason} <span className="muted">— {r.trigger}, {fmtTime(r.at)}</span>
                    </span>
                    <AgentLabel party={r.to} />
                  </li>
                ))}
              </ol>
            </>
          )}

          <h3 className="mon-sub">Execution trace</h3>
          {events.length ? (
            <Timeline className="mon-timeline" items={events.map((e) => ({ key: e.id, color: COLOR[e.level], children: <TraceItem e={e} /> }))} />
          ) : (
            <p className="muted">The events of this task are no longer kept (the trail keeps the latest 5,000).</p>
          )}
        </div>
      )}
    </Drawer>
  );
}

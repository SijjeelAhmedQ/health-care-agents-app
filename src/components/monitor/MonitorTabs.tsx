/**
 * The tabs of Agent Monitoring. Each reads the monitor state through useMonitorView() — the same projection
 * of the audit trail — so a number on a summary card, a row in a table and a line in the logs always agree.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, DatePicker, Input, Segmented, Select, Switch, Table, Tooltip, type TableColumnsType } from 'antd';
import { Activity, AlertTriangle, ArrowRight, Bot, Boxes, CheckCircle2, CircleX, Download, Handshake, ListChecks, Mic, Repeat2, ScrollText, Search, Wrench } from 'lucide-react';
import type { Dayjs } from 'dayjs';
import type { MonitorAgentKey, MonitorEvent, MonitorEventType, MonitorHandshake, MonitorLevel, MonitorParty, MonitorTask, MonitorToolCall } from '@/types/monitor';
import { MONITOR_AGENTS, MONITOR_LIMITS } from '@/store/slices/monitorSlice';
import { errorRows, EVENT_GROUPS, EVENT_LABELS, partyTitle, runningTools, summarize, taskIssue, tasksOf, timeline, TOOL_SLOW_MS, TOOL_STUCK_MS, type ErrorRow } from '@/services/ai/monitor/views';
import { AgentLabel, AgentStatusPill, argsLine, fmtDateTime, fmtDuration, fmtTime, HandshakePill, LevelPill, LEVEL_OPTIONS, MonCard, Nothing, pretty, TaskLink, TaskStatusPill, ToolStatusPill, useMonitorView, type MonitorTab } from './parts';

const AGENT_OPTIONS = MONITOR_AGENTS.map((a) => ({ value: a, label: partyTitle(a) }));
const PAGE = { pageSize: 25, showSizeChanger: true, pageSizeOptions: [10, 25, 50, 100], size: 'small' as const };
const includes = (hay: Array<string | undefined>, needle: string) => !needle || hay.some((h) => h?.toLowerCase().includes(needle));

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <Input allowClear className="mon-search" prefix={<Search size={14} />} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />;
}

/** A whole JSON file of what is shown, for the record or for a bug report. */
function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------------- summary cards

export function SummaryCards() {
  const { m, goTo } = useMonitorView();
  const s = summarize(m);
  const cards: Array<{ label: string; value: number; tab: MonitorTab; tone: string; icon: ReactNode; hint?: string }> = [
    { label: 'Active agents', value: s.activeAgents, tab: 'agents', tone: s.activeAgents ? 'live' : 'plain', icon: <Bot size={16} /> },
    { label: 'Running tasks', value: s.runningTasks, tab: 'tasks', tone: s.runningTasks ? 'live' : 'plain', icon: <Activity size={16} /> },
    { label: 'Completed tasks', value: s.completedTasks, tab: 'tasks', tone: 'good', icon: <CheckCircle2 size={16} /> },
    { label: 'Failed tasks', value: s.failedTasks, tab: 'tasks', tone: s.failedTasks ? 'bad' : 'plain', icon: <CircleX size={16} /> },
    { label: 'Handshakes', value: s.handshakes, tab: 'handshakes', tone: s.failedHandshakes ? 'warn' : 'plain', icon: <Handshake size={16} />, hint: s.failedHandshakes ? `${s.failedHandshakes} failed` : undefined },
    { label: 'Tool calls', value: s.toolCalls, tab: 'tools', tone: s.runningTools ? 'live' : 'plain', icon: <Wrench size={16} />, hint: s.runningTools ? `${s.runningTools} running` : undefined },
    { label: 'Errors', value: s.errors, tab: 'errors', tone: s.errors ? 'bad' : 'plain', icon: <AlertTriangle size={16} /> },
  ];
  return (
    <div className="mon-cards" role="list" aria-label="Summary">
      {cards.map((c) => (
        <button key={c.label} type="button" role="listitem" className="mon-stat" data-tone={c.tone} onClick={() => goTo(c.tab)} aria-label={`${c.label}: ${c.value}`}>
          <span className="mon-stat-icon" aria-hidden>
            {c.icon}
          </span>
          <span className="mon-stat-value">{c.value}</span>
          <span className="mon-stat-label">{c.label}</span>
          {c.hint && <span className="mon-stat-hint">{c.hint}</span>}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------------------- overview

/** One line of the communication timeline: who → whom, and what. */
function flowOf(e: MonitorEvent): ReactNode {
  if (e.from && e.to) return (<>{partyTitle(e.from)} <ArrowRight size={12} /> {partyTitle(e.to)}</>);
  if (e.type === 'request.started') return (<>Provider <ArrowRight size={12} /> Assistant</>);
  if (e.type === 'tool.called' && e.agent) return (<>{partyTitle(e.agent)} <ArrowRight size={12} /> <code className="mono">{e.tool}()</code></>);
  if ((e.type === 'tool.completed' || e.type === 'tool.failed') && e.agent) return (<><code className="mono">{e.tool}()</code> <ArrowRight size={12} /> {partyTitle(e.agent)}</>);
  return e.agent ? partyTitle(e.agent) : 'Assistant';
}

function whatOf(e: MonitorEvent): string {
  switch (e.type) {
    case 'handshake.accepted':
      return e.kind === 'handoff' ? 'A2A handshake ✓ — results handed over' : e.kind === 'request' ? 'Request accepted ✓' : e.kind === 'resume' ? 'Answer received ✓' : `Handshake ✓ — task ${e.taskLabel} taken`;
    case 'handshake.rejected':
      return `Handshake ✗ — ${e.reason ?? 'rejected'}`;
    case 'handshake.cancelled':
      return `Handshake cancelled — ${e.reason ?? ''}`;
    case 'task.assigned':
      return `Task ${e.taskLabel} assigned`;
    case 'task.accepted':
      return `Task ${e.taskLabel} accepted`;
    case 'task.completed':
      return `Task ${e.taskLabel} completed ✓`;
    case 'tool.called':
      return e.attempt && e.attempt > 1 ? `Tool call (attempt ${e.attempt})` : 'Tool call';
    case 'tool.completed':
      return `Result: ${e.summary.replace(/^[^:]+:\s*/, '')}`;
    default:
      return e.summary;
  }
}

export function CommunicationTimeline({ requestId, limit = 60 }: { requestId?: string; limit?: number }) {
  const { m } = useMonitorView();
  const events = timeline(m, requestId, limit);
  if (!events.length) return <Nothing>Nothing has happened yet. Speak or type to the assistant — every step shows here as it happens.</Nothing>;
  return (
    <ol className="mon-tl" aria-label="Communication timeline">
      {events.map((e) => (
        <li key={e.id} className="mon-tl-item" data-level={e.level}>
          <span className="mon-tl-time mono">{fmtTime(e.at)}</span>
          <span className="mon-tl-body">
            <span className="mon-tl-flow">{flowOf(e)}</span>
            <span className="mon-tl-what">
              {whatOf(e)}
              {e.taskLabel && e.type.startsWith('tool') && (
                <>
                  {' '}
                  · <TaskLink taskKey={e.taskKey} label={e.taskLabel} />
                </>
              )}
              {e.durationMs !== undefined && <span className="muted"> · {fmtDuration(e.durationMs)}</span>}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ActiveAgentsList() {
  const { m, now } = useMonitorView();
  const agents = MONITOR_AGENTS.filter((a) => m.mode === 'multi' || a === 'master' || a === 'safety');
  return (
    <ul className="mon-agentlist">
      {agents.map((key) => {
        const a = m.agents[key];
        const task = a.taskKey ? m.tasks[a.taskKey] : undefined;
        return (
          <li key={key} data-status={a.status}>
            <AgentLabel party={key} />
            <AgentStatusPill status={a.status} />
            <span className="mon-agentlist-task">{task && a.status !== 'idle' ? <TaskLink taskKey={task.key} label={task.label} /> : null} {a.status !== 'idle' ? (a.activity ?? '') : <span className="muted">No task</span>}</span>
            <span className="mon-agentlist-time muted">{a.status === 'running' || a.status === 'waiting' ? fmtDuration(a.since ? now - a.since : undefined) : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RunningToolCards() {
  const { m, now } = useMonitorView();
  const running = runningTools(m);
  if (!running.length) return <Nothing>No tool is running.</Nothing>;
  return (
    <div className="mon-running">
      {running.map((c) => {
        const ms = now - c.startedAt;
        return (
          <div key={c.id} className="mon-running-card" data-state={ms >= TOOL_STUCK_MS ? 'stuck' : ms >= TOOL_SLOW_MS ? 'slow' : 'ok'}>
            <ToolStatusPill call={c} now={now} />
            <dl className="mon-kv is-tight">
              <dt>Agent</dt>
              <dd>
                <AgentLabel party={c.agent} />
              </dd>
              <dt>Tool</dt>
              <dd>
                <code className="mono">{c.tool}</code>
              </dd>
              <dt>Started</dt>
              <dd className="mono">{fmtTime(c.startedAt)}</dd>
              <dt>Duration</dt>
              <dd className="mono">{fmtDuration(ms)}</dd>
              {c.taskLabel && (
                <>
                  <dt>Task</dt>
                  <dd>
                    <TaskLink taskKey={c.taskKey} label={c.taskLabel} />
                  </dd>
                </>
              )}
            </dl>
            {ms >= TOOL_STUCK_MS && <div className="mon-bad">No answer for {Math.round(ms / 1000)} s — it may be stuck. Cancel the request in the assistant panel to stop it.</div>}
          </div>
        );
      })}
    </div>
  );
}

function IssuesList({ limit }: { limit?: number }) {
  const { m, now } = useMonitorView();
  const issues = tasksOf(m)
    .map((t) => ({ t, issue: taskIssue(t, m, now) }))
    .filter((x): x is { t: MonitorTask; issue: NonNullable<ReturnType<typeof taskIssue>> } => !!x.issue)
    .reverse();
  if (!issues.length) return <Nothing>No failed or incomplete tasks.</Nothing>;
  return (
    <ul className="mon-issues">
      {issues.slice(0, limit).map(({ t, issue }) => (
        <li key={t.key} data-category={issue.category}>
          <div className="mon-issue-top">
            <TaskLink taskKey={t.key} label={t.label} />
            <span className="mon-issue-cat">{issue.category}</span>
            <AgentLabel party={t.agent} compact />
            <span className="muted mono">{fmtTime(t.finishedAt ?? t.createdAt)}</span>
          </div>
          <div className="mon-issue-task">Task: {t.instruction}</div>
          <div className="mon-issue-reason">
            <strong>Reason:</strong> {issue.reason}
          </div>
          {issue.action && issue.action !== '—' && (
            <div className="mon-issue-action">
              <strong>Action:</strong> {issue.action}
            </div>
          )}
        </li>
      ))}
      {limit && issues.length > limit && <li className="muted">and {issues.length - limit} more on the Tasks tab</li>}
    </ul>
  );
}

export function OverviewTab() {
  const { m, goTo } = useMonitorView();
  const latest = m.requests[0];
  return (
    <div className="mon-grid">
      <div className="mon-stack">
        <MonCard title="Agents" icon={<Bot size={16} />} extra={<Button size="small" type="link" onClick={() => goTo('agents')}>Details</Button>}>
          <ActiveAgentsList />
        </MonCard>
        <MonCard title="Running tool calls" icon={<Wrench size={16} />}>
          <RunningToolCards />
        </MonCard>
        <MonCard title="Needs attention" icon={<AlertTriangle size={16} />} extra={<Button size="small" type="link" onClick={() => goTo('tasks')}>All tasks</Button>}>
          <IssuesList limit={5} />
        </MonCard>
      </div>
      <MonCard
        title="Communication timeline"
        icon={<ScrollText size={16} />}
        extra={latest ? <span className="muted mon-ellipsis">Latest: “{latest.said}” · {latest.status}</span> : undefined}
        className="mon-card-tall"
      >
        <CommunicationTimeline requestId={latest?.id} />
      </MonCard>
    </div>
  );
}

// ----------------------------------------------------------------------------------------- agents

export function AgentsTab() {
  const { m, now } = useMonitorView();
  const multi = m.mode === 'multi';
  const rows = MONITOR_AGENTS.filter((a) => multi || a === 'master' || a === 'safety');
  return (
    <div className="mon-stack">
      <div className="mon-agentcards">
        {rows.map((key) => {
          const a = m.agents[key];
          const task = a.taskKey ? m.tasks[a.taskKey] : undefined;
          const model = m.models[key];
          return (
            <section key={key} className="mon-agentcard" data-status={a.status} aria-label={partyTitle(key)}>
              <header>
                <AgentLabel party={key} />
                <AgentStatusPill status={a.status} />
              </header>
              <dl className="mon-kv is-tight">
                <dt>Current task</dt>
                <dd>{task && a.status !== 'idle' ? (<><TaskLink taskKey={task.key} label={task.label} /> {task.instruction}</>) : key === 'master' && a.status === 'running' ? a.activity : '—'}</dd>
                <dt>Doing</dt>
                <dd>{a.activity ?? '—'}</dd>
                <dt>Started</dt>
                <dd className="mono">{a.status === 'idle' ? '—' : fmtTime(a.since)}</dd>
                <dt>Duration</dt>
                <dd className="mono">{a.status === 'running' || a.status === 'waiting' ? fmtDuration(a.since ? now - a.since : undefined) : '—'}</dd>
                <dt>Model</dt>
                <dd>{model ? `${model.model} · ${model.provider}` : '—'}</dd>
              </dl>
              <div className="mon-agentcard-counts">
                <span title="Tasks assigned">{a.counts.tasks} tasks</span>
                <span title="Completed">✓ {a.counts.completed}</span>
                <span title="Failed" data-bad={a.counts.failed > 0}>✗ {a.counts.failed}</span>
                <span title="Tool calls">{a.counts.toolCalls} tools</span>
                <span title="Model calls">{a.counts.modelCalls} model calls</span>
              </div>
              {a.lastError && <div className="mon-bad mon-ellipsis-2" title={a.lastError}>Last error: {a.lastError}</div>}
            </section>
          );
        })}
      </div>
      <ModelMapping />
    </div>
  );
}

function ModelMapping() {
  const { m } = useMonitorView();
  const multi = m.mode === 'multi';
  const rows: Array<{ key: string; party?: MonitorAgentKey; name: string; model: string; provider: string; role: string }> = MONITOR_AGENTS.map((a) => ({
    key: a,
    party: a,
    name: partyTitle(a),
    model: m.models[a]?.model ?? (multi || a === 'master' ? '—' : 'not used'),
    provider: m.models[a]?.provider ?? '—',
    role:
      a === 'master'
        ? multi
          ? 'Plans and hands out tasks'
          : 'The whole assistant (single-agent mode)'
        : a === 'planning'
          ? multi
            ? 'Gathers what each action needs; asks for what is missing'
            : 'Off in single-agent mode'
          : a === 'safety'
            ? 'Checks every call: only what the provider said goes through'
            : multi
              ? 'Specialist'
              : 'Off in single-agent mode',
  }));
  if (m.speech) rows.push({ key: 'stt', name: 'Speech recognition (STT)', model: m.speech.model, provider: m.speech.provider, role: 'Hears the microphone' });
  const columns: TableColumnsType<(typeof rows)[number]> = [
    { title: 'Agent', dataIndex: 'name', render: (_, r) => (r.party ? <AgentLabel party={r.party} /> : (<span className="mon-agent"><span className="mon-agent-icon"><Mic size={14} /></span><span className="mon-agent-name">{r.name}</span></span>)) },
    { title: 'Model', dataIndex: 'model', render: (v: string) => <code className="mono">{v}</code> },
    { title: 'Provider', dataIndex: 'provider' },
    { title: 'Role', dataIndex: 'role', responsive: ['md'] },
  ];
  return (
    <MonCard title="Agent → model" icon={<Boxes size={16} />} extra={<span className="muted">{multi ? 'Multi-agent mode' : 'Single-agent mode'} · applied {fmtTime(m.configuredAt ?? undefined)}</span>}>
      <Table size="small" rowKey="key" columns={columns} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }} />
      <p className="mon-hint">This is what runs now. Applying a change on the Configuration page rebuilds the agents, and this table follows.</p>
    </MonCard>
  );
}

// ------------------------------------------------------------------------------------------ tasks

type TaskFilter = 'all' | 'active' | 'completed' | 'issues';

export function TasksTab() {
  const { m, now, openTask } = useMonitorView();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<MonitorAgentKey | undefined>();
  const all = tasksOf(m);
  const q = query.trim().toLowerCase();
  const rows = all
    .filter((t) => {
      if (agent && t.agent !== agent && !t.reassignments.some((r) => r.from === agent)) return false;
      if (filter === 'active' && !['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER'].includes(t.status)) return false;
      if (filter === 'completed' && t.status !== 'COMPLETED') return false;
      if (filter === 'issues' && !taskIssue(t, m, now)) return false;
      return includes([t.label, t.instruction, t.request, partyTitle(t.agent), t.error, t.status], q);
    })
    .reverse();
  const reassigned = all.filter((t) => t.reassignments.length).flatMap((t) => t.reassignments.map((r, i) => ({ ...r, key: `${t.key}-${i}`, task: t })));
  const columns: TableColumnsType<MonitorTask> = [
    { title: 'Task', dataIndex: 'label', width: 80, sorter: (a, b) => a.createdAt - b.createdAt, render: (_, t) => <TaskLink taskKey={t.key} label={t.label} /> },
    { title: 'Description', dataIndex: 'instruction', render: (v: string) => <span className="mon-ellipsis-2">{v}</span> },
    { title: 'Created by', dataIndex: 'createdBy', responsive: ['lg'], render: (v: MonitorParty) => <AgentLabel party={v} compact /> },
    { title: 'Agent', dataIndex: 'agent', sorter: (a, b) => a.agent.localeCompare(b.agent), render: (_, t) => (<span className="mon-col"><AgentLabel party={t.agent} compact />{t.reassignments.length > 0 && <span className="mon-tag is-warn"><Repeat2 size={11} /> from {t.reassignments.map((r) => partyTitle(r.from).replace(/ Agent$/, '')).join(', ')}</span>}</span>) },
    { title: 'Assigned', dataIndex: 'assignedAt', responsive: ['md'], render: (v?: number) => <span className="mono">{fmtTime(v)}</span> },
    {
      title: 'Status',
      dataIndex: 'status',
      sorter: (a, b) => a.status.localeCompare(b.status),
      render: (_, t) => {
        const issue = taskIssue(t, m, now);
        return (
          <span className="mon-col">
            <TaskStatusPill status={t.status} />
            {issue && issue.category !== 'Failed' && issue.category !== 'Cancelled' && issue.category !== 'Waiting for provider' && <span className="mon-tag is-warn">{issue.category}</span>}
            {t.retryCount > 0 && <span className="mon-tag is-warn">retried {t.retryCount}×</span>}
          </span>
        );
      },
    },
    { title: 'Started', dataIndex: 'startedAt', responsive: ['md'], render: (v?: number) => <span className="mono">{fmtTime(v)}</span> },
    { title: 'Completed', dataIndex: 'finishedAt', responsive: ['md'], render: (v?: number) => <span className="mono">{fmtTime(v)}</span> },
    { title: 'Duration', key: 'duration', sorter: (a, b) => ((a.finishedAt ?? now) - (a.startedAt ?? now)) - ((b.finishedAt ?? now) - (b.startedAt ?? now)), render: (_, t) => <span className="mono">{t.startedAt ? fmtDuration((t.finishedAt ?? now) - t.startedAt) : '—'}</span> },
  ];
  return (
    <div className="mon-stack">
      <MonCard title="Incomplete & failed tasks" icon={<AlertTriangle size={16} />}>
        <IssuesList />
      </MonCard>
      <MonCard
        title="Tasks"
        icon={<ListChecks size={16} />}
        extra={<span className="muted">Created → Assigned → Accepted → In progress → Completed · click a task for its trace</span>}
      >
        <div className="mon-toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="Search tasks" />
          <Segmented<TaskFilter> value={filter} onChange={setFilter} options={[{ value: 'all', label: `All (${all.length})` }, { value: 'active', label: 'Active' }, { value: 'completed', label: 'Completed' }, { value: 'issues', label: 'Issues' }]} />
          <Select allowClear className="mon-select" placeholder="Any agent" value={agent} onChange={setAgent} options={AGENT_OPTIONS} aria-label="Agent" />
        </div>
        <Table
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={rows}
          pagination={PAGE}
          scroll={{ x: 'max-content' }}
          rowClassName={(t) => (t.status === 'FAILED' ? 'mon-row-bad' : t.status === 'IN_PROGRESS' ? 'mon-row-live' : '')}
          onRow={(t) => ({ onClick: () => openTask(t.key), style: { cursor: 'pointer' } })}
          locale={{ emptyText: all.length ? 'No task matches.' : 'No tasks yet — tasks appear when the master hands work to the specialists (multi-agent mode).' }}
        />
      </MonCard>
      <MonCard title="Reassignments" icon={<Repeat2 size={16} />}>
        {reassigned.length ? (
          <Table
            size="small"
            rowKey="key"
            pagination={PAGE}
            scroll={{ x: 'max-content' }}
            dataSource={reassigned.reverse()}
            columns={[
              { title: 'Task', render: (_, r) => <TaskLink taskKey={r.task.key} label={r.task.label} /> },
              { title: 'Original agent', render: (_, r) => <AgentLabel party={r.from} compact /> },
              { title: 'New agent', render: (_, r) => <AgentLabel party={r.to} compact /> },
              { title: 'Reason', dataIndex: 'reason' },
              { title: 'Triggered by', dataIndex: 'trigger', responsive: ['md'] },
              { title: 'Time', dataIndex: 'at', render: (v: number) => <span className="mono">{fmtTime(v)}</span> },
              { title: 'Status', render: (_, r) => <span className="mono">{r.previousStatus} → {r.newStatus}</span>, responsive: ['lg'] },
            ]}
          />
        ) : (
          <Nothing>No task has been reassigned. When a specialist hands a task back as not its own, the master gives it to the agent it belongs to — that shows here.</Nothing>
        )}
      </MonCard>
    </div>
  );
}

// ------------------------------------------------------------------------------------- handshakes

export function HandshakesTab() {
  const { m, now } = useMonitorView();
  const [status, setStatus] = useState<'all' | MonitorHandshake['status']>('all');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = m.handshakes.filter((h) => (status === 'all' || h.status === status) && includes([partyTitle(h.from), partyTitle(h.to), h.taskLabel, h.detail, h.reason, h.kind], q)).slice().reverse();
  const latest = m.requests.find((r) => m.handshakes.some((h) => h.requestId === r.id));
  const chain = latest ? m.handshakes.filter((h) => h.requestId === latest.id) : [];
  const KIND: Record<MonitorHandshake['kind'], string> = { request: 'Request', delegation: 'Task delegation', handoff: 'A2A hand-off', resume: 'Provider answer' };
  const columns: TableColumnsType<MonitorHandshake> = [
    { title: 'Source', dataIndex: 'from', render: (v: MonitorParty) => <AgentLabel party={v} compact /> },
    { title: '', key: 'arrow', width: 24, render: () => <ArrowRight size={14} className="muted" /> },
    { title: 'Target', dataIndex: 'to', render: (v: MonitorParty) => <AgentLabel party={v} compact /> },
    { title: 'Type', dataIndex: 'kind', render: (v: MonitorHandshake['kind']) => KIND[v], filters: Object.entries(KIND).map(([value, text]) => ({ value, text })), onFilter: (v, h) => h.kind === v },
    { title: 'Task', dataIndex: 'taskLabel', render: (_, h) => <TaskLink taskKey={h.taskKey} label={h.taskLabel} /> },
    { title: 'Status', dataIndex: 'status', render: (v: MonitorHandshake['status']) => <HandshakePill status={v} /> },
    { title: 'Initiated', dataIndex: 'initiatedAt', sorter: (a, b) => a.initiatedAt - b.initiatedAt, render: (v: number) => <span className="mono">{fmtTime(v)}</span> },
    { title: 'Completed', dataIndex: 'completedAt', responsive: ['md'], render: (v?: number) => <span className="mono">{fmtTime(v)}</span> },
    { title: 'Duration', key: 'd', render: (_, h) => <span className="mono">{fmtDuration((h.completedAt ?? now) - h.initiatedAt)}</span> },
    { title: 'Failure reason', dataIndex: 'reason', render: (v: string | undefined, h) => (h.status === 'rejected' || h.status === 'cancelled' ? <span className={h.status === 'rejected' ? 'mon-bad' : 'muted'}>{v ?? '—'}</span> : <span className="muted">{h.detail}</span>) },
  ];
  return (
    <div className="mon-stack">
      <MonCard title="Latest request" icon={<Handshake size={16} />} extra={latest ? <span className="muted mon-ellipsis">“{latest.said}”</span> : undefined}>
        {chain.length ? (
          <ol className="mon-hschain">
            {chain.map((h) => (
              <li key={h.id} data-status={h.status}>
                <AgentLabel party={h.from} compact />
                <span className="mon-hschain-link">
                  <span className="mon-hschain-mark">{h.status === 'accepted' ? '✓' : h.status === 'rejected' ? '✗' : h.status === 'cancelled' ? '–' : '…'}</span> {KIND[h.kind]}
                  {h.taskLabel ? ` · ${h.taskLabel}` : ''}
                </span>
                <AgentLabel party={h.to} compact />
                {h.status === 'rejected' && <span className="mon-bad mon-hschain-why">{h.reason}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <Nothing>No handshakes yet.</Nothing>
        )}
      </MonCard>
      <MonCard title="All handshakes" icon={<Handshake size={16} />}>
        <div className="mon-toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="Search handshakes" />
          <Segmented value={status} onChange={(v) => setStatus(v as typeof status)} options={[{ value: 'all', label: 'All' }, { value: 'accepted', label: 'Success' }, { value: 'rejected', label: 'Failed' }, { value: 'pending', label: 'Pending' }, { value: 'cancelled', label: 'Cancelled' }]} />
        </div>
        <Table size="small" rowKey="id" columns={columns} dataSource={rows} pagination={PAGE} scroll={{ x: 'max-content' }} rowClassName={(h) => (h.status === 'rejected' ? 'mon-row-bad' : h.status === 'pending' ? 'mon-row-live' : '')} locale={{ emptyText: 'No handshakes.' }} />
      </MonCard>
    </div>
  );
}

// ------------------------------------------------------------------------------------- tool calls

export function ToolCallsTab() {
  const { m, now } = useMonitorView();
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<MonitorAgentKey | undefined>();
  const [tool, setTool] = useState<string | undefined>();
  const [status, setStatus] = useState<MonitorToolCall['status'] | undefined>();
  const tools = useMemo(() => [...new Set(m.toolCalls.map((c) => c.tool))].sort(), [m.toolCalls]);
  const q = query.trim().toLowerCase();
  const rows = m.toolCalls.filter((c) => (!agent || c.agent === agent) && (!tool || c.tool === tool) && (!status || c.status === status) && includes([c.tool, partyTitle(c.agent), c.taskLabel, c.response, c.error, JSON.stringify(c.args)], q)).slice().reverse();
  const columns: TableColumnsType<MonitorToolCall> = [
    { title: 'Started', dataIndex: 'startedAt', sorter: (a, b) => a.startedAt - b.startedAt, render: (v: number) => <span className="mono">{fmtTime(v)}</span> },
    { title: 'Agent', dataIndex: 'agent', render: (v: MonitorAgentKey) => <AgentLabel party={v} compact /> },
    { title: 'Tool', dataIndex: 'tool', render: (v: string, c) => (<span className="mon-col"><code className="mono">{v}()</code>{c.attempt > 1 && <span className="mon-tag is-warn">attempt {c.attempt}</span>}</span>) },
    { title: 'Arguments', dataIndex: 'args', render: (v: Record<string, unknown>) => <span className="mon-ellipsis-2 muted">{argsLine(v)}</span> },
    { title: 'Status', dataIndex: 'status', render: (_, c) => <ToolStatusPill call={c} now={now} /> },
    { title: 'Ended', dataIndex: 'finishedAt', responsive: ['md'], render: (v?: number) => <span className="mono">{fmtTime(v)}</span> },
    { title: 'Duration', key: 'd', sorter: (a, b) => ((a.finishedAt ?? now) - a.startedAt) - ((b.finishedAt ?? now) - b.startedAt), render: (_, c) => <span className="mono">{fmtDuration((c.finishedAt ?? now) - c.startedAt)}</span> },
    { title: 'Response', key: 'r', render: (_, c) => <span className={`mon-ellipsis-2${c.error ? ' mon-bad' : ''}`}>{c.error ?? c.response ?? '—'}</span> },
    { title: 'Task', dataIndex: 'taskLabel', render: (_, c) => <TaskLink taskKey={c.taskKey} label={c.taskLabel} /> },
  ];
  return (
    <div className="mon-stack">
      <MonCard title="Running now" icon={<Activity size={16} />}>
        <RunningToolCards />
      </MonCard>
      <MonCard title="Tool call history" icon={<Wrench size={16} />}>
        <div className="mon-toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="Search tool calls, arguments, responses" />
          <Select allowClear className="mon-select" placeholder="Any agent" value={agent} onChange={setAgent} options={AGENT_OPTIONS} aria-label="Agent" />
          <Select allowClear showSearch className="mon-select" placeholder="Any tool" value={tool} onChange={setTool} options={tools.map((t) => ({ value: t, label: t }))} aria-label="Tool" />
          <Select allowClear className="mon-select" placeholder="Any status" value={status} onChange={setStatus} aria-label="Status" options={[{ value: 'running', label: 'Running' }, { value: 'ok', label: 'Success' }, { value: 'waiting', label: 'Needs provider' }, { value: 'failed', label: 'Failed' }]} />
        </div>
        <Table
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={rows}
          pagination={PAGE}
          scroll={{ x: 'max-content' }}
          rowClassName={(c) => (c.status === 'failed' ? 'mon-row-bad' : c.status === 'running' ? 'mon-row-live' : '')}
          expandable={{
            expandedRowRender: (c) => (
              <div className="mon-detail">
                <div>
                  <h4>Arguments</h4>
                  <pre className="mon-pre">{pretty(c.args)}</pre>
                </div>
                <div>
                  <h4>{c.error ? 'Error' : 'Response'}</h4>
                  <pre className="mon-pre">{c.error ?? pretty(c.response) ?? '—'}</pre>
                </div>
              </div>
            ),
          }}
          locale={{ emptyText: 'No tool calls yet.' }}
        />
      </MonCard>
    </div>
  );
}

// ------------------------------------------------------------------------------------------- logs

export function LogsTab() {
  const { m } = useMonitorView();
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<MonitorAgentKey[]>([]);
  const [types, setTypes] = useState<MonitorEventType[]>([]);
  const [levels, setLevels] = useState<MonitorLevel[]>([]);
  const [task, setTask] = useState<string | undefined>();
  const [tool, setTool] = useState<string | undefined>();
  const [model, setModel] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const options = useMemo(() => {
    const tools = new Set<string>();
    const models = new Set<string>();
    const tasks = new Map<string, string>();
    for (const e of m.events) {
      if (e.tool) tools.add(e.tool);
      if (e.model) models.add(e.model);
      if (e.taskKey && e.taskLabel) tasks.set(e.taskKey, e.taskLabel);
    }
    return { tools: [...tools].sort(), models: [...models].sort(), tasks: [...tasks.entries()].reverse() };
  }, [m.events]);
  const q = query.trim().toLowerCase();
  const from = range?.[0]?.valueOf();
  const to = range?.[1]?.valueOf();
  const rows = m.events
    .filter(
      (e) =>
        (!errorsOnly || e.level === 'error') &&
        (!agents.length || (e.agent && agents.includes(e.agent)) || (e.from && agents.includes(e.from as MonitorAgentKey)) || (e.to && agents.includes(e.to as MonitorAgentKey))) &&
        (!types.length || types.includes(e.type)) &&
        (!levels.length || levels.includes(e.level)) &&
        (!task || e.taskKey === task) &&
        (!tool || e.tool === tool) &&
        (!model || e.model === model) &&
        (!from || e.at >= from) &&
        (!to || e.at <= to) &&
        includes([e.summary, e.tool, e.model, e.taskLabel, e.error, e.request, e.response, e.agent && partyTitle(e.agent), EVENT_LABELS[e.type]], q),
    )
    .slice()
    .reverse();
  const filtered = !!(q || agents.length || types.length || levels.length || task || tool || model || from || to || errorsOnly);
  const columns: TableColumnsType<MonitorEvent> = [
    { title: 'Time', dataIndex: 'at', sorter: (a, b) => a.seq - b.seq, render: (v: number) => <Tooltip title={fmtDateTime(v)}><span className="mono">{fmtTime(v)}</span></Tooltip> },
    { title: 'Agent', dataIndex: 'agent', render: (v?: MonitorAgentKey) => (v ? <AgentLabel party={v} compact /> : <span className="muted">—</span>) },
    { title: 'Event', dataIndex: 'type', render: (v: MonitorEventType) => <span className="mon-tag">{EVENT_LABELS[v]}</span> },
    { title: 'Task', dataIndex: 'taskLabel', render: (_, e) => <TaskLink taskKey={e.taskKey} label={e.taskLabel} /> },
    { title: 'Details', dataIndex: 'summary', render: (v: string) => <span className="mon-ellipsis-2">{v}</span> },
    { title: 'Status', dataIndex: 'level', render: (v: MonitorLevel) => <LevelPill level={v} /> },
    { title: 'Duration', dataIndex: 'durationMs', responsive: ['md'], render: (v?: number) => <span className="mono">{v === undefined ? '' : fmtDuration(v)}</span> },
    { title: 'Tool / model', key: 'tm', responsive: ['lg'], render: (_, e) => <span className="mono muted">{e.tool ?? e.model ?? ''}</span> },
  ];
  return (
    <MonCard
      title="Agent logs"
      icon={<ScrollText size={16} />}
      extra={
        <Button size="small" icon={<Download size={14} />} onClick={() => download(`agent-logs-${Date.now()}.json`, rows.slice().reverse())}>
          Download {filtered ? 'filtered' : 'all'} ({rows.length})
        </Button>
      }
    >
      <div className="mon-toolbar is-wrap">
        <SearchBox value={query} onChange={setQuery} placeholder="Search logs: words, errors, requests, responses" />
        <Select mode="multiple" allowClear maxTagCount="responsive" className="mon-select is-wide" placeholder="Agents" value={agents} onChange={setAgents} options={AGENT_OPTIONS} aria-label="Agents" />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          className="mon-select is-wide"
          placeholder="Event types"
          value={types}
          onChange={setTypes}
          aria-label="Event types"
          options={Object.entries(EVENT_GROUPS).map(([group, list]) => ({ label: group, title: group, options: list.map((t) => ({ value: t, label: EVENT_LABELS[t] })) }))}
        />
        <Select mode="multiple" allowClear maxTagCount="responsive" className="mon-select" placeholder="Status" value={levels} onChange={setLevels} options={LEVEL_OPTIONS} aria-label="Status" />
        <Select allowClear showSearch className="mon-select" placeholder="Task" value={task} onChange={setTask} options={options.tasks.map(([key, label]) => ({ value: key, label }))} aria-label="Task" optionFilterProp="label" />
        <Select allowClear showSearch className="mon-select" placeholder="Tool" value={tool} onChange={setTool} options={options.tools.map((t) => ({ value: t, label: t }))} aria-label="Tool" />
        <Select allowClear showSearch className="mon-select" placeholder="Model" value={model} onChange={setModel} options={options.models.map((t) => ({ value: t, label: t }))} aria-label="Model" />
        <DatePicker.RangePicker showTime className="mon-range" value={range} onChange={(v) => setRange(v as typeof range)} aria-label="Date and time" />
        <label className="mon-switch">
          <Switch size="small" checked={errorsOnly} onChange={setErrorsOnly} /> Errors only
        </label>
      </div>
      <Table
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={{ ...PAGE, pageSize: 50 }}
        scroll={{ x: 'max-content' }}
        rowClassName={(e) => (e.level === 'error' ? 'mon-row-bad' : '')}
        expandable={{
          expandedRowRender: (e) => (
            <div className="mon-detail">
              {e.request && (
                <div>
                  <h4>Request</h4>
                  <pre className="mon-pre">{e.type === 'tool.called' ? pretty(e.args) : pretty(e.request)}</pre>
                </div>
              )}
              {e.response && (
                <div>
                  <h4>Response</h4>
                  <pre className="mon-pre">{pretty(e.response)}</pre>
                </div>
              )}
              {e.error && (
                <div>
                  <h4>Error</h4>
                  <pre className="mon-pre mon-bad">{e.error}</pre>
                </div>
              )}
              <div>
                <h4>Event</h4>
                <pre className="mon-pre">{pretty(e)}</pre>
              </div>
            </div>
          ),
        }}
        locale={{ emptyText: m.events.length ? 'No log entry matches these filters.' : 'No activity yet.' }}
      />
      <p className="mon-hint">
        The trail is append-only: entries are never edited. It keeps the latest {MONITOR_LIMITS.events.toLocaleString()} events{m.dropped ? ` (${m.dropped.toLocaleString()} older entries dropped)` : ''} and is cleared when you sign out, as it names patients.
      </p>
    </MonCard>
  );
}

// ----------------------------------------------------------------------------------------- errors

export function ErrorsTab() {
  const { m } = useMonitorView();
  const [kind, setKind] = useState<string>('all');
  const [query, setQuery] = useState('');
  const all = errorRows(m);
  const q = query.trim().toLowerCase();
  const rows = all.filter((r) => (kind === 'all' || r.event.errorKind === kind) && includes([r.event.error, r.event.operation, r.event.tool, r.event.taskLabel, r.event.agent && partyTitle(r.event.agent), r.retry, r.reassignment], q));
  const KIND: Record<string, string> = { model: 'Model', tool: 'Tool', task: 'Task', handshake: 'Handshake', request: 'Request' };
  const columns: TableColumnsType<ErrorRow> = [
    { title: 'Time', key: 'at', sorter: (a, b) => a.event.seq - b.event.seq, render: (_, r) => <Tooltip title={fmtDateTime(r.event.at)}><span className="mono">{fmtTime(r.event.at)}</span></Tooltip> },
    { title: 'Type', key: 'kind', render: (_, r) => <span className="mon-tag is-bad">{KIND[r.event.errorKind ?? ''] ?? 'Error'}</span> },
    { title: 'Agent', key: 'agent', render: (_, r) => (r.event.agent ? <AgentLabel party={r.event.agent} compact /> : '—') },
    { title: 'Task', key: 'task', render: (_, r) => <TaskLink taskKey={r.event.taskKey} label={r.event.taskLabel} /> },
    { title: 'Tool', key: 'tool', render: (_, r) => (r.event.tool ? <code className="mono">{r.event.tool}</code> : '—') },
    { title: 'Error message', key: 'msg', render: (_, r) => <span className="mon-bad mon-ellipsis-3">{r.event.error}</span> },
    { title: 'Failed operation', key: 'op', responsive: ['md'], render: (_, r) => r.event.operation ?? '—' },
    { title: 'Retry', key: 'retry', render: (_, r) => <span className={/Recovered/.test(r.retry) ? 'mon-good' : /failed|No retries/.test(r.retry) ? 'mon-bad' : ''}>{r.retry}</span> },
    { title: 'Reassignment', key: 'reassign', render: (_, r) => r.reassignment },
  ];
  return (
    <MonCard title="Errors & issues" icon={<AlertTriangle size={16} />} extra={<span className="muted">Every error is kept — nothing is hidden</span>}>
      <div className="mon-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search errors" />
        <Segmented value={kind} onChange={(v) => setKind(String(v))} options={[{ value: 'all', label: `All (${all.length})` }, ...Object.entries(KIND).map(([value, label]) => ({ value, label: `${label} (${all.filter((r) => r.event.errorKind === value).length})` }))]} />
      </div>
      <Table
        size="small"
        rowKey={(r) => r.event.id}
        columns={columns}
        dataSource={rows}
        pagination={PAGE}
        scroll={{ x: 'max-content' }}
        expandable={{ expandedRowRender: (r) => <pre className="mon-pre">{pretty(r.event)}</pre> }}
        locale={{ emptyText: all.length ? 'No error matches.' : 'No errors. Failed tool calls, model errors, failed tasks and rejected handshakes show here.' }}
      />
    </MonCard>
  );
}

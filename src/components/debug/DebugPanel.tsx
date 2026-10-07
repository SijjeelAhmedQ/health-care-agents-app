import { Button, Collapse, Empty, Segmented, Space, Tag, Timeline } from 'antd';
import { useState } from 'react';
import { Bug, Trash2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/store';
import { uiActions } from '@/store/slices/uiSlice';
import { voiceActions } from '@/store/slices/voiceSlice';
import { FormRegistry } from '@/registry/formRegistry';
import { PageRegistry } from '@/registry/pageRegistry';
import type { AgentStep, AgentTask, DebugTrace, TaskGraphSnapshot, TaskStatus } from '@/types/ai';
import { AGENT_TITLES } from '@/services/ai/agents/taskGraph';
import { getVoiceController } from '@/services/ai/voiceController';
import { StatusTag } from '@/components/common';
import { AppModal } from '@/components/common/AppModal';

function stepColor(step: AgentStep) {
  if (!step.finishedAt) return 'blue';
  if (step.type === 'model') return step.error ? 'red' : 'blue';
  if (!step.result) return 'gray';
  if (step.result.awaitUser) return 'orange';
  return step.result.ok ? 'green' : 'red';
}

function StepView({ step }: { step: AgentStep }) {
  const ms = step.finishedAt ? <span className="muted" style={{ fontSize: 11 }}>{step.finishedAt - step.startedAt} ms</span> : <span className="muted">running…</span>;
  if (step.type === 'model') {
    return (
      <div style={{ fontSize: 13 }}>
        <div className="flex items-center gap-2">
          <strong>Model</strong>
          {step.toolCalls?.length ? <Tag color="blue">{step.toolCalls.length} tool call{step.toolCalls.length === 1 ? '' : 's'}</Tag> : step.finishedAt && !step.error ? <Tag>reply</Tag> : null}
          {ms}
        </div>
        {step.error && <div style={{ color: '#e5484d' }}>{step.error}</div>}
        {step.content && <div className="muted" style={{ marginTop: 2 }}>{step.content}</div>}
        {step.toolCalls?.map((c, i) => (
          <pre key={i} className="debug-block" style={{ marginTop: 6, maxHeight: 160 }}>{`${c.name}(${JSON.stringify(c.arguments, null, 2)})`}</pre>
        ))}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 13 }}>
      <div className="flex items-center gap-2">
        <code className="mono">{step.call.name}</code>
        {step.result && <StatusTag status={step.result.awaitUser ? 'waiting for user' : step.result.ok ? 'done' : 'failed'} />}
        {ms}
      </div>
      {step.result && <div className="muted" style={{ marginTop: 2 }}>{step.result.message}</div>}
      {step.result?.data !== undefined && <pre className="debug-block" style={{ marginTop: 6, maxHeight: 160 }}>{JSON.stringify(step.result.data, null, 2)}</pre>}
    </div>
  );
}

const TASK_COLOR: Record<TaskStatus, string> = {
  PENDING: 'default',
  ASSIGNED: 'cyan',
  IN_PROGRESS: 'blue',
  COMPLETED: 'green',
  FAILED: 'red',
  WAITING_FOR_USER: 'orange',
  CANCELLED: 'default',
};

/** What a task handed on, briefly: the ids and names, not the records themselves. */
function resultLine(task: AgentTask): string | null {
  const r = task.result;
  if (!r) return null;
  const data = r.data === undefined ? '' : Array.isArray(r.data) ? `${r.data.length} item${r.data.length === 1 ? '' : 's'}` : typeof r.data === 'string' ? 'text' : 'details';
  const parts = [r.patientId && `patientId=${r.patientId}`, r.patientName && `patientName=${r.patientName}`, data && `data: ${data}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function StepsTimeline({ steps }: { steps: AgentStep[] }) {
  return steps.length ? <Timeline style={{ marginTop: 8 }} items={steps.map((s) => ({ color: stepColor(s), children: <StepView step={s} /> }))} /> : null;
}

/** Multi-agent mode: the master, its task graph, and what each specialist did for its task. */
function TaskTree({ graph, steps }: { graph: TaskGraphSnapshot; steps: AgentStep[] }) {
  const masterSteps = steps.filter((s) => s.agent === 'master');
  return (
    <div className="debug-tree">
      <div className="debug-tree-root">
        <strong>Master Agent</strong> <Tag className="tag-plain">{graph.route === 'fast' ? 'fast path — one task' : `${graph.tasks.length} tasks`}</Tag>
        {graph.finishedAt ? <span className="muted" style={{ fontSize: 11 }}>{graph.finishedAt - graph.createdAt} ms</span> : null}
      </div>
      {masterSteps.length > 0 && <Collapse size="small" ghost items={[{ key: 'm', label: `Master steps (${masterSteps.length})`, children: <StepsTimeline steps={masterSteps} /> }]} />}
      <ul>
        {graph.tasks.map((t) => {
          const own = steps.filter((s) => s.taskId === t.id);
          const result = resultLine(t);
          return (
            <li key={t.id} className="debug-task">
              <div className="flex items-center gap-2 wrap">
                <code className="mono">{t.id}</code>
                <strong>{AGENT_TITLES[t.agent]}</strong>
                <Tag color={TASK_COLOR[t.status]}>{t.status}</Tag>
                <Tag className="tag-plain" title={t.declaredType ? `The master said ${t.declaredType}; the tools it used made it ${t.executionType}` : undefined}>
                  {t.executionType}
                  {t.declaredType ? ` (declared ${t.declaredType})` : ''}
                </Tag>
                {t.model && <Tag className="tag-plain">{t.model}</Tag>}
                {t.retryCount > 0 && <Tag color="gold">retried {t.retryCount}×</Tag>}
                {t.triedAgents?.length ? <Tag color="purple">reassigned from {t.triedAgents.map((a) => AGENT_TITLES[a]).join(', ')}</Tag> : null}
              </div>
              <div style={{ marginTop: 2 }}>{t.instruction}</div>
              <dl className="debug-kv debug-task-kv">
                <dt>Depends on</dt><dd>{t.dependsOn.length ? t.dependsOn.join(', ') : '—'}</dd>
                {t.waitingFor && (<><dt>Waiting for</dt><dd>{t.waitingFor}</dd></>)}
                {result && (<><dt>Result</dt><dd>{result}</dd></>)}
                {t.result?.reply && (<><dt>Reply</dt><dd>{t.result.reply}</dd></>)}
                {t.error && (<><dt>{t.status === 'FAILED' || t.status === 'CANCELLED' ? 'Error' : 'Last error'}</dt><dd style={{ color: '#e5484d' }}>{t.error}</dd></>)}
              </dl>
              {own.length > 0 && <Collapse size="small" ghost items={[{ key: t.id, label: `Steps (${own.length})`, children: <StepsTimeline steps={own} /> }]} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TraceView({ trace }: { trace: DebugTrace }) {
  const pending = useAppSelector((s) => s.voice.pendingConfirmation);
  const toolCalls = trace.steps.filter((s) => s.type === 'tool').length;
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <dl className="debug-kv">
        <dt>Said</dt><dd>“{trace.transcript}”</dd>
        <dt>Model</dt><dd>{trace.provider}</dd>
        <dt>Reply</dt><dd>{trace.reply ?? '—'}</dd>
        <dt>Confirmation pending</dt><dd>{pending ? <Tag color="orange">yes — {pending.formTitle}</Tag> : 'no'}</dd>
        <dt>Duration</dt><dd>{trace.finishedAt ? `${trace.finishedAt - trace.startedAt} ms` : 'running…'}</dd>
        {trace.error && (<><dt>Error</dt><dd style={{ color: '#e5484d' }}>{trace.error}</dd></>)}
      </dl>
      <Collapse
        size="small"
        defaultActiveKey={trace.graph ? ['graph'] : ['steps']}
        items={[
          ...(trace.graph ? [{ key: 'graph', label: `Task graph (${trace.graph.tasks.length})`, children: <TaskTree graph={trace.graph} steps={trace.steps} /> }] : []),
          {
            key: 'steps',
            label: `Agent steps (${trace.steps.length - toolCalls} model, ${toolCalls} tool)`,
            children: <Timeline items={trace.steps.map((s) => ({ color: stepColor(s), children: <StepView step={s} /> }))} />,
          },
          {
            key: 'fields',
            label: `Fields modified (${trace.fieldsModified.length})`,
            children: trace.fieldsModified.length ? (
              <dl className="debug-kv">
                {trace.fieldsModified.map((f, i) => (
                  <div key={i} style={{ display: 'contents' }}>
                    <dt>{f.formId}.{f.field}</dt><dd>{f.value || <span className="muted">(cleared)</span>}</dd>
                  </div>
                ))}
              </dl>
            ) : <span className="muted">No fields modified</span>,
          },
          { key: 'context', label: 'Message sent to the model', children: <pre className="debug-block">{trace.context}</pre> },
        ]}
      />
    </Space>
  );
}

export function DebugPanel() {
  const open = useAppSelector((s) => s.ui.debugPanelOpen);
  const voice = useAppSelector((s) => s.voice);
  const nav = useAppSelector((s) => s.navigation);
  const dispatch = useAppDispatch();
  const [view, setView] = useState<'current' | 'history' | 'registry'>('current');

  return (
    <AppModal
      title="Assistant Debug Panel"
      description={
        <span className="flex items-center gap-2 wrap">
          <Tag color="blue" className="tag-plain">STT: {voice.sttProvider}</Tag>
          <Tag color="blue" className="tag-plain">LLM: {voice.llmProvider}</Tag>
          <Tag className="tag-plain">{voice.status}</Tag>
        </span>
      }
      icon={<Bug size={18} />}
      open={open}
      onClose={() => dispatch(uiActions.setDebugPanelOpen(false))}
      size="xl"
      footer={
        <>
          <Button icon={<Trash2 size={14} />} onClick={() => dispatch(voiceActions.clearHistory())}>Clear history</Button>
          <Button type="primary" onClick={() => dispatch(uiActions.setDebugPanelOpen(false))}>Close</Button>
        </>
      }
    >
      <Segmented block value={view} onChange={(v) => setView(v as typeof view)} options={[{ label: 'Current', value: 'current' }, { label: `History (${voice.traceHistory.length})`, value: 'history' }, { label: 'Registries', value: 'registry' }]} style={{ marginBottom: 16 }} />
      {view === 'current' && (voice.trace ? <TraceView trace={voice.trace} /> : <Empty description="Nothing asked yet. Speak or type to the assistant." />)}
      {view === 'history' && (
        <Collapse
          size="small"
          items={voice.traceHistory.map((t, i) => ({
            key: `${t.startedAt}-${i}`,
            label: (
              <span>
                <span className="muted">{new Date(t.startedAt).toLocaleTimeString()}</span> — “{t.transcript}” {t.error && <Tag color="red">error</Tag>}
              </span>
            ),
            children: <TraceView trace={t} />,
          }))}
        />
      )}
      {view === 'registry' && (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <dl className="debug-kv">
            <dt>Current page</dt><dd>{nav.currentPageId ?? '—'} <span className="muted">{nav.currentPath}</span></dd>
            <dt>Open form</dt><dd>{FormRegistry.active()?.formId ?? nav.openFormId ?? '—'}</dd>
            <dt>Mounted forms</dt><dd>{FormRegistry.mounted().map((c) => c.formId).join(', ') || '—'}</dd>
            <dt>Pending slot</dt><dd>{voice.pendingSlot ? `${voice.pendingSlot.formId}.${voice.pendingSlot.field}` : '—'}</dd>
            <dt>Registered pages</dt><dd>{PageRegistry.all().length}</dd>
            <dt>Tools</dt><dd>{getVoiceController().tools.map((t) => t.name).join(', ')}</dd>
          </dl>
          <Collapse size="small" items={[{ key: 'pages', label: 'Page registry', children: <pre className="debug-block" style={{ maxHeight: 400 }}>{PageRegistry.all().map((p) => `${String(p.number).padStart(2, ' ')}  ${p.id.padEnd(28)} ${p.path}`).join('\n')}</pre> }]} />
        </Space>
      )}
    </AppModal>
  );
}

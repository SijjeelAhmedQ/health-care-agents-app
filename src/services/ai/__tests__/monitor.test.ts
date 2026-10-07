/**
 * Agent monitoring: the recorder turns what the assistant reports (steps, task-graph snapshots, the request's
 * start and end) into the audit trail, and the slice projects the trail into what the screen shows.
 */
import { describe, expect, it } from 'vitest';
import reducer, { monitorActions, type MonitorState } from '@/store/slices/monitorSlice';
import type { AgentStep, AgentTask, TaskGraphSnapshot } from '@/types/ai';
import type { MonitorEvent } from '@/types/monitor';
import { MonitorRecorder } from '../monitor/recorder';
import { errorRows, networkEdges, summarize, taskIssue, taskTrace, tasksOf } from '../monitor/views';

function setup() {
  let state: MonitorState = reducer(undefined, { type: '@@init' });
  const log: MonitorEvent[] = [];
  const recorder = new MonitorRecorder(
    (events) => {
      log.push(...events);
      state = reducer(state, monitorActions.record(events));
    },
    (agent) => (agent === 'summary' ? 'vllm:qwen3.5:9b' : 'ollama:qwen3.5:4b'),
  );
  return { recorder, log, get state() { return state; } };
}

const task = (id: string, agent: AgentTask['agent'], status: AgentTask['status'], extra: Partial<AgentTask> = {}): AgentTask => ({ id, agent, instruction: `do ${id}`, dependsOn: [], executionType: 'WRITE', status, retryCount: 0, ...extra });
const graph = (tasks: AgentTask[]): TaskGraphSnapshot => ({ id: 'g1', request: 'select harry and add metformin', route: tasks.length > 1 ? 'planned' : 'fast', tasks, createdAt: Date.now() });
let n = 0;
const tool = (agent: AgentStep['agent'], taskId: string | undefined, name: string, result?: { ok: boolean; message: string }): AgentStep[] => {
  const id = `s${n++}`;
  const start: AgentStep = { id, type: 'tool', startedAt: Date.now(), call: { name, arguments: { x: 1 } }, agent, taskId };
  return result ? [start, { ...start, finishedAt: Date.now() + 5, result }] : [start];
};

describe('the monitor recorder and slice', () => {
  it('records a request end to end: delegation, acceptance, the A2A hand-off between agents, tools and completion', () => {
    const m = setup();
    m.recorder.configured('multi', { master: { model: 'qwen3.5:4b', provider: 'This Computer' }, summary: { model: 'qwen3.5:9b', provider: 'Kaggle' } }, { model: 'Whisper', provider: 'Kaggle' });
    expect(m.state.mode).toBe('multi');
    expect(m.state.models.summary).toEqual({ model: 'qwen3.5:9b', provider: 'Kaggle' });

    m.recorder.beginRequest('select harry and add metformin', 'multi');
    expect(m.state.agents.master.status).toBe('running');
    const model: AgentStep = { id: 'mm', type: 'model', startedAt: Date.now(), agent: 'master' };
    m.recorder.step(model);
    m.recorder.step({ ...model, finishedAt: Date.now() + 10, toolCalls: [{ name: 'assign_tasks', arguments: {} }] });
    m.recorder.graph(graph([task('t1', 'patients', 'PENDING', { executionType: 'CONTEXT' }), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] })]));
    expect(tasksOf(m.state).map((t) => [t.label, t.agent, t.status])).toEqual([
      ['#1001', 'patients', 'PENDING'],
      ['#1002', 'summary', 'PENDING'],
    ]);
    // t2 waits on t1: the monitor says so.
    expect(taskIssue(tasksOf(m.state)[1], m.state)?.category).toBe('Waiting for another agent');

    m.recorder.graph(graph([task('t1', 'patients', 'IN_PROGRESS', { model: 'ollama:qwen3.5:4b' }), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] })]));
    expect(m.state.agents.patients).toMatchObject({ status: 'running', taskKey: 'g1:t1' });
    for (const s of tool('patients', 't1', 'select_patient', { ok: true, message: 'Harry White is selected.' })) m.recorder.step(s);
    m.recorder.graph(graph([task('t1', 'patients', 'COMPLETED', { result: { patientId: 'p1', patientName: 'Harry White' } }), task('t2', 'summary', 'IN_PROGRESS', { dependsOn: ['t1'] })]));
    m.recorder.graph(graph([task('t1', 'patients', 'COMPLETED'), task('t2', 'summary', 'COMPLETED', { dependsOn: ['t1'] })]));
    m.recorder.endRequest({ reply: 'Done.' });

    const kinds = m.state.handshakes.map((h) => [h.kind, h.from, h.to, h.status]);
    expect(kinds).toEqual([
      ['request', 'provider', 'master', 'accepted'],
      ['delegation', 'master', 'patients', 'accepted'],
      ['delegation', 'master', 'summary', 'accepted'],
      ['handoff', 'patients', 'summary', 'accepted'],
    ]);
    expect(m.state.toolCalls).toHaveLength(1);
    expect(m.state.toolCalls[0]).toMatchObject({ agent: 'patients', tool: 'select_patient', status: 'ok', taskLabel: '#1001' });
    expect(m.state.agents.summary.status).toBe('completed');
    expect(m.state.agents.master.status).toBe('completed');
    expect(m.state.requests[0]).toMatchObject({ status: 'completed', reply: 'Done.' });
    expect(summarize(m.state)).toMatchObject({ completedTasks: 2, failedTasks: 0, handshakes: 4, toolCalls: 1, errors: 0 });
    // A task's trace runs from creation to completion, in order.
    expect(taskTrace(m.state, 'g1:t2').map((e) => e.type)).toEqual(['task.created', 'task.assigned', 'handshake.initiated', 'handshake.accepted', 'task.accepted', 'handshake.initiated', 'handshake.accepted', 'task.completed']);
    // The audit trail is ordered and every event names its request.
    expect(m.log.map((e) => e.seq)).toEqual([...m.log.map((e) => e.seq)].sort((a, b) => a - b));
    expect(m.log.filter((e) => e.type !== 'agents.configured').every((e) => e.requestId)).toBe(true);
  });

  it('tracks a retry, a reassignment with its reason, and a task blocked by a failure', () => {
    const m = setup();
    m.recorder.beginRequest('do three things', 'multi');
    m.recorder.graph(graph([task('t1', 'patients', 'PENDING'), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] }), task('t3', 'inbox', 'PENDING')]));

    // t3: the Inbox Agent hands it back — it belongs to the Dashboard Agent.
    m.recorder.graph(graph([task('t1', 'patients', 'PENDING'), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] }), task('t3', 'inbox', 'IN_PROGRESS')]));
    for (const s of tool('inbox', 't3', 'not_my_task')) m.recorder.step(s);
    const back = m.log[m.log.length - 1];
    m.recorder.step({ id: back.callId!, type: 'tool', startedAt: back.at, finishedAt: Date.now(), call: { name: 'not_my_task', arguments: { reason: 'It is about my day', better_agent: 'dashboard' } }, result: { ok: true, message: 'Handed back.' }, agent: 'inbox', taskId: 't3' });
    m.recorder.graph(graph([task('t1', 'patients', 'PENDING'), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] }), task('t3', 'dashboard', 'IN_PROGRESS', { triedAgents: ['inbox'] })]));
    m.recorder.graph(graph([task('t1', 'patients', 'PENDING'), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] }), task('t3', 'dashboard', 'COMPLETED', { triedAgents: ['inbox'] })]));

    // t1: a tool fails, the task fails, is retried, and fails again — t2 can never run.
    m.recorder.graph(graph([task('t1', 'patients', 'IN_PROGRESS'), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] }), task('t3', 'dashboard', 'COMPLETED')]));
    for (const s of tool('patients', 't1', 'select_patient', { ok: false, message: 'Patient record was not found.' })) m.recorder.step(s);
    m.recorder.graph(graph([task('t1', 'patients', 'IN_PROGRESS', { retryCount: 1, error: 'Patient record was not found.' }), task('t2', 'summary', 'PENDING', { dependsOn: ['t1'] }), task('t3', 'dashboard', 'COMPLETED')]));
    for (const s of tool('patients', 't1', 'select_patient', { ok: false, message: 'Patient record was not found.' })) m.recorder.step(s);
    m.recorder.graph(graph([task('t1', 'patients', 'FAILED', { retryCount: 1, error: 'Patient record was not found.' }), task('t2', 'summary', 'CANCELLED', { dependsOn: ['t1'], error: 'Not done: it needed t1 (do t1), which failed.' }), task('t3', 'dashboard', 'COMPLETED')]));
    m.recorder.endRequest({ reply: 'Could not do t1.' });

    const [t1, t2, t3] = tasksOf(m.state);
    expect(t3.reassignments).toEqual([expect.objectContaining({ from: 'inbox', to: 'dashboard', reason: 'It is about my day' })]);
    expect(t3.status).toBe('COMPLETED');
    expect(t1).toMatchObject({ status: 'FAILED', retryCount: 1, error: 'Patient record was not found.' });
    expect(taskIssue(t1, m.state)).toMatchObject({ category: 'Failed', action: 'Retried 1×' });
    expect(taskIssue(t2, m.state)).toMatchObject({ category: 'Blocked', action: 'Needs task #1001 (failed)' });

    // The Inbox Agent rejected its task; the hand-off to t2 never happened, and t2's offer lapsed — nobody refused it.
    const settled = m.state.handshakes.filter((h) => h.status === 'rejected' || h.status === 'cancelled').map((h) => [h.kind, h.from, h.to, h.status]);
    expect(settled).toEqual([
      ['delegation', 'master', 'summary', 'cancelled'],
      ['delegation', 'master', 'inbox', 'rejected'],
      ['handoff', 'patients', 'summary', 'rejected'],
    ]);
    // No master step this time (as when the provider answers a waiting task): no provider → master handshake.
    expect(m.state.handshakes.some((h) => h.kind === 'request')).toBe(false);
    expect(networkEdges(m.state).find((e) => e.from === 'master' && e.to === 'inbox')).toMatchObject({ rejected: 1 });

    // Every failure is an error; each says whether it was retried or the task reassigned.
    const errors = errorRows(m.state).map((r) => [r.event.errorKind, r.retry, r.reassignment]);
    expect(errors).toEqual([
      ['task', 'No retries left', '—'],
      ['tool', 'Not retried', '—'],
      ['task', 'Retry #1 failed', '—'],
      ['tool', 'Retried 1× — failed', '—'],
      ['handshake', '—', 'Reassigned → Dashboard Agent'],
    ]);
    // The second select_patient was a retry of the first.
    expect(m.state.toolCalls.filter((c) => c.tool === 'select_patient').map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('closes what a cancelled request left running, and a sign-out clears the trail but not the configuration', () => {
    const m = setup();
    m.recorder.configured('single', { master: { model: 'qwen3.5:4b', provider: 'This Computer' } });
    m.recorder.beginRequest('add a patient', 'single');
    for (const s of tool(undefined, undefined, 'create_patient')) m.recorder.step(s);
    expect(m.state.toolCalls[0]).toMatchObject({ agent: 'master', status: 'running' });
    m.recorder.endRequest({ cancelled: true });
    expect(m.state.toolCalls[0]).toMatchObject({ status: 'failed', error: 'Interrupted: the request was cancelled.' });
    expect(m.state.requests[0].status).toBe('cancelled');

    const cleared = reducer(m.state, monitorActions.reset());
    expect(cleared.events).toEqual([]);
    expect(cleared.toolCalls).toEqual([]);
    expect(cleared.models.master).toEqual({ model: 'qwen3.5:4b', provider: 'This Computer' });
  });
});

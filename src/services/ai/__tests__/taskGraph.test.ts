import { describe, expect, it } from 'vitest';
import { formatResult, stricter, TaskGraph } from '../agents/taskGraph';

/** "Find John, check his latest lab report and schedule an appointment" — the graph from the spec. */
const johnGraph = () =>
  new TaskGraph('Find John Ahmed, check his latest lab report and schedule an appointment for tomorrow', [
    { id: 't1', agent: 'patients', instruction: 'Find and select John Ahmed', executionType: 'CONTEXT' },
    { id: 't2', agent: 'inbox', instruction: "Open John Ahmed's latest lab report", dependsOn: ['t1'], executionType: 'READ_ONLY' },
    { id: 't3', agent: 'appointments', instruction: 'Schedule an appointment for John Ahmed tomorrow', dependsOn: ['t1'], executionType: 'WRITE' },
  ]);

describe('the task graph', () => {
  it('dependencies, not list order, decide what is ready: t2 and t3 both wait for t1 only', () => {
    const g = johnGraph();
    expect(g.route).toBe('planned');
    expect(g.ready().map((t) => t.id)).toEqual(['t1']);
    g.move('t1', 'ASSIGNED');
    g.move('t1', 'IN_PROGRESS');
    expect(g.ready()).toEqual([]);
    g.move('t1', 'COMPLETED', { result: { patientId: 'pat-7', patientName: 'John Ahmed' } });
    expect(g.ready().map((t) => t.id)).toEqual(['t2', 't3']);
    expect(g.get('t2').dependsOn).toEqual(['t1']);
    expect(g.get('t3').dependsOn).toEqual(['t1']);
  });

  it('a dependent task reads the structured result of what it depends on — ids, not prose', () => {
    const g = johnGraph();
    g.move('t1', 'ASSIGNED');
    g.move('t1', 'IN_PROGRESS');
    g.move('t1', 'COMPLETED', { result: { patientId: 'pat-7', patientName: 'John Ahmed', reply: 'John Ahmed is selected.' } });
    const lines = g.resultsFor(g.get('t3'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('patientId=pat-7');
    expect(lines[0]).toContain('patientName=John Ahmed');
    expect(g.resultsFor(g.get('t1'))).toEqual([]);
  });

  it('results reach through the chain: a task sees what its dependencies depended on', () => {
    const g = new TaskGraph('x', [
      { agent: 'patients', instruction: 'select John', executionType: 'CONTEXT' },
      { agent: 'inbox', instruction: 'open his lab', dependsOn: ['t1'], executionType: 'READ_ONLY' },
      { agent: 'inbox', instruction: 'file it', dependsOn: ['t2'], executionType: 'WRITE' },
    ]);
    for (const id of ['t1', 't2']) {
      g.move(id, 'ASSIGNED');
      g.move(id, 'IN_PROGRESS');
      g.move(id, 'COMPLETED', { result: { patientId: 'pat-7' } });
    }
    expect(g.resultsFor(g.get('t3')).map((l) => l.slice(0, 2))).toEqual(['t1', 't2']);
  });

  it('never has a cycle: a dependency on the same, a later or an unknown task is dropped and noted', () => {
    const g = new TaskGraph('x', [
      { id: 'a', agent: 'patients', instruction: 'one', dependsOn: ['b'] },
      { id: 'b', agent: 'summary', instruction: 'two', dependsOn: ['a', 'b', 'zzz'] },
    ]);
    expect(g.get('t1').dependsOn).toEqual([]);
    expect(g.get('t2').dependsOn).toEqual(['t1']);
    expect(g.notes).toHaveLength(3);
  });

  it('an execution type the master left out is the strictest one', () => {
    const g = new TaskGraph('x', [{ agent: 'patients', instruction: 'something' }]);
    expect(g.get('t1').executionType).toBe('WRITE');
    expect(g.route).toBe('fast');
    expect(stricter('READ_ONLY', 'CONTEXT')).toBe('CONTEXT');
    expect(stricter('WRITE', 'READ_ONLY')).toBe('WRITE');
  });

  it('follows the lifecycle only: a move it does not allow is a bug and throws', () => {
    const g = johnGraph();
    expect(() => g.move('t1', 'COMPLETED')).toThrow(/PENDING → COMPLETED/);
    g.move('t1', 'ASSIGNED');
    g.move('t1', 'IN_PROGRESS');
    g.move('t1', 'WAITING_FOR_USER', { waitingFor: 'Which John?' });
    expect(g.waiting()?.id).toBe('t1');
    g.move('t1', 'IN_PROGRESS');
    expect(g.get('t1').waitingFor).toBeUndefined();
    g.move('t1', 'FAILED', { error: 'x' });
    g.move('t1', 'PENDING', { retryCount: 1 }); // a retry
    expect(g.get('t1').retryCount).toBe(1);
  });

  it('what depends on a failed task is cancelled — transitively — and never runs', () => {
    const g = new TaskGraph('x', [
      { agent: 'patients', instruction: 'select John' },
      { agent: 'inbox', instruction: 'open his lab', dependsOn: ['t1'] },
      { agent: 'inbox', instruction: 'file it', dependsOn: ['t2'] },
      { agent: 'dashboard', instruction: 'show my day' },
    ]);
    g.move('t1', 'ASSIGNED');
    g.move('t1', 'IN_PROGRESS');
    g.move('t1', 'FAILED', { error: 'No patient matches "John".' });
    const cancelled = g.cancelUnreachable();
    expect(cancelled.map((t) => t.id)).toEqual(['t2', 't3']);
    expect(g.get('t2').error).toMatch(/needed t1/);
    expect(g.ready().map((t) => t.id)).toEqual(['t4']); // the independent task still runs
  });

  it('a newer request supersedes what is left, and the graph is done', () => {
    const g = johnGraph();
    g.move('t1', 'ASSIGNED');
    g.move('t1', 'IN_PROGRESS');
    g.move('t1', 'WAITING_FOR_USER', { waitingFor: 'Which John?' });
    g.supersede();
    expect(g.tasks.map((t) => t.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
    expect(g.done).toBe(true);
    expect(g.finishedAt).toBeDefined();
  });

  it('shows as the assistant panel’s steps, and as a snapshot that later moves do not change', () => {
    const g = johnGraph();
    const before = g.snapshot();
    g.move('t1', 'ASSIGNED');
    g.move('t1', 'IN_PROGRESS');
    expect(before.tasks[0].status).toBe('PENDING');
    expect(g.planSteps().map((s) => [s.status, s.agent])).toEqual([
      ['running', 'patients'],
      ['pending', 'inbox'],
      ['pending', 'appointments'],
    ]);
    expect(formatResult(g.get('t1'))).toBe('t1 (patients, IN_PROGRESS): Find and select John Ahmed');
  });
});

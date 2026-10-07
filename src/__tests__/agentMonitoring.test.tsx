/**
 * Agent Monitoring against the real application: a multi-agent request run through the real orchestrator,
 * tools and runtime — one task handed back and reassigned, one that fails, is retried and fails again, and
 * one that can never run because of it — is recorded as it happens, and the monitoring screen (opened from
 * the Configuration page) shows all of it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { fetchPatients } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import { voiceActions } from '@/store/slices/voiceSlice';
import { router } from '@/app/router';
import { tasksOf, errorRows } from '@/services/ai/monitor/views';
import { call, FakeMic, type ScriptedLLM } from '@/services/ai/__tests__/fakes';
import { getVoiceController } from '@/services/ai/voiceController';
import type { ChatLLM, ChatMessage, ChatTurn, ToolSchema } from '@/services/ai/providers/llm';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, useScriptedModel, wait, waitUntil } from './harness';

// The first test drives the whole app through eight tabs: slow when the full suite runs alongside.
const TIMEOUT = 90000;
let model: ScriptedLLM;

beforeAll(installBrowserStubs);

beforeEach(async () => {
  store.dispatch(voiceActions.resetVoice());
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchProviders()).unwrap();
  model = useScriptedModel({ multiAgent: true });
});

afterEach(async () => {
  await unmountApp();
});

const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy();
  (el as HTMLElement).click();
  await wait(120);
};

describe('Agent Monitoring', () => {
  it('records a multi-agent request — reassignment, retry, failure, a blocked task — and shows it from the Configuration page', async () => {
    await renderAppAt('/dashboard');
    model.then(
      {
        calls: [
          call('assign_tasks', {
            tasks: [
              { id: 't1', agent: 'inbox', instruction: 'How busy am I today', execution: 'READ_ONLY' },
              { id: 't2', agent: 'patients', instruction: 'Select zzyx qwerty', execution: 'CONTEXT' },
              { id: 't3', agent: 'summary', instruction: 'Show the summary', depends_on: ['t2'], execution: 'READ_ONLY' },
            ],
          }),
        ],
      },
      // t1: not the Inbox Agent's work — handed back, and given to the Dashboard Agent.
      { calls: [call('not_my_task', { reason: 'It is about the provider’s own day', better_agent: 'dashboard' })] },
      { calls: [call('get_provider_overview')] },
      { content: 'Here is your day.' },
      // t2: a tool the Patients Agent does not have — fails, is retried once, fails again.
      { calls: [call('add_medications', { medications: [] })] },
      { content: 'I could not do that.' },
      { calls: [call('add_medications', { medications: [] })] },
      { content: 'Still could not do that.' },
    );
    await say('how busy am I today, select zzyx qwerty and then show the summary');
    await waitUntil(() => store.getState().monitor.requests[0]?.status !== 'running');

    const m = store.getState().monitor;
    expect(m.mode).toBe('multi');
    const tasks = tasksOf(m).filter((t) => t.requestId === m.requests[0].id);
    expect(tasks.map((t) => [t.agent, t.status])).toEqual([
      ['dashboard', 'COMPLETED'],
      ['patients', 'FAILED'],
      ['summary', 'CANCELLED'],
    ]);
    expect(tasks[0].reassignments).toEqual([expect.objectContaining({ from: 'inbox', to: 'dashboard', reason: 'It is about the provider’s own day' })]);
    expect(tasks[1].retryCount).toBe(1);
    // The tool calls, by agent, as they ran.
    expect(m.toolCalls.filter((c) => c.requestId === m.requests[0].id).map((c) => [c.agent, c.tool, c.status])).toEqual([
      ['master', 'assign_tasks', 'ok'],
      ['inbox', 'not_my_task', 'ok'],
      ['dashboard', 'get_provider_overview', 'ok'],
      ['patients', 'add_medications', 'failed'],
      ['patients', 'add_medications', 'failed'],
    ]);
    // The handshakes: the request, each delegation (one rejected), and t3's hand-off from t2 that never came.
    const shakes = m.handshakes.filter((h) => h.requestId === m.requests[0].id).map((h) => `${h.kind}:${h.from}>${h.to}:${h.status}`);
    expect(shakes).toContain('request:provider>master:accepted');
    expect(shakes).toContain('delegation:master>inbox:rejected');
    expect(shakes).toContain('delegation:master>dashboard:accepted');
    expect(shakes).toContain('handoff:patients>summary:rejected');
    // Every error is there, with what followed it.
    const errors = errorRows(m);
    expect(errors.some((r) => r.event.errorKind === 'tool' && /There is no tool/.test(r.event.error ?? ''))).toBe(true);
    expect(errors.some((r) => r.event.errorKind === 'handshake' && r.reassignment === 'Reassigned → Dashboard Agent')).toBe(true);
    // The models each agent ran on.
    expect(m.models.master?.model).toBe('scripted');

    // The Configuration page has the way in: a route of its own, /agent-monitor (like /summary) — no popup window.
    await unmountApp();
    await renderAppAt('/configuration', () => pageText().includes('Agent Monitoring'));
    const realOpen = window.open;
    let popups = 0;
    window.open = (() => {
      popups += 1;
      return null;
    }) as typeof window.open;
    try {
      const link = [...document.querySelectorAll('a, button')].find((b) => b.textContent?.includes('Agent Monitoring'));
      expect(link?.getAttribute('href')).toBe('/agent-monitor'); // Ctrl + click: the browser opens it in a new tab
      await click(link);
      await waitUntil(() => router.state.location.pathname === '/agent-monitor' && pageText().includes('Communication timeline'));
    } finally {
      window.open = realOpen;
    }
    expect(popups).toBe(0);
    expect(router.state.location.pathname).toBe('/agent-monitor');

    // The page itself: its own route — no sidebar, no app header — to sit beside the app.
    await unmountApp();
    await renderAppAt('/agent-monitor', () => pageText().includes('Communication timeline'));
    expect(document.querySelector('.mon-standalone')).toBeTruthy();
    expect(document.querySelector('.app-shell')).toBeNull();
    // The old address leads there.
    await router.navigate('/configuration/monitoring');
    await waitUntil(() => router.state.location.pathname === '/agent-monitor' && !!document.querySelector('.mon-standalone .mon-stat'));
    expect(router.state.location.pathname).toBe('/agent-monitor');

    // Overview: the counters, the agents, the timeline of the latest request.
    const stat = (label: string) => document.querySelector(`.mon-stat[aria-label^="${label}:"] .mon-stat-value`)?.textContent;
    expect(Number(stat('Failed tasks'))).toBeGreaterThanOrEqual(1);
    expect(Number(stat('Errors'))).toBeGreaterThanOrEqual(3);
    expect(pageText()).toContain('Handshake ✗ — It is about the provider’s own day');
    expect(pageText()).toContain('Needs attention');
    expect(pageText()).toContain('Blocked');

    // Every tab opens and shows its part.
    const tab = (id: string) => document.querySelector(`.mon-tab[data-tab="${id}"]`);
    await click(tab('tasks'));
    expect(pageText()).toContain('Reassignments');
    expect(pageText()).toContain('It is about the provider’s own day');
    await click(tab('handshakes'));
    expect(document.querySelectorAll('.mon-hschain li[data-status="rejected"]').length).toBeGreaterThanOrEqual(2);
    await click(tab('tools'));
    expect(pageText()).toContain('add_medications()');
    await click(tab('errors'));
    expect(pageText()).toContain('There is no tool');
    expect(pageText()).toContain('Retried 1× — failed');
    await click(tab('agents'));
    expect(pageText()).toContain('Speech recognition (STT)');
    await click(tab('workflow'));
    expect(document.querySelector('.mon-network')).toBeTruthy();
    expect(document.querySelectorAll('.mon-edge').length).toBeGreaterThanOrEqual(3);
    await click(tab('logs'));
    expect(pageText()).toContain('Task reassigned');

    // A task's label opens its execution trace.
    await click(document.querySelector('.mon-task-link:not(:disabled)'));
    await waitUntil(() => pageText().includes('Execution trace'));
    expect(pageText()).toContain('Lifecycle');
  }, TIMEOUT);

  it('on Agent Monitoring the assistant never navigates away — the page stays on screen', async () => {
    await renderAppAt('/agent-monitor', () => pageText().includes('Communication timeline'));
    model.then(
      { calls: [call('open_page', { page: 'summary' })] },
      { content: 'The Summary is not open: Agent Monitoring stays on screen.' },
    );
    await say('open the summary');
    await wait(300);
    expect(router.state.location.pathname).toBe('/agent-monitor');
    expect(document.querySelector('.mon-standalone')).toBeTruthy();
    // The tool said so (no "Opened Summary"), and the monitor shows it.
    const call_ = store.getState().monitor.toolCalls.at(-1)!;
    expect(call_).toMatchObject({ tool: 'open_page', status: 'failed' });
    expect(call_.error).toMatch(/Agent Monitoring is on screen/);
  }, TIMEOUT);

  it('signing out clears the trail (it names patients)', async () => {
    await renderAppAt('/dashboard');
    model.then({ content: 'Hello.' });
    await say('hello there');
    expect(store.getState().monitor.events.length).toBeGreaterThan(0);
    const { logout } = await import('@/store/slices/authSlice');
    await store.dispatch(logout());
    await waitUntil(() => store.getState().monitor.events.length === 0);
    expect(store.getState().monitor.events).toEqual([]);
  }, TIMEOUT);
});

/** A model that never answers until it is stopped — like a stuck GPU. */
class HangingLLM implements ChatLLM {
  readonly name = 'hanging';
  calls = 0;
  chat(_messages: ChatMessage[], _tools: ToolSchema[], options?: { signal?: AbortSignal }): Promise<ChatTurn> {
    this.calls += 1;
    return new Promise((_, reject) => {
      const stop = () => reject(new DOMException('aborted', 'AbortError'));
      if (options?.signal?.aborted) stop();
      else options?.signal?.addEventListener('abort', stop);
    });
  }
}

describe('Agent Monitoring → Stop & clear', () => {
  it('stops every agent: the request in progress is cancelled, the one queued behind it never runs, every agent is idle and the monitor is clear', async () => {
    const llm = new HangingLLM();
    getVoiceController().reconfigure({ llm, stt: new FakeMic(), multiAgent: true });
    await renderAppAt('/agent-monitor', () => pageText().includes('Communication timeline'));
    const first = getVoiceController().handleTranscript('select tom baker and comment hello world on all patients normal records');
    const queued = getVoiceController().handleTranscript('and open the inbox');
    await waitUntil(() => store.getState().monitor.agents.master.status === 'running');
    expect(store.getState().monitor.requests[0]?.status).toBe('running');

    // The button asks first; "Stop & clear" in its confirmation does it.
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Stop & clear') && !b.closest('.ant-popover'));
    button!.click();
    await waitUntil(() => !!document.querySelector('.ant-popover .ant-btn-dangerous'));
    (document.querySelector('.ant-popover .ant-btn-dangerous') as HTMLButtonElement).click();

    await expect(first).resolves.toBeNull(); // cancelled
    await expect(queued).resolves.toBeNull(); // dropped
    await waitUntil(() => store.getState().monitor.events.length === 0);
    expect(llm.calls).toBe(1); // only the master's first call ever started
    const m = store.getState().monitor;
    expect(m.events).toEqual([]);
    expect(m.requests).toEqual([]);
    expect(Object.values(m.agents).every((a) => a.status === 'idle')).toBe(true);
    const voice = store.getState().voice;
    expect([voice.status, voice.taskGraph, voice.pendingConfirmation, voice.micActive]).toEqual(['idle', null, null, false]);
    expect(router.state.location.pathname).toBe('/agent-monitor');
    await waitUntil(() => pageText().includes('Stopped — every agent is idle'));
  }, TIMEOUT);

  it('a task waiting on the provider is dropped with its confirmation — nothing is saved', async () => {
    await renderAppAt('/agent-monitor', () => pageText().includes('Communication timeline'));
    store.dispatch(voiceActions.setPendingConfirmation({ kind: 'form', formId: 'medication', formTitle: 'New medication', summary: [], description: 'Save the new medication' }));
    store.dispatch(voiceActions.setTaskGraph({ id: 'g', request: 'add metformin', route: 'fast', createdAt: Date.now(), tasks: [{ id: 't1', agent: 'summary', instruction: 'Add metformin', dependsOn: [], executionType: 'WRITE', status: 'WAITING_FOR_USER', retryCount: 0, waitingFor: 'Save the new medication?' }] }));
    await getVoiceController().stopAll();
    expect(store.getState().voice.pendingConfirmation).toBeNull();
    expect(store.getState().voice.taskGraph).toBeNull();
    expect(Object.values(store.getState().monitor.agents).every((a) => a.status === 'idle')).toBe(true);
  }, TIMEOUT);
});

/**
 * Agent Monitoring in its own window: the app window's audit trail reaches the monitor window over a
 * BroadcastChannel — all of it when the monitor opens, then every event as it happens, and a sign-out.
 * Two stores stand for the two windows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import monitorReducer, { monitorActions } from '@/store/slices/monitorSlice';
import type { AppStore } from '@/store';
import type { MonitorEvent } from '@/types/monitor';
import { followMonitor, publishMonitor, requestStopAll, type FollowStatus } from '../monitor/channel';
import { MonitorRecorder } from '../monitor/recorder';

const windowStore = () => configureStore({ reducer: { monitor: monitorReducer } }) as unknown as AppStore;
const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
  return check();
};

const stops: Array<() => void> = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

describe('Agent Monitoring in its own window', () => {
  it('the monitor window gets what happened before it opened, then every event live, then the sign-out', async () => {
    const app = windowStore();
    const monitor = windowStore();
    stops.push(publishMonitor(app));
    const recorder = new MonitorRecorder((events: MonitorEvent[]) => app.dispatch(monitorActions.record(events)));

    // Before the monitor window opens.
    recorder.configured('multi', { master: { model: 'qwen3.5:4b', provider: 'This Computer' } });
    recorder.beginRequest('select harry white', 'multi');

    const statuses: FollowStatus[] = [];
    stops.push(followMonitor(monitor, (s) => statuses.push(s), { pingMs: 50, quietMs: 400 }));
    expect(await until(() => monitor.getState().monitor.requests.length === 1)).toBe(true);
    expect(statuses).toContain('live');
    expect(monitor.getState().monitor.models.master?.model).toBe('qwen3.5:4b');

    // Live: the request runs on in the app window.
    recorder.step({ id: 's1', type: 'tool', startedAt: Date.now(), call: { name: 'select_patient', arguments: { patient: 'Harry White' } } });
    recorder.step({ id: 's1', type: 'tool', startedAt: Date.now(), finishedAt: Date.now() + 5, call: { name: 'select_patient', arguments: { patient: 'Harry White' } }, result: { ok: true, message: 'Selected.' } });
    recorder.endRequest({ reply: 'Harry White is selected.' });
    expect(await until(() => monitor.getState().monitor.requests[0]?.status === 'completed')).toBe(true);
    // The same trail in both windows — nothing missing, nothing twice.
    expect(monitor.getState().monitor.events.map((e) => e.id)).toEqual(app.getState().monitor.events.map((e) => e.id));
    expect(monitor.getState().monitor.toolCalls).toEqual(app.getState().monitor.toolCalls);

    // Sign-out in the app window clears the monitor window too.
    app.dispatch(monitorActions.reset());
    expect(await until(() => monitor.getState().monitor.events.length === 0)).toBe(true);
  });

  it('Stop & clear in the monitor window stops the agents of the app window', async () => {
    let stopped = 0;
    stops.push(publishMonitor(windowStore(), { onStop: () => (stopped += 1) }));
    requestStopAll();
    expect(await until(() => stopped === 1)).toBe(true);
  });

  it('says when no app window is answering', async () => {
    const statuses: FollowStatus[] = [];
    stops.push(followMonitor(windowStore(), (s) => statuses.push(s), { pingMs: 50, quietMs: 200 }));
    expect(await until(() => statuses.includes('no-app'))).toBe(true);
    expect(statuses).not.toContain('live');
  });
});

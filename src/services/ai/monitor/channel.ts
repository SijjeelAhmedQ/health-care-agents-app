/**
 * Agent Monitoring in another browser tab or window (/agent-monitor opened there): the app's tab streams the
 * audit trail to it, so the agentic flow can be watched beside the app.
 *
 *   app tab (runs the agents)                            monitor tab (/agent-monitor)
 *   ─────────────────────────────                        ───────────────────────────────
 *                                 ◄── hello ───────────  opens: "who is running agents?"
 *   answers with everything ───── snapshot ──────────►   shows it
 *   every new batch of events ─── events ────────────►   applies them, live
 *   sign-out ──────────────────── reset ─────────────►   clears
 *                                 ◄── ping (every 5 s) ─
 *   ───────────────────────────── pong ──────────────►   "Live" while pongs keep coming
 *
 * One BroadcastChannel, same origin, nothing leaves the computer. A window that STARTED on /agent-monitor
 * follows; any other window publishes (and a window both runs agents and shows the page: it reads its own
 * store). With two app windows open, the monitor follows the first that answered until it goes quiet.
 */
import type { AppStore } from '@/store';
import { monitorActions, type MonitorState } from '@/store/slices/monitorSlice';
import type { MonitorEvent } from '@/types/monitor';

export const MONITOR_PATH = '/agent-monitor';
const NAME = 'careflow-agent-monitor';

/** This window was opened as the monitor (it follows another window's agents instead of publishing its own). */
export const STARTED_AS_MONITOR = typeof window !== 'undefined' && window.location.pathname.startsWith(MONITOR_PATH);

type Message =
  | { kind: 'hello'; from: string }
  | { kind: 'snapshot'; from: string; to?: string; state: MonitorState }
  | { kind: 'events'; from: string; events: MonitorEvent[] }
  | { kind: 'reset'; from: string }
  | { kind: 'ping'; from: string; to: string }
  | { kind: 'pong'; from: string; to: string }
  | { kind: 'stop'; from: string };

const windowId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function open(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(NAME);
  // Node (tests) would otherwise keep the process alive for it.
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel;
}

/**
 * A window that runs agents: send its audit trail to any monitor window, as it grows — and stop its agents
 * when a monitor window asks (`onStop`: Stop & clear). Returns a function that stops publishing.
 */
export function publishMonitor(store: AppStore, options: { onStop?: () => void } = {}): () => void {
  const channel = open();
  if (!channel) return () => undefined;
  const me = windowId();
  const post = (m: Message) => {
    try {
      channel.postMessage(m);
    } catch {
      // something in the trail could not be copied: the next snapshot carries it
    }
  };
  let lastId: string | undefined = store.getState().monitor.events.at(-1)?.id;
  const unsubscribe = store.subscribe(() => {
    const events = store.getState().monitor.events;
    const last = events.at(-1)?.id;
    if (last === lastId) return;
    const from = lastId ? events.findIndex((e) => e.id === lastId) : -1;
    if (!events.length) post({ kind: 'reset', from: me });
    else if (from >= 0 || !lastId) post({ kind: 'events', from: me, events: events.slice(from + 1) });
    else post({ kind: 'snapshot', from: me, state: store.getState().monitor }); // the oldest were dropped: start over
    lastId = last;
  });
  channel.onmessage = (e: MessageEvent<Message>) => {
    const m = e.data;
    if (m.kind === 'hello') post({ kind: 'snapshot', from: me, to: m.from, state: store.getState().monitor });
    if (m.kind === 'ping' && m.to === me) post({ kind: 'pong', from: me, to: m.from });
    if (m.kind === 'stop') options.onStop?.();
  };
  return () => {
    unsubscribe();
    channel.close();
  };
}

export type FollowStatus = 'connecting' | 'live' | 'no-app';

/** From a monitor window: ask every window that runs agents to stop them all and clear (Stop & clear). */
export function requestStopAll(): void {
  const channel = open();
  if (!channel) return;
  channel.postMessage({ kind: 'stop', from: 'monitor' } satisfies Message);
  setTimeout(() => channel.close(), 100);
}

/**
 * The monitor window: take the app window's trail into this window's store, and keep it live. `onStatus`
 * says whether an app window is answering. Returns a stop function.
 */
export function followMonitor(store: AppStore, onStatus: (status: FollowStatus) => void, options: { pingMs?: number; quietMs?: number } = {}): () => void {
  const channel = open();
  if (!channel) {
    onStatus('no-app');
    return () => undefined;
  }
  const pingMs = options.pingMs ?? 5000;
  const quietMs = options.quietMs ?? 12000;
  const me = windowId();
  let source: string | null = null;
  let heardAt = 0;
  const post = (m: Message) => channel.postMessage(m);
  channel.onmessage = (e: MessageEvent<Message>) => {
    const m = e.data;
    if (m.kind === 'snapshot' && (!source || m.from === source) && (!m.to || m.to === me)) {
      source = m.from;
      heardAt = Date.now();
      store.dispatch(monitorActions.replace(m.state));
      onStatus('live');
      return;
    }
    if (!source || m.from !== source) return; // not yet following, or another app window
    heardAt = Date.now();
    if (m.kind === 'events') {
      // Already in what the snapshot brought: skip, so nothing is counted twice.
      const have = new Set(store.getState().monitor.events.slice(-m.events.length).map((x) => x.id));
      const fresh = m.events.filter((x) => !have.has(x.id));
      if (fresh.length) store.dispatch(monitorActions.record(fresh));
    } else if (m.kind === 'reset') store.dispatch(monitorActions.reset());
    if (m.kind !== 'ping') onStatus('live');
  };
  post({ kind: 'hello', from: me });
  const timer = setInterval(() => {
    if (source && Date.now() - heardAt > quietMs) {
      source = null; // that window went away: follow whichever answers now
      onStatus('no-app');
    }
    if (source) post({ kind: 'ping', from: me, to: source });
    else post({ kind: 'hello', from: me });
  }, pingMs);
  const waiting = setTimeout(() => !source && onStatus('no-app'), Math.min(quietMs, 3000));
  return () => {
    clearInterval(timer);
    clearTimeout(waiting);
    channel.close();
  };
}

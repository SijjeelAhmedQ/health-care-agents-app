/**
 * Shared harness for the two integration tests that boot the real application.
 *
 * It deliberately does NOT use `act()`: a voice command drives React from the
 * outside (open the dialog, wait for it, fill it), so React has to flush
 * normally between awaits — exactly as it does in a browser. Assertions wait
 * for a condition instead of assuming a fixed number of ticks.
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '@/app/App';
import { router } from '@/app/router';
import { getVoiceController } from '@/services/ai/voiceController';
import { FakeMic, ScriptedLLM } from '@/services/ai/__tests__/fakes';

/** jsdom has neither of these; antd and Recharts both expect them. */
export function installBrowserStubs() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof window.ResizeObserver;
}

export const wait = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until the condition holds (or give up), the way the UI settles in a browser. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

/** Everything on screen, including anything rendered into a portal (dialogs). */
export const pageText = () => document.body.textContent ?? '';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

export async function renderAppAt(path: string, until?: () => boolean) {
  // Move the (singleton) router first, then mount: navigating into a tree that
  // is still mounting races with the router's first subscription.
  await router.navigate(path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(App));
  await wait(60);
  // React Router keeps the previous page on screen while a lazy chunk loads, and
  // the patient guard may redirect, so wait for the router to settle rather than
  // for one specific path.
  await waitUntil(() => router.state.navigation.state === 'idle');
  await waitUntil(() => !pageText().includes('Loading page…'));
  // A lazily imported page can take a moment more; wait for its own content.
  if (until) await waitUntil(until);
  await wait(200);
}

export async function unmountApp() {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  await wait(10);
}

/**
 * Put a scripted model (and a fake microphone) behind the real application's assistant.
 * The test then scripts which tools "the model" calls for each utterance.
 */
export function useScriptedModel(options: { planSteps?: boolean; multiAgent?: boolean } = {}): ScriptedLLM {
  const llm = new ScriptedLLM();
  // Multi-agent: tasks one after another, so a single script answers every agent in a known order.
  getVoiceController().reconfigure({ llm, stt: new FakeMic(), planSteps: options.planSteps, multiAgent: options.multiAgent, parallelReads: options.multiAgent ? false : undefined });
  return llm;
}

/** Speak to the assistant and let the resulting UI work settle. */
export async function say(transcript: string) {
  await getVoiceController().handleTranscript(transcript);
  await wait(150);
}

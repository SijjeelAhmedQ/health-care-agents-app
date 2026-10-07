/**
 * Imperative navigation bridge. The router installs its `navigate` function
 * here so non-React code (command executor, palette) can navigate without
 * touching window.location.
 */
import { primaryScroller } from '@/utils/scroll';

type NavigateFn =(to: string | number, options?: { replace?: boolean; state?: unknown }) => void;

let navigateImpl: NavigateFn | null = null;
let currentPathname = '/';

/**
 * Pages the app never leaves on its own. Agent Monitoring is watched while the agents work: an assistant
 * command ("open the patient's summary", selecting a patient, a dictated note) must not take the screen
 * away from it. Only the user's own clicks leave it.
 */
const STAY_ON = ['/agent-monitor'];
const pinned = () => typeof window !== 'undefined' && STAY_ON.some((p) => window.location.pathname.startsWith(p));

/** Scroll targets registered by pages (sections/anchors) so voice can "scroll to vitals". */
const scrollTargets = new Map<string, { label: string; element: HTMLElement }>();

export const NavigationRegistry = {
  install(fn: NavigateFn) {
    navigateImpl = fn;
  },
  setPathname(p: string) {
    currentPathname = p;
  },
  pathname: () => currentPathname,
  /** Navigate (false: the page on screen is one the app never leaves on its own — nothing happened). */
  navigate(to: string, options?: { replace?: boolean; state?: unknown }): boolean {
    if (pinned()) return false;
    if (!navigateImpl) throw new Error('Navigation not ready');
    navigateImpl(to, options);
    return true;
  },
  back() {
    if (pinned()) return;
    navigateImpl?.(-1);
  },
  /** The page on screen is one the app does not navigate away from by itself (Agent Monitoring). */
  isPinned: () => pinned(),
  registerScrollTarget(id: string, label: string, element: HTMLElement) {
    scrollTargets.set(id.toLowerCase(), { label, element });
    return () => scrollTargets.delete(id.toLowerCase());
  },
  scrollTo(target: string): boolean {
    const q = target.toLowerCase().trim();
    const hit =
      scrollTargets.get(q) ??
      [...scrollTargets.values()].find((t) => t.label.toLowerCase().includes(q) || q.includes(t.label.toLowerCase()));
    if (!hit) return false;
    hit.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  },
  scrollTargets: () => [...scrollTargets.entries()].map(([id, t]) => ({ id, label: t.label })),
  scrollBy(direction: 'up' | 'down' | 'top' | 'bottom') {
    // The page itself never scrolls — move whichever region is scrolling.
    const el = primaryScroller();
    const step = (el.clientHeight || window.innerHeight) * 0.7;
    if (direction === 'top') el.scrollTo({ top: 0, behavior: 'smooth' });
    else if (direction === 'bottom') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollBy({ top: direction === 'down' ? step : -step, behavior: 'smooth' });
  },
};

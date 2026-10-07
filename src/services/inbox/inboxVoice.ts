/**
 * The bridge between the voice assistant and the mounted Inbox page.
 *
 * The Inbox keeps its list, filters and open item in page state, and its
 * filing goes through one handler (with the Undo toast). Rather than copy any
 * of that, the page registers a controller here when it mounts; the command
 * executor only ever calls these methods — the same handlers the buttons,
 * rows and keyboard shortcuts use. No DOM queries.
 */
import type { InboxItem, InboxView } from './inboxModel';

export interface InboxVoiceSnapshot {
  view: InboxView;
  /** The list exactly as it is on screen: filtered, searched and sorted. Position 1 is items[0]. */
  items: InboxItem[];
  openItem?: InboxItem;
  /** Index of the open item in `items`, or -1 when it is open but filtered out (or nothing is open). */
  openIndex: number;
  isFiled(id: string): boolean;
  query: string;
  /** When set, the Inbox shows only this patient's items. */
  scopePatientId: string | null;
  /** Rows ticked in the list. */
  checkedIds: string[];
  loading: boolean;
}

export interface InboxVoiceController {
  snapshot(): InboxVoiceSnapshot;
  setView(view: InboxView): void;
  /** Type into the Inbox search box (an empty string clears it). */
  setQuery(query: string): void;
  open(item: InboxItem): void;
  close(): void;
  /** The page's own filing handler — same toast, same Undo. */
  file(ids: string[], file: boolean): void;
  setPatientScope(patientId: string | null): void;
  /**
   * Show exactly these records (a summary of "all normal records"): every other filter cleared, then these —
   * Normal / Abnormal, filed / unfiled, only those needing attention.
   */
  showOnly(filter: { status?: 'Normal' | 'Abnormal'; filed?: 'all' | 'filed' | 'unfiled'; attention?: boolean }): void;
}

type Listener = () => void;

class InboxVoiceRegistryImpl {
  private controller: InboxVoiceController | undefined;

  register(controller: InboxVoiceController): () => void {
    this.controller = controller;
    return () => {
      if (this.controller === controller) this.controller = undefined;
    };
  }

  get(): InboxVoiceController | undefined {
    return this.controller;
  }
}

export const InboxVoiceRegistry = new InboxVoiceRegistryImpl();

// ---- preferences ------------------------------------------------------------

const CONFIRM_KEY = 'careflow.inbox.voice.confirmFiling';
const listeners = new Set<Listener>();

/**
 * Whether "file this" asks "File this record?" before filing. On by default:
 * a misheard "file" should never change the queue without a yes.
 */
export function getConfirmFiling(): boolean {
  try {
    return localStorage.getItem(CONFIRM_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setConfirmFiling(on: boolean) {
  try {
    localStorage.setItem(CONFIRM_KEY, String(on));
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
  listeners.forEach((l) => l());
}

export function subscribeConfirmFiling(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- wording ----------------------------------------------------------------

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export const ordinalWord = (n: number) => ORDINALS[n - 1] ?? `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** What a record of a category is called in a sentence. */
export const inboxNoun: Record<InboxView, { one: string; many: string }> = {
  all: { one: 'record', many: 'records' },
  lab: { one: 'lab result', many: 'lab results' },
  radiology: { one: 'radiology record', many: 'radiology records' },
  referral: { one: 'referral', many: 'referrals' },
  discharge: { one: 'discharge summary', many: 'discharge summaries' },
};

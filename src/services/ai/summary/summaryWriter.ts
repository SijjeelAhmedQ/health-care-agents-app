/**
 * The Summary Agent's model writes the text — and nothing else: no tools are offered, so any model can, MedGemma
 * included. It is given the facts the app gathered (summaryFacts.ts) and its skill (src/agents/summary-agent).
 * When it does not answer, answers with nothing usable, or there is nothing to summarize, the text is written
 * from the facts alone: a summary is never missing because a model was slow or down.
 */
import type { ChatLLM, ChatMessage } from '../providers/llm';
import { agentPrompt } from '../agents/skills';
import { factsText, ruleSummary, type InboxRow, type SummaryFacts } from './summaryFacts';

export interface WrittenSummary {
  text: string;
  /** 'model': the Summary Agent's model wrote it; 'rules': written from the facts (no model, or it failed). */
  source: 'model' | 'rules';
  /** Why the model's text was not used — or what of it the Safety Agent took out. */
  note?: string;
  /** Sentences the Safety Agent took out of the model's text: claims the data does not support. */
  removed?: string[];
  /** For the trace: what the model was asked, and what it answered. */
  request?: ChatMessage[];
  answer?: string;
  ms?: number;
}

/** The longest summary kept — a model that runs on is cut at a sentence. */
const MAX_CHARS = 1600;

/** The message the model writes from. */
export function summaryMessages(request: string, facts: SummaryFacts): ChatMessage[] {
  return [
    { role: 'system', content: agentPrompt('summary') },
    {
      role: 'user',
      content: `REQUEST: ${request.trim() || 'Summarize.'}\nWHAT: ${facts.title} — ${facts.scope}\nDATA\n${factsText(facts)}\n\nNow write the summary of this DATA for the provider: 2 to 6 short sentences in your own words — what needs attention first, then the rest in brief. Use only the facts and numbers above; do not copy the lines.`,
    },
  ];
}

/** A model's answer, made fit for the panel: no thinking, no markdown, no preamble. Empty when unusable. */
export function cleanSummary(raw: string): string {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  text = text.replace(/^(here(?:'s| is) (?:a |the |your )?(?:brief |short )?summary[^:\n]*:\s*)/i, '').trim();
  if (text.length > MAX_CHARS) {
    const cut = text.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    text = `${cut.slice(0, end > 200 ? end + 1 : MAX_CHARS).trim()}`;
  }
  return text.length >= 12 ? text : '';
}

/**
 * Why a model's text cannot be shown as the summary of these facts — or null when it can: it says there is
 * nothing when there is, it gives a number the data does not hold, or it only copies the data back.
 */
export function unusable(text: string, facts: SummaryFacts): string | null {
  const data = factsText(facts);
  // "There are no normal Inbox records" when there are — not "no appointments today" when today's count is 0.
  if (!facts.empty && /\b(there (are|is) no|no) (\w+ ){0,3}(records?|items?|entries|data)\b|\bnothing to summari[sz]e\b|\bnone (found|listed)\b/i.test(text)) return 'it says there is nothing, but there is';
  const numbers = (text.match(/\b\d+(?:\.\d+)?\b/g) ?? []).filter((n) => !data.includes(n));
  if (numbers.length) return `it gives numbers the data does not hold (${[...new Set(numbers)].slice(0, 4).join(', ')})`;
  // Overlapping counts written as if they were separate groups ("14 flagged for attention and 12 abnormal" of 25).
  const total = Number(facts.stats.find((s) => s.label === 'Records')?.value ?? NaN);
  const parts = [facts.stats.find((s) => s.label === 'Abnormal')?.value, facts.stats.find((s) => s.label === 'Need attention')?.value].map(Number);
  if (Number.isFinite(total) && parts.every((n) => n > 0) && parts[0] + parts[1] > total) {
    const both = new RegExp(`\\b${parts[1]}\\b[^.]*\\battention\\b[^.]*\\b(and|while|with)\\b[^.]*\\b${parts[0]}\\b[^.]*\\babnormal|\\b${parts[0]}\\b[^.]*\\babnormal\\b[^.]*\\b(and|while|with)\\b[^.]*\\b${parts[1]}\\b[^.]*\\battention`, 'i');
    if (both.test(text) && !/\b(of (them|these|which)|including|includ|all \d+ abnormal|overlap|both)\b/i.test(text)) return 'it gives overlapping counts as separate groups';
  }
  const lines = text.split('\n').map((l) => l.replace(/^[-•]\s*/, '').trim()).filter((l) => l.length > 12);
  const copied = lines.filter((l) => data.includes(l)).length;
  if (lines.length >= 3 && copied / lines.length > 0.5) return 'it only copies the data back';
  if (/^(in brief|records|needs attention|today's schedule):/im.test(text)) return 'it only copies the data back';
  return null;
}

/** A claim that something is urgent, or more urgent than the rest. */
const URGENCY = /\b(?:most |more |very )?urgent(?:ly)?\b|\bstat\b|\bemergency\b|\bhigh[- ]priority\b|\btop priority\b|\bprioriti[sz]e[ds]?\b|\bcritical(?:ly)?\b|\bimmediate(?:ly)?\b/i;
/**
 * "None of them is urgent", "no record is marked STAT" — saying something is NOT urgent claims nothing. The "not"
 * must stand right before the word ("the most urgent is Lucy Young's referral, not yet filed" still claims it).
 */
const NEGATED = /\b(?:no|none|not|nothing|neither|nor|without)\b(?:\W+\w+){0,4}?\W+(?:urgent|stat|emergency|high[- ]priority|top priority|critical|immediate)/i;
/** The words that name an Inbox category in a sentence. */
const CATEGORY_WORDS: Array<[InboxRow['category'], RegExp]> = [
  ['lab', /\b(labs?|lab results?|tests?|panels?|alt|ldl|hba1c|urinalysis|liver function|lipid|blood)\b/i],
  ['radiology', /\b(radiology|imaging|scans?|ct|mri|pet|x-?rays?|ultrasound|mammograph\w*)\b/i],
  ['referral', /\breferrals?\b/i],
  ['discharge', /\bdischarge\b/i],
];

/** A summary split into sentences — not after a title ("Dr. Lucy White") — and its list lines kept apart. */
function sentencesOf(line: string): string[] {
  return line
    .split(/(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|vs|No|e\.g|i\.e|approx)\.)(?<=[.!?])\s+(?=[A-Z0-9“"(-])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The Safety Agent on what a summary calls urgent: only a record whose own priority is urgent (STAT, Urgent,
 * Emergency, High) may be called so — a model never ranks records by its own judgement. A sentence that calls a
 * patient's records urgent when none of that patient's are (or, naming no one, a category with no urgent record,
 * or anything at all when nothing is urgent) is taken out; the rest of the summary stays.
 */
export function unsupportedUrgency(text: string, facts: SummaryFacts): { text: string; removed: string[] } {
  const rows = facts.inboxRows;
  if (!rows?.length) return { text, removed: [] };
  const urgent = rows.filter((r) => r.urgent);
  const patients = [...new Set(rows.map((r) => r.patient))];
  const supported = (sentence: string) => {
    const lower = sentence.toLowerCase();
    const named = patients.filter((p) => lower.includes(p.toLowerCase()));
    if (named.length) return named.every((p) => urgent.some((r) => r.patient === p));
    const kinds = CATEGORY_WORDS.filter(([, re]) => re.test(sentence)).map(([kind]) => kind);
    if (kinds.length) return kinds.every((k) => urgent.some((r) => r.category === k));
    return urgent.length > 0;
  };
  const removed: string[] = [];
  const lines = text.split('\n').map((line) => {
    const kept = sentencesOf(line).filter((s) => {
      if (!URGENCY.test(s) || NEGATED.test(s) || supported(s)) return true;
      removed.push(s);
      return false;
    });
    return { was: line.trim(), now: kept.join(' ') };
  });
  if (!removed.length) return { text, removed };
  return { text: lines.filter((l) => l.now || !l.was).map((l) => l.now).join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

export async function writeSummary(llm: ChatLLM | null, request: string, facts: SummaryFacts, signal?: AbortSignal): Promise<WrittenSummary> {
  if (facts.empty) return { text: ruleSummary(facts), source: 'rules', note: 'Nothing to summarize.' };
  if (!llm) return { text: ruleSummary(facts), source: 'rules', note: 'No model for the Summary Agent.' };
  const messages = summaryMessages(request, facts);
  const started = Date.now();
  try {
    const turn = await llm.chat(messages, [], { maxTokens: 700, signal });
    const text = cleanSummary(turn.content ?? '');
    if (!text) return { text: ruleSummary(facts), source: 'rules', note: 'The model wrote nothing usable.', request: messages, answer: turn.content, ms: Date.now() - started };
    const why = unusable(text, facts);
    if (why) return { text: ruleSummary(facts), source: 'rules', note: `The model's text was not used: ${why}.`, request: messages, answer: turn.content, ms: Date.now() - started };
    // What it calls urgent must be what the records' own priority says — anything else is taken out.
    const checked = unsupportedUrgency(text, facts);
    if (checked.removed.length) {
      const note = `The Safety Agent took out what the data does not support: ${checked.removed.map((s) => `"${s}"`).join(' ')}`;
      const left = cleanSummary(checked.text);
      if (!left) return { text: ruleSummary(facts), source: 'rules', note: `The model's text was not used: ${note}`, removed: checked.removed, request: messages, answer: turn.content, ms: Date.now() - started };
      return { text: left, source: 'model', note, removed: checked.removed, request: messages, answer: turn.content, ms: Date.now() - started };
    }
    return { text, source: 'model', request: messages, answer: turn.content, ms: Date.now() - started };
  } catch (e) {
    if (signal?.aborted || (e as Error).name === 'AbortError') throw e;
    return { text: ruleSummary(facts), source: 'rules', note: `The model did not answer: ${(e as Error).message}`, request: messages, ms: Date.now() - started };
  }
}

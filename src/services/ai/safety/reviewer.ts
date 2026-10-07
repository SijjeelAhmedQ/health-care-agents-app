/**
 * The Safety Agent's model — a second look at a risky call, for what rules cannot see.
 *
 * The rules (safetyAgent.ts) already made sure every value in a call was SAID. The reviewer checks it was said
 * FOR THIS: "not metformin — amlodipine", a dose said for one drug put on another, the wrong one of several
 * patients, a delete for "keep it". It can only stop a call and ask the provider — it never adds, changes or
 * completes a value — and a problem counts only when it quotes the provider's own words, so a model cannot
 * invent one either. A reviewer that fails or is slow lets the call through: the rules have already run.
 */
import type { SafetyFinding, ToolCall } from '@/types/ai';
import type { ChatLLM, ChatMessage, ToolSchema } from '../providers/llm';
import { agentPrompt } from '../agents/skills';
import { FieldRegistry } from '@/registry/fieldRegistry';

export const REVIEW_TOOL = 'report_review';

const REVIEW_SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: REVIEW_TOOL,
    description: "Report whether the CALL does what the provider SAID. ok: true when it does. Otherwise one problem per mismatch, each quoting the provider's exact words that show it.",
    parameters: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: 'true when the call does what was said' },
        problems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', description: 'What is wrong, as the call names it: "medication 2 · dosage", "patient", "action"' },
              quote: { type: 'string', description: "The provider's exact words that show it, copied from SAID" },
              issue: { type: 'string', description: 'What does not match, in a few words' },
            },
            required: ['field', 'quote', 'issue'],
          },
        },
      },
      required: ['ok'],
    },
  },
};

/** Words that turn what follows around: "not", "instead", "except" … — where a model most often goes wrong. */
const TURNS = /\b(not|no|don'?t|never|instead|except|without|rather|wrong|cancel|stop|remove)\b/i;
const WRITES = /^(add_|create_patient$|update_record$|delete_record$|delete_patient$|edit_patient$|(cancel|reschedule)_(my|patient)_appointment$)/;
const CHANGES = /^(update_record|delete_record|delete_patient|edit_patient|(cancel|reschedule)_(my|patient)_appointment)$/;

/**
 * Which calls get a second look: a change or a delete; several records or patients in one call; and any write
 * or selection while what was said turns something around ("not …", "instead …"). Everything else is the rules'.
 */
export function needsReview(call: ToolCall, said: readonly string[]): boolean {
  // Only where the words turn something around ("not metformin — amlodipine", "except Lily"): everything else
  // — which values were said, for which record and patient — the rules have checked, deterministically. A
  // model second-guessing a complete request only asks the provider what they already said.
  if (!WRITES.test(call.name) && call.name !== 'select_patient' && !CHANGES.test(call.name)) return false;
  return TURNS.test(said.join(' '));
}

/**
 * A problem stands only when the provider's words turn something around AND the call holds what they turned
 * away: "not metformin" with metformin in the call. "Do not change anything for the other patients" with no
 * other patient in the call is no problem.
 */
function turnedAway(quote: string, call: ToolCall): boolean {
  const q = norm(quote);
  const m = q.match(/\b(not|no|don t|dont|never|instead of|except|without|rather than)\b\s+(.*)$/);
  if (!m) return false;
  const values = norm(JSON.stringify(call.arguments ?? {}));
  const words = m[2].split(' ').filter((w) => w.length >= 4 && !['change', 'anything', 'other', 'patients', 'patient', 'that', 'this', 'them', 'those', 'these', 'want', 'need'].includes(w));
  return words.some((w) => values.includes(w));
}

export interface ReviewProblem {
  field: string;
  quote: string;
  issue: string;
}

export type ReviewOutcome = { status: 'ok' } | { status: 'problems'; problems: ReviewProblem[] } | { status: 'skipped'; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class SafetyReviewer {
  constructor(
    private readonly llm: ChatLLM,
    private readonly timeoutMs = 30_000,
  ) {}

  get modelName() {
    return this.llm.name;
  }

  async review(call: ToolCall, said: readonly string[]): Promise<ReviewOutcome> {
    const messages: ChatMessage[] = [
      { role: 'system', content: agentPrompt('safety') },
      {
        role: 'user',
        content: `SAID (the provider's words, from speech recognition):\n${said.map((s) => `- ${s}`).join('\n')}\n\nCALL: ${call.name} ${JSON.stringify(call.arguments)}\n\nDoes the call do what the provider said? Call ${REVIEW_TOOL}.`,
      },
    ];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const turn = await this.llm.chat(messages, [REVIEW_SCHEMA], { signal: abort.signal, maxTokens: 400 });
      const report = turn.toolCalls.find((c) => c.name === REVIEW_TOOL)?.arguments as { ok?: boolean; problems?: unknown } | undefined;
      if (!report) return { status: 'skipped', reason: 'the reviewer did not report' };
      const heard = norm(said.join(' '));
      // A problem stands only on the provider's own words: a quote that is not in SAID is the model's, not theirs.
      const problems = (Array.isArray(report.problems) ? report.problems : [])
        .map((p) => p as Partial<ReviewProblem>)
        .filter((p): p is ReviewProblem => typeof p.field === 'string' && typeof p.quote === 'string' && typeof p.issue === 'string')
        .filter((p) => norm(p.quote).length >= 3 && heard.includes(norm(p.quote)) && turnedAway(p.quote, call));
      return problems.length ? { status: 'problems', problems } : { status: 'ok' };
    } catch (e) {
      return { status: 'skipped', reason: abort.signal.aborted ? `no answer within ${Math.round(this.timeoutMs / 1000)} s` : (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The question for what the reviewer found — a template around the provider's own words, never a suggestion. */
export function reviewQuestion(problems: ReviewProblem[]): string {
  // "medication 2 · dosage" → "medication's dosage", by the form's own label; anything else as it was named.
  const what = (p: ReviewProblem) => {
    const m = p.field.match(/^([a-z_]+)(?:\s+\d+)?\s*·\s*([A-Za-z_]+)$/);
    const label = m ? FieldRegistry.resolveField(m[1], m[2])?.label.toLowerCase() : undefined;
    if (m && label) return label.startsWith(m[1]) ? label : `${m[1]}'s ${label}`;
    return p.field.replace(/\s*·\s*/g, ' ').replace(/\s+\d+\b/g, '').trim();
  };
  const first = problems[0];
  const more = problems.length > 1 ? ` (and the ${what(problems[1])})` : '';
  return `Just to make sure I get this right: you said "${first.quote}". Could you tell me what the ${what(first)}${more} should be?`;
}

export const reviewFindings = (tool: string, problems: ReviewProblem[]): SafetyFinding[] =>
  problems.map((p) => ({ tool, field: p.field, value: '', action: 'asked', reason: `the reviewer: ${p.issue} (said: "${p.quote}")` }));

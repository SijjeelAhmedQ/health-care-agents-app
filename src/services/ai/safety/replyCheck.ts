/**
 * The Safety Agent's last word: every reply is checked before the provider sees or hears it.
 *
 * The tool calls are checked as they are made (safetyAgent.ts). What the assistant then SAYS about them is
 * checked here — by rules, so it costs nothing and runs on every reply, whatever the model:
 *
 *   saved, but not saved      "The task has been created" while the task waits for the provider's yes
 *                             → that sentence goes; the reply says nothing is saved until they confirm
 *   the wrong patient         the form waiting is Tom Baker's, the reply speaks of Luke King
 *                             → the reply says what really waits, and for whom
 *   a dose nobody gave        "500 mg" that is neither in the provider's words nor in anything the app
 *                             returned or shows → that sentence goes
 *
 * Nothing here adds a fact: a sentence is only ever taken out, or the reply replaced by what the app itself
 * holds (the form's own title and patient).
 */

export interface ReplyContext {
  /** What the provider said for this request (every utterance of it). */
  said: string[];
  /** Everything the app returned or shows for it: tool arguments and results, what waits, a summary's data. */
  facts: string;
  /** What waits for the provider's yes after this reply — the form's title and patient — or null. */
  pending: { kind: string; title: string; patient?: string | null } | null;
  /** Something was actually saved, deleted, filed or booked during this request. */
  saved: boolean;
  /** Every patient's full name (to see which ones a reply speaks of). */
  patients: string[];
}

export interface ReplyFinding {
  issue: 'claims-saved' | 'wrong-patient' | 'unknown-value';
  quote: string;
}

export interface ReplyVerdict {
  reply: string;
  findings: ReplyFinding[];
}

/** "has been created", "was saved successfully", "is now booked" — something done. */
const DONE =
  /\b(has|have|had) been (successfully )?(created|added|saved|booked|scheduled|deleted|removed|updated|changed|filed|cancell?ed|recorded|prescribed)\b|\b(was|were|is now|are now) (successfully )?(created|added|saved|booked|scheduled|deleted|removed|updated|changed|filed|cancell?ed|recorded|prescribed)\b|\b(created|added|saved|booked|scheduled|deleted|updated|recorded) successfully\b|\bsuccessfully (created|added|saved|booked|scheduled|deleted|updated|recorded)\b/i;

/** A dose or measurement: a number with its unit ("500 mg", "8.1%", "20 units"). */
const QUANTITY = /\b(\d+(?:[.,]\d+)?)\s?(mg|mcg|µg|g|kg|ml|mL|l|units?|iu|%|mmol\/l|mg\/dl|mmhg|bpm|tablets?|capsules?|puffs?|drops?)(?![a-z])/gi;

/** A reply split into sentences (and list lines), with their separators kept for putting it back together. */
function sentences(reply: string): string[] {
  // Not after a title or an abbreviation: "booked with Dr. Lucy White." is one sentence.
  return reply
    .split(/(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|vs|No|e\.g|i\.e|approx)\.)(?<=[.!?])\s+(?=[A-Z0-9“"(-])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

export function checkReply(reply: string, ctx: ReplyContext): ReplyVerdict {
  const findings: ReplyFinding[] = [];
  if (!reply.trim()) return { reply, findings };
  const known = norm(`${ctx.said.join(' ')} ${ctx.facts}`);

  // 1. The patient: what waits is one patient's — a reply speaking only of another misleads the provider.
  const waitingFor = ctx.pending?.patient?.trim();
  if (waitingFor) {
    const named = ctx.patients.filter((p) => norm(reply).includes(norm(p)));
    if (named.length && !named.some((p) => norm(p) === norm(waitingFor))) {
      findings.push({ issue: 'wrong-patient', quote: named.join(', ') });
      const title = ctx.pending!.title.replace(/^(add|new)\s+/i, '');
      return {
        reply: `The ${title.toLowerCase()} for ${waitingFor} is ready — nothing is saved yet. Review it, then say “save it” to confirm, or cancel.`,
        findings,
      };
    }
  }

  let parts = sentences(reply);
  // 2. Saved, but not saved: while it still waits for the yes, nothing of it is done.
  if (ctx.pending && !ctx.saved) {
    const kept = parts.filter((s) => {
      if (!DONE.test(s)) return true;
      findings.push({ issue: 'claims-saved', quote: s });
      return false;
    });
    if (kept.length !== parts.length) {
      const asks = kept.some((s) => /\b(confirm|save it|review)\b/i.test(s));
      parts = [...kept, ...(asks ? [] : [`Nothing is saved yet — review it, then say “save it” to confirm, or cancel.`])];
    }
  }

  // 3. A dose or measurement nobody gave and nothing in the app holds.
  parts = parts.filter((s) => {
    const unknown = [...s.matchAll(QUANTITY)].filter((m) => !known.includes(m[1].replace(',', '.')) && !known.includes(m[1]));
    if (!unknown.length) return true;
    findings.push({ issue: 'unknown-value', quote: s });
    return false;
  });

  if (!findings.length) return { reply, findings };
  const fixed = parts.join(' ').trim();
  return { reply: fixed || 'Done — nothing more to report.', findings };
}

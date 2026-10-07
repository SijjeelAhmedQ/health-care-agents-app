/**
 * The Safety Agent checks every reply before the provider sees or hears it (safety/replyCheck.ts): no "saved"
 * for what still waits, no other patient than the one whose record waits, no dose nobody gave.
 */
import { describe, expect, it } from 'vitest';
import { checkReply, type ReplyContext } from '../safety/replyCheck';

const ctx = (over: Partial<ReplyContext> = {}): ReplyContext => ({
  said: ['crate task for blood pressure monitoring'],
  facts: JSON.stringify({ title: 'Blood pressure monitoring', patient: 'Tom Baker (MRN-100075)' }),
  pending: { kind: 'form', title: 'Add Task', patient: 'Tom Baker' },
  saved: false,
  patients: ['Tom Baker', 'Luke King', 'Chloe Bell'],
  ...over,
});

describe('the Safety Agent checks every reply before it is shown', () => {
  it('a reply that says only what was done passes as it is', () => {
    const reply = 'The task form for Tom Baker is ready. Please review it and confirm to save it.';
    expect(checkReply(reply, ctx())).toEqual({ reply, findings: [] });
  });

  it('"The task has been created" while it waits for the yes: that sentence goes — nothing is saved yet', () => {
    const verdict = checkReply('The task form for Tom Baker is ready. The task has been created with: Task: blood pressure monitoring.', ctx());
    expect(verdict.findings.map((f) => f.issue)).toEqual(['claims-saved']);
    expect(verdict.reply).toBe('The task form for Tom Baker is ready. Nothing is saved yet — review it, then say “save it” to confirm, or cancel.');
  });

  it('once it really was saved, "has been created" is true — and stays', () => {
    const reply = 'The task has been created for Tom Baker.';
    expect(checkReply(reply, ctx({ pending: null, saved: true })).findings).toEqual([]);
  });

  it('Tom Baker’s task waits, the reply speaks of Luke King: replaced by what really waits, and for whom', () => {
    const verdict = checkReply("The task form for Luke King's blood pressure monitoring task is ready.", ctx());
    expect(verdict.findings).toEqual([{ issue: 'wrong-patient', quote: 'Luke King' }]);
    expect(verdict.reply).toBe('The task for Tom Baker is ready — nothing is saved yet. Review it, then say “save it” to confirm, or cancel.');
  });

  it('a dose nobody gave and the app does not hold: that sentence goes', () => {
    const verdict = checkReply('Metformin is ready to add. I suggest 500 mg twice daily.', ctx({ said: ['add metformin to Tom Baker'], facts: '{"medicationName":"Metformin"}', pending: { kind: 'form', title: 'Add Medication', patient: 'Tom Baker' } }));
    expect(verdict.findings.map((f) => f.issue)).toEqual(['unknown-value']);
    expect(verdict.reply).toBe('Metformin is ready to add.');
  });

  it('a dose the provider said (or the form holds) stays', () => {
    const reply = 'Metformin 500 mg twice daily is ready — confirm to save it.';
    expect(checkReply(reply, ctx({ said: ['add metformin 500 mg twice daily'], pending: { kind: 'form', title: 'Add Medication', patient: 'Tom Baker' } })).findings).toEqual([]);
  });

  it('a title is not the end of a sentence — "booked with Dr. Lucy White." goes as one, leaving nothing behind', () => {
    const verdict = checkReply('The follow-up has been booked with Dr. Lucy White. Review the care plan and confirm to save all 8 records.', ctx({ pending: { kind: 'form', title: 'Care plan', patient: null } }));
    expect(verdict.reply).toBe('Review the care plan and confirm to save all 8 records.');
  });
});

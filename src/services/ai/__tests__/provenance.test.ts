/**
 * Provenance: the Safety Agent's "was this said?" — numbers, doses, frequencies, dates, times and words
 * read the way providers say them, and nothing accepted that was not.
 */
import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { compactSaid, corpusOf, coverage, datesSaid, digitsSaid, doseSaid, durationSaid, frequenciesSaid, normalize, optionSaid, positionSaid, timesSaid, wordSaid } from '../safety/provenance';

const TODAY = dayjs('2026-10-01'); // a Thursday

describe('normalising what was said', () => {
  it('number words become digits, and "500mg" / "3pm" / "follow-up" split the way they are read', () => {
    expect(normalize('five hundred and five')).toBe('505');
    expect(normalize('twenty five mg')).toBe('25 mg');
    expect(normalize('one hundred twelve')).toBe('112');
    expect(normalize('two thousand five')).toBe('2005');
    expect(normalize('one two three zero five')).toBe('1 2 3 0 5'); // digit by digit (a phone number)
    expect(normalize('Metformin 500mg twice a day')).toBe('metformin 500 mg twice a day');
    expect(normalize('follow-up on 2026-10-06 at 3pm')).toBe('follow up on 2026-10-06 at 3 pm');
  });
});

describe('was it said?', () => {
  const said = corpusOf(['add metformin five hundred milligrams twice a day for a week, recall in two weeks, follow up next tuesday at 3 pm']);

  it('a dose: the amount AND its unit', () => {
    expect(doseSaid('500 mg', said)).toBe(true);
    expect(doseSaid('500 mcg', said)).toBe(false); // another unit
    expect(doseSaid('850 mg', said)).toBe(false); // another amount
    expect(doseSaid('500 mg', corpusOf(['add metformin 500']))).toBe(false); // no unit said: asked, not assumed
  });

  it('a frequency, by any of its names — and "twice daily" is never also "daily"', () => {
    expect([...frequenciesSaid(said)]).toEqual(['Twice daily']);
    expect([...frequenciesSaid(corpusOf(['bid']))]).toEqual(['Twice daily']);
    expect([...frequenciesSaid(corpusOf(['once a day at bedtime']))].sort()).toEqual(['At bedtime', 'Once daily']);
    expect([...frequenciesSaid(corpusOf(['add a medication']))]).toEqual([]);
  });

  it('dates from the words: weekdays, "in two weeks", explicit dates — not others', () => {
    const dates = datesSaid(said, TODAY);
    expect(dates.has('2026-10-06')).toBe(true); // next Tuesday
    expect(dates.has('2026-10-15')).toBe(true); // in two weeks
    expect(dates.has('2026-10-08')).toBe(true); // a week
    expect(dates.has('2026-10-07')).toBe(false);
    expect(datesSaid(corpusOf(['on october 20th']), TODAY).has('2026-10-20')).toBe(true);
    expect(datesSaid(corpusOf(['on 2026-11-02']), TODAY).has('2026-11-02')).toBe(true);
    expect(datesSaid(corpusOf(['tomorrow']), TODAY).has('2026-10-02')).toBe(true);
    expect(datesSaid(corpusOf(['add a recall']), TODAY).size).toBe(0);
  });

  it('times: "3 pm" is 15:00; "at 3" may be either; nothing else', () => {
    expect([...timesSaid(said)]).toEqual(['15:00']);
    expect([...timesSaid(corpusOf(['at 3']))].sort()).toEqual(['03:00', '15:00']);
    expect(timesSaid(corpusOf(['half past ten'])).has('10:30')).toBe(true);
    expect(timesSaid(corpusOf(['book a follow up'])).size).toBe(0);
  });

  it('a duration, in any unit: "for a week" is 7 days', () => {
    expect(durationSaid('7 days', said)).toBe(true);
    expect(durationSaid('1 week', said)).toBe(true);
    expect(durationSaid('5 days', said)).toBe(false);
  });

  it('words: the same word, its stem, a misheard spelling — never a different drug', () => {
    expect(wordSaid('metformin', corpusOf(['add metforman']), true)).toBe(true); // speech recognition
    expect(wordSaid('monitoring', corpusOf(['monitor his blood pressure']))).toBe(true);
    expect(wordSaid('valsartan', corpusOf(['add losartan']), true)).toBe(false);
    expect(wordSaid('panadol', said, true)).toBe(false);
    expect(coverage('Blood pressure monitoring', corpusOf(['a task to check bp']))).toMatchObject({ unsaid: ['monitoring'] });
    expect(coverage('Blood pressure check', corpusOf(['a task to check bp'])).share).toBe(1); // "bp" is blood pressure
  });

  it('options with their own words, list positions, digits and codes', () => {
    expect(optionSaid('route', 'Oral', corpusOf(['take it by mouth']))).toBe(true);
    expect(optionSaid('route', 'Intravenous', corpusOf(['take it by mouth']))).toBe(false);
    expect(optionSaid('gender', 'Female', corpusOf(['she is 45']))).toBe(true);
    expect(positionSaid(2, corpusOf(['select the second one']))).toBe(true);
    expect(positionSaid(1, corpusOf(['select patient']))).toBe(false);
    expect(digitsSaid('555-0123', corpusOf(['phone five five five zero one two three']))).toBe(true);
    expect(digitsSaid('555-0199', corpusOf(['phone five five five zero one two three']))).toBe(false);
    expect(compactSaid('I10', corpusOf(['code i 10']))).toBe(true);
  });
});

/**
 * Provenance — where a value came from. The Safety Agent lets a value reach the application only when it
 * can be traced to what the provider SAID (every utterance of the request, the clarifications included),
 * to the application's own data, or to the application's own defaults. This module is the "said" part:
 * the provider's words, normalised, and one check per kind of value.
 *
 *   "add metformin five hundred milligrams twice a day for a week"
 *     → numbers 500, 7 (a week) · units mg · frequencies Twice daily · durations 7 days
 *
 * Every check answers one question — "was this said?" — and never proposes a value of its own.
 * Pure functions; no model, no store.
 */
import dayjs, { type Dayjs } from 'dayjs';

// ------------------------------------------------------------------------------------------- normalising

const UNITS_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_WORDS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30,
};

/** "five hundred" → "500", "twenty five" → "25", "five hundred and five" → "505", "zero five" → "0 5". */
function numberWordsToDigits(words: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  let current = 0;
  let active = false;
  const flush = () => {
    if (active) out.push(String(total + current));
    total = 0;
    current = 0;
    active = false;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (w in UNITS_WORDS) {
      const u = UNITS_WORDS[w];
      // "twenty" + "five", "five hundred" + "five", "one hundred" + "twelve" — else a new number ("one two three").
      const joins = active && u > 0 && ((current % 100 === 0 && (current > 0 || total > 0)) || (current % 10 === 0 && current % 100 !== 0 && u < 10));
      if (!joins) flush();
      current += u;
      active = true;
    } else if (w in TENS_WORDS) {
      const joins = active && current % 100 === 0 && (current > 0 || total > 0);
      if (!joins) flush();
      current += TENS_WORDS[w];
      active = true;
    } else if (w === 'hundred' && active) {
      current = (current || 1) * 100;
    } else if (w === 'thousand' && active) {
      total += (current || 1) * 1000;
      current = 0;
    } else if (w === 'and' && active && next && (next in UNITS_WORDS || next in TENS_WORDS)) {
      continue;
    } else {
      flush();
      out.push(w);
    }
  }
  flush();
  return out;
}

/** Words as the checks read them: lower case, "500mg" → "500 mg", "follow-up" → "follow up", number words → digits. */
export function normalize(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\d)([a-z%])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/o'clock/g, 'o clock')
    .replace(/'s\b/g, '')
    .replace(/(\d):(\d)/g, '$1§$2') // keep times
    .replace(/(\d)\.(\d)/g, '$1¤$2') // keep decimals
    .replace(/(\d)\/(\d)/g, '$1¦$2') // keep dates
    .replace(/(\d)-(\d)/g, '$1¥$2')
    .replace(/[^a-z0-9§¤¦¥%+\s]/g, ' ')
    .replace(/§/g, ':')
    .replace(/¤/g, '.')
    .replace(/¦/g, '/')
    .replace(/¥/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return numberWordsToDigits(cleaned.split(' ').filter(Boolean)).join(' ');
}

/** Words that carry no fact of their own. */
const FILLER = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'and', 'with', 'on', 'in', 'at', 'by', 'per', 'be', 'is', 'are', 'was', 'as', 'or',
  'his', 'her', 'their', 'this', 'that', 'it', 'its', 'my', 'please', 'up', 'new', 'add', 'patient', 'patients', 'record', 'records',
  'mr', 'mrs', 'ms', 'dr', 'doctor', 'also', 'then', 'some', 'any', 'all',
  // The kinds of record: "add medication" names no drug, "add diagnosis" no condition.
  'medication', 'medications', 'medicine', 'medicines', 'meds', 'med', 'drug', 'drugs', 'diagnosis', 'diagnoses', 'condition', 'conditions',
  'task', 'tasks', 'recall', 'recalls', 'appointment', 'appointments', 'prescription', 'prescriptions',
]);

/** Short forms providers say, and what they stand for. */
const ABBREVIATIONS: Record<string, string[]> = {
  bp: ['blood', 'pressure'],
  htn: ['hypertension'],
  dm: ['diabetes'],
  t2dm: ['type', '2', 'diabetes'],
  hba1c: ['a1c'],
  ecg: ['electrocardiogram'],
  ekg: ['electrocardiogram'],
  cbc: ['blood', 'count'],
  bmp: ['metabolic', 'panel'],
  cmp: ['metabolic', 'panel'],
  lfts: ['liver', 'function'],
  lft: ['liver', 'function'],
  tsh: ['thyroid'],
  copd: ['chronic', 'obstructive', 'pulmonary'],
  uti: ['urinary', 'infection'],
  'f u': ['follow'],
  fu: ['follow'],
  fup: ['follow'],
  appt: ['appointment'],
  meds: ['medication', 'medications'],
  med: ['medication'],
};

export interface Corpus {
  /** Everything said, normalised. */
  text: string;
  tokens: Set<string>;
  numbers: number[];
  /** Every digit said, in order, nothing between them (phone numbers, policy numbers). */
  digits: string;
  /** The text without spaces (codes like I10, emails). */
  compact: string;
}

/** The provider's words for this request (every utterance, the clarifications included). */
export function corpusOf(utterances: readonly string[]): Corpus {
  const text = normalize(utterances.filter(Boolean).join(' . '));
  const tokens = new Set(text.split(' ').filter(Boolean));
  for (const [short, long] of Object.entries(ABBREVIATIONS)) {
    if (short.includes(' ') ? text.includes(short) : tokens.has(short)) long.forEach((w) => tokens.add(w));
    if (long.every((w) => tokens.has(w))) tokens.add(short);
  }
  const numbers = [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => Number(m[0]));
  return { text, tokens, numbers, digits: text.replace(/\D/g, ''), compact: text.replace(/[\s.]/g, '') };
}

// ----------------------------------------------------------------------------------------------- words

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/**
 * A word of a value was said: the same word, the same stem ("monitoring" / "monitor"), or the same word
 * misheard by speech recognition ("metforman" / "metformin").
 */
export function wordSaid(word: string, corpus: Corpus, strict = false): boolean {
  if (corpus.tokens.has(word)) return true;
  if (/^\d/.test(word)) return false;
  for (const said of corpus.tokens) {
    if (/^\d/.test(said)) continue;
    const short = Math.min(said.length, word.length);
    if (short >= 4 && (said.startsWith(word) || word.startsWith(said)) && Math.abs(said.length - word.length) <= 4) return true;
    // A drug or a diagnosis is never "close enough" to another one: one letter misheard at most.
    const allowed = strict ? (word.length >= 6 ? 1 : 0) : word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0;
    if (allowed && Math.abs(said.length - word.length) <= allowed && editDistance(said, word) <= allowed) return true;
  }
  return false;
}

/** The words of a value that carry facts. */
export function factWords(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((w) => w && !FILLER.has(w) && (w.length >= 2 || /\d/.test(w)));
}

/** How much of a value was said (0–1), and which of its words were not. */
export function coverage(value: string, corpus: Corpus, strict = false): { share: number; unsaid: string[]; words: string[] } {
  const words = factWords(value);
  if (!words.length) return { share: 1, unsaid: [], words };
  const unsaid = words.filter((w) => !wordSaid(w, corpus, strict));
  return { share: (words.length - unsaid.length) / words.length, unsaid, words };
}

// --------------------------------------------------------------------------------------- doses & units

const UNIT_FORMS: Array<[string, RegExp]> = [
  ['mg', /\b(mg|mgs|milligrams?|milli grams?)\b/],
  ['mcg', /\b(mcg|micrograms?|ug)\b/],
  ['g', /\b(g|gm|grams?)\b/],
  ['ml', /\b(ml|millilit(re|er)s?|cc)\b/],
  ['l', /\b(l|lit(re|er)s?)\b/],
  ['units', /\b(units?|iu|international units?)\b/],
  ['puffs', /\b(puffs?)\b/],
  ['tablets', /\b(tablets?|tabs?|pills?)\b/],
  ['capsules', /\b(capsules?|caps?)\b/],
  ['drops', /\b(drops?)\b/],
  ['%', /(%|\bpercent\b)/],
  ['sachets', /\b(sachets?)\b/],
  ['patches', /\b(patch|patches)\b/],
  ['sprays', /\b(sprays?)\b/],
];

function unitsIn(text: string): Set<string> {
  return new Set(UNIT_FORMS.filter(([, re]) => re.test(text)).map(([unit]) => unit));
}

/** A dose: every amount in it was said, and its unit too ("500 mg" needs 500 and mg / milligrams). */
export function doseSaid(value: string, corpus: Corpus): boolean {
  const v = normalize(value);
  const amounts = [...v.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) => Number(m[0]));
  if (!amounts.length || !amounts.every((n) => corpus.numbers.includes(n))) return false;
  const units = unitsIn(v);
  const saidUnits = unitsIn(corpus.text);
  return [...units].every((u) => saidUnits.has(u));
}

// ----------------------------------------------------------------------------------------- frequencies

/** Most specific first: a phrase taken by one frequency is not read again ("twice daily" is not "daily"). */
const FREQUENCY_FORMS: Array<[string[], RegExp]> = [
  [['Four times daily'], /\b(4 times|qid|q i d)\b( (a|per|every) day| daily)?/g],
  [['Three times daily'], /\b(3 times|thrice|tid|t i d)\b( (a|per|every) day| daily)?/g],
  [['Every 4 hours'], /\bevery 4 hours?\b|\bq ?4 ?h\b/g],
  [['Every 6 hours', 'Four times daily'], /\bevery 6 hours?\b|\bq ?6 ?h\b/g],
  [['Every 8 hours', 'Three times daily'], /\bevery 8 hours?\b|\bq ?8 ?h\b/g],
  [['Every 12 hours', 'Twice daily'], /\bevery 12 hours?\b|\bq ?12 ?h\b/g],
  [['Twice daily'], /\b(twice|2 times|bid|b i d|bd)\b( (a|per|every) day| daily)?/g],
  [['Once weekly'], /\b(once (a|per|every) week|weekly|every week|1 times? (a|per) week)\b/g],
  [['At bedtime'], /\b(at bedtime|bedtime|before bed|at night|nightly|hs)\b/g],
  [['As needed'], /\b(as needed|when needed|as required|when required|prn|if needed|as necessary)\b/g],
  [['Once daily'], /\b(once (a|per|every) day|once daily|1 times? (a|per) day|od|qd|q d)\b/g],
  [['Once daily'], /\b(daily|every day|each day|once a day|once|a day|per day)\b/g],
];

/** The frequencies the provider said, as the medication form names them. */
export function frequenciesSaid(corpus: Corpus): Set<string> {
  let text = ` ${corpus.text} `;
  const said = new Set<string>();
  for (const [options, re] of FREQUENCY_FORMS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      options.forEach((o) => said.add(o));
      re.lastIndex = 0;
      text = text.replace(re, ' § ');
    }
  }
  return said;
}

// ------------------------------------------------------------------------------- options with synonyms

const OPTION_FORMS: Record<string, Record<string, RegExp>> = {
  route: {
    Oral: /\b(oral|orally|by mouth|po|p o|tablet|tablets|capsule|capsules)\b/,
    Intravenous: /\b(iv|i v|intravenous|intravenously|into the vein|drip)\b/,
    Intramuscular: /\b(im|i m|intramuscular|intramuscularly|into the muscle)\b/,
    Subcutaneous: /\b(subcut|sc|s c|sq|subcutaneous|subcutaneously|under the skin)\b/,
    Topical: /\b(topical|topically|cream|ointment|on the skin|apply)\b/,
    Inhalation: /\b(inhal\w*|inhaler|nebuli\w*|puffs?)\b/,
    Sublingual: /\b(sublingual|under the tongue|sl)\b/,
    Rectal: /\b(rectal|rectally|suppositor\w*|pr)\b/,
    Ophthalmic: /\b(ophthalmic|eye drops?|in the eyes?)\b/,
    Otic: /\b(otic|ear drops?|in the ears?)\b/,
    Nasal: /\b(nasal|nose|nasally|intranasal)\b/,
    Transdermal: /\b(transdermal|patch|patches)\b/,
  },
  gender: {
    Male: /\b(male|man|boy|gentleman|mr|he|him)\b/,
    Female: /\b(female|woman|girl|lady|mrs|ms|miss|she|her)\b/,
    Other: /\b(other|non binary|nonbinary)\b/,
  },
};

/** A select value with its own words ("by mouth" is Oral): the option itself, or one of its synonyms, was said. */
export function optionSaid(field: 'route' | 'gender', value: string, corpus: Corpus): boolean {
  const re = OPTION_FORMS[field][value];
  if (re && re.test(corpus.text)) return true;
  return coverage(value, corpus).share === 1;
}

/** The routes the provider said ("by mouth" is Oral, "IV" Intravenous …), as the medication form names them. */
export function routesSaid(corpus: Corpus): string[] {
  return Object.entries(OPTION_FORMS.route)
    .filter(([, re]) => re.test(corpus.text))
    .map(([route]) => route);
}

export const PRN_SAID = (corpus: Corpus) => /\b(as needed|when needed|as required|prn|if needed)\b/.test(corpus.text);
export const TELEHEALTH_SAID = (corpus: Corpus) => /\b(telehealth|tele health|video|virtual|online|by phone|phone call|telephone|remote)\b/.test(corpus.text);

// ------------------------------------------------------------------------------------- dates and times

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const monthIndex = (m: string) => MONTHS.findIndex((full) => full.startsWith(m.slice(0, 3)));
const UNIT_DAYS: Record<string, dayjs.ManipulateType> = { day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year' };

/** Every date the provider's words point to, from today (YYYY-MM-DD). */
export function datesSaid(corpus: Corpus, today: Dayjs = dayjs()): Set<string> {
  const t = corpus.text;
  const out = new Set<string>();
  const add = (d: Dayjs) => d.isValid() && out.add(d.format('YYYY-MM-DD'));
  if (/\btoday\b|\bnow\b/.test(t)) add(today);
  if (/\btomorrow\b/.test(t)) add(today.add(1, 'day'));
  if (/\bday after tomorrow\b/.test(t)) add(today.add(2, 'day'));
  if (/\byesterday\b/.test(t)) add(today.subtract(1, 'day'));
  if (/\bnext week\b/.test(t)) add(today.add(1, 'week'));
  if (/\bnext month\b/.test(t)) add(today.add(1, 'month'));
  if (/\bnext year\b/.test(t)) add(today.add(1, 'year'));
  // "monday", "next tuesday", "this friday": the coming one, and the one after it.
  WEEKDAYS.forEach((name, index) => {
    if (!new RegExp(`\\b${name}\\b`).test(t)) return;
    let ahead = (index - today.day() + 7) % 7;
    if (ahead === 0) add(today);
    if (ahead === 0) ahead = 7;
    add(today.add(ahead, 'day'));
    add(today.add(ahead + 7, 'day'));
  });
  // "in two weeks", "after 3 months", "a week", "10 days" — from today.
  for (const m of t.matchAll(/\b(\d+|a|an)\s+(days?|weeks?|months?|years?)\b/g)) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : 1;
    add(today.add(n, UNIT_DAYS[m[2]]));
  }
  // "october 6", "6 october", "the 6th of october 2026", "2026-10-06", "6/10/2026" (both readings).
  const year = (y?: string) => (y ? Number(y.length === 2 ? `20${y}` : y) : undefined);
  const dated = (y: number | undefined, month: number, day: number) => {
    if (y !== undefined) return add(dayjs(new Date(y, month, day)));
    const thisYear = dayjs(new Date(today.year(), month, day));
    add(thisYear);
    if (thisYear.isBefore(today, 'day')) add(thisYear.add(1, 'year'));
  };
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, 'g'))) dated(year(m[3]), monthIndex(m[1]), Number(m[2]));
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:\\s+(\\d{4}))?\\b`, 'g'))) dated(year(m[3]), monthIndex(m[2]), Number(m[1]));
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(dayjs(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    dated(year(m[3]), Number(m[2]) - 1, Number(m[1]));
    dated(year(m[3]), Number(m[1]) - 1, Number(m[2]));
  }
  // "on the 15th": this month's, or next month's when it has passed.
  for (const m of t.matchAll(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/g)) {
    const d = dayjs(new Date(today.year(), today.month(), Number(m[1])));
    add(d.isBefore(today, 'day') ? d.add(1, 'month') : d);
  }
  return out;
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** Every time of day the provider's words point to (HH:mm) — "3" alone is 03:00 or 15:00. */
export function timesSaid(corpus: Corpus): Set<string> {
  const t = corpus.text;
  const out = new Set<string>();
  const both = (h: number, m: number) => {
    if (h > 23 || m > 59) return;
    out.add(hhmm(h, m));
    if (h < 12) out.add(hhmm(h + 12, m));
    if (h === 12) out.add(hhmm(0, m));
  };
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)\b/g)) {
    let h = Number(m[1]) % 12;
    if (m[3].startsWith('p')) h += 12;
    out.add(hhmm(h, Number(m[2] ?? 0)));
  }
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) both(Number(m[1]), Number(m[2]));
  for (const m of t.matchAll(/\b(\d{1,2})\s+o clock\b/g)) both(Number(m[1]), 0);
  for (const m of t.matchAll(/\bhalf past (\d{1,2})\b/g)) both(Number(m[1]), 30);
  for (const m of t.matchAll(/\bquarter past (\d{1,2})\b/g)) both(Number(m[1]), 15);
  for (const m of t.matchAll(/\bquarter to (\d{1,2})\b/g)) both((Number(m[1]) + 23) % 24, 45);
  // "at 3" alone — not "at 3 pm" (already read) nor "at 3 o clock".
  for (const m of t.matchAll(/\bat (\d{1,2})(?: (\d{2}))?\b(?!\s*(?:am|pm|a m|p m|o clock|:))/g)) both(Number(m[1]), Number(m[2] ?? 0));
  if (/\bnoon\b|\bmidday\b/.test(t)) out.add('12:00');
  if (/\bmidnight\b/.test(t)) out.add('00:00');
  return out;
}

/** "5 days", "2 weeks", "3 months": how many days. */
function daysOf(n: number, unit: string): number {
  if (unit.startsWith('week')) return n * 7;
  if (unit.startsWith('month')) return n * 30;
  if (unit.startsWith('year')) return n * 365;
  return n;
}

/** A duration ("7 days") said as such — "for a week" is 7 days, "two weeks" 14. */
export function durationSaid(value: string, corpus: Corpus): boolean {
  const v = normalize(value).match(/\b(\d+|a|an)\s+(days?|weeks?|months?|years?)\b/);
  if (!v) return coverage(value, corpus).share === 1;
  const want = daysOf(/^\d/.test(v[1]) ? Number(v[1]) : 1, v[2]);
  return [...corpus.text.matchAll(/\b(\d+|a|an)\s+(days?|weeks?|months?|years?)\b/g)].some((m) => daysOf(/^\d/.test(m[1]) ? Number(m[1]) : 1, m[2]) === want);
}

/** A list position ("the second one", "number 3") was said. */
export function positionSaid(position: number, corpus: Corpus): boolean {
  if (corpus.numbers.includes(position)) return true;
  return Object.entries(ORDINALS).some(([word, n]) => n === position && corpus.tokens.has(word)) || (position === 1 && /\btop\b/.test(corpus.text));
}

/** Digits said in order (a phone or policy number): the value's digits appear together in what was said. */
export function digitsSaid(value: string, corpus: Corpus): boolean {
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return coverage(String(value), corpus).share === 1;
  return corpus.digits.includes(digits);
}

/** A code or an address said letter for letter (I10, an email): the same characters, spaces aside. */
export function compactSaid(value: string, corpus: Corpus): boolean {
  const compact = normalize(String(value)).replace(/[\s.]/g, '');
  return !!compact && corpus.compact.includes(compact);
}

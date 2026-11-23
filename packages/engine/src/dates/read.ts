import * as chrono from 'chrono-node';

/**
 * Reading a date out of text an export left behind (#647): a frontmatter value, a title, a line
 * of a note. Deterministic, no model.
 *
 * A date is **sure** when its written form can be read one way only: year first (`2021-03-04`,
 * `2021.03.04`, `20210304`), a month by name (`March 4, 2021`, `4 Mar 2021`), or numbers where
 * one of the first two is over 12 (`25/03/2021`). It is **unsure** when day and month could be
 * either way round (`03/04/2021`) or the year has two digits (`4 Mar 21`). An either-way date is
 * read by the order the caller says its neighbours use, and has no reading when the caller
 * knows none.
 *
 * Only whole dates are read: `March 2021`, `March 4` and `next Friday` name no day of a year.
 * A span of days (`March 4-6, 2021`) is read as its first day and marked as a span.
 */

export type DateOrder = 'day_first' | 'month_first';
export type DateDoubt = 'day_or_month' | 'two_digit_year';

export interface ReadDate {
  /** YYYY-MM-DD, or null for an either-way date with no order to read it by. */
  date: string | null;
  /** The text it was read from. */
  text: string;
  /** Where the text starts. */
  index: number;
  doubt: DateDoubt | null;
  /** For an either-way date: both readings, day first then month first. */
  readings?: [string, string];
  /** For numbers that can be read one way only: which way, so a caller can learn a source's order. */
  order?: DateOrder;
  /** The text is a span of days (`March 4-6, 2021`) and `date` is its first: the rest is not in the date. */
  range?: true;
}

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function day(year: number, month: number, dayOfMonth: number): string | null {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? text : null;
}

/** A two-digit year as the nearest year not after next year: 21 is 2021, 87 is 1987. */
function fullYear(twoDigits: number, now: Date): number {
  const century = Math.floor(now.getUTCFullYear() / 100) * 100;
  const year = century + twoDigits;
  return year > now.getUTCFullYear() + 1 ? year - 100 : year;
}

// Year first: 2021-03-04, 2021/3/4, 2021.03.04, 2021_03_04, and 20210304.
const YEAR_FIRST = /(?<!\d)(\d{4})([-./_])(\d{1,2})\2(\d{1,2})(?!\d)/g;
const COMPACT = /(?<![\d.])((?:19|20)\d{2})(\d{2})(\d{2})(?![\d.])/g;
// Day and month first: 25/03/2021, 3-4-21, 04.03.2021.
const YEAR_LAST = /(?<!\d)(\d{1,2})([-./])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/g;

/** Every whole date in a text, in the order written. */
export function readDates(text: string, options: { order?: DateOrder | null; now?: Date } = {}): ReadDate[] {
  const now = options.now ?? new Date();
  const found: ReadDate[] = [];
  // Numbers are read here, not by the library, which takes 03/04/2021 as month first. What is
  // read is blanked out, so the library sees only what is left.
  let rest = text;
  const blank = (index: number, length: number): void => {
    rest = rest.slice(0, index) + ' '.repeat(length) + rest.slice(index + length);
  };

  for (const pattern of [YEAR_FIRST, COMPACT]) {
    for (const match of rest.matchAll(pattern)) {
      const [whole, year] = match;
      const [month, dayOfMonth] = pattern === YEAR_FIRST ? [match[3]!, match[4]!] : [match[2]!, match[3]!];
      const date = day(Number(year), Number(month), Number(dayOfMonth));
      if (date === null) continue;
      found.push({ date, text: whole!, index: match.index, doubt: null });
      blank(match.index, whole!.length);
    }
  }

  for (const match of rest.matchAll(YEAR_LAST)) {
    const [whole, first, , second, yearText] = match;
    const a = Number(first);
    const b = Number(second);
    const twoDigits = yearText!.length === 2;
    const year = twoDigits ? fullYear(Number(yearText), now) : Number(yearText);
    const dayFirst = day(year, b, a);
    const monthFirst = day(year, a, b);
    if (dayFirst === null && monthFirst === null) continue;
    blank(match.index, whole!.length);
    const yearDoubt: DateDoubt | null = twoDigits ? 'two_digit_year' : null;
    if (dayFirst !== null && monthFirst !== null && dayFirst !== monthFirst) {
      const order = options.order ?? null;
      found.push({
        date: order === null ? null : order === 'day_first' ? dayFirst : monthFirst,
        text: whole!, index: match.index, doubt: 'day_or_month', readings: [dayFirst, monthFirst],
      });
    } else {
      const date = (dayFirst ?? monthFirst)!;
      // 04/04/2021 reads the same both ways and says nothing about the order.
      const order: DateOrder | undefined = dayFirst === monthFirst ? undefined : dayFirst !== null ? 'day_first' : 'month_first';
      found.push({ date, text: whole!, index: match.index, doubt: yearDoubt, ...(order === undefined ? {} : { order }) });
    }
  }

  // A month by name. Strict parsing takes no "today" or "next Friday"; a date with no year or no day is not whole.
  for (const result of chrono.strict.parse(rest, now)) {
    const start = result.start;
    // In a span the year may be written once, at its end (`March 4 to March 6, 2021`).
    const yearWritten = start.isCertain('year') || (result.end?.isCertain('year') ?? false);
    if (!yearWritten || !start.isCertain('month') || !start.isCertain('day')) continue;
    const date = day(start.get('year')!, start.get('month')!, start.get('day')!);
    if (date === null) continue;
    const written = result.text;
    found.push({
      date, text: written, index: result.index, doubt: /\d{4}/.test(written) ? null : 'two_digit_year',
      ...(result.end ? { range: true as const } : {}),
    });
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * Which way round the day-and-month dates of a text can only be read: one entry per date with a
 * number over 12 (`25/03/2021` is day first). Numbers only, with no library call, so it is cheap
 * enough to run over every note when learning how a vault writes its dates.
 */
export function orderEvidence(text: string, now: Date = new Date()): DateOrder[] {
  const orders: DateOrder[] = [];
  for (const match of text.matchAll(YEAR_LAST)) {
    const a = Number(match[1]);
    const b = Number(match[3]);
    const year = match[4]!.length === 2 ? fullYear(Number(match[4]), now) : Number(match[4]);
    const dayFirst = day(year, b, a);
    const monthFirst = day(year, a, b);
    if (dayFirst !== null && monthFirst === null) orders.push('day_first');
    else if (monthFirst !== null && dayFirst === null) orders.push('month_first');
  }
  return orders;
}

/** The order a source's dates are written in, from those that can be read one way only; null when they disagree or none says. */
export function orderOf(dates: Iterable<ReadDate | DateOrder>): DateOrder | null {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const date of dates) {
    const order = typeof date === 'string' ? date : date.order;
    if (order === 'day_first') dayFirst += 1;
    else if (order === 'month_first') monthFirst += 1;
  }
  if (dayFirst > 0 && monthFirst === 0) return 'day_first';
  if (monthFirst > 0 && dayFirst === 0) return 'month_first';
  return null;
}

import { describe, expect, it } from 'vitest';
import { orderEvidence, orderOf, readDates } from '../../src/dates/read.js';

const now = new Date('2026-11-18T12:00:00Z');
const read = (text: string, order?: 'day_first' | 'month_first') => readDates(text, { now, ...(order ? { order } : {}) });
const brief = (text: string, order?: 'day_first' | 'month_first') => read(text, order).map(found => [found.date, found.text, found.doubt]);

describe('readDates', () => {
  it('reads a year-first date one way only', () => {
    expect(brief('2021-03-04')).toEqual([['2021-03-04', '2021-03-04', null]]);
    expect(brief('Sync 2021.03.04 notes')).toEqual([['2021-03-04', '2021.03.04', null]]);
    expect(brief('2021/3/4')).toEqual([['2021-03-04', '2021/3/4', null]]);
    expect(brief('2021_03_04 standup')).toEqual([['2021-03-04', '2021_03_04', null]]);
    expect(brief('export-20210304-final')).toEqual([['2021-03-04', '20210304', null]]);
    expect(brief('2021-03-04T10:30')).toEqual([['2021-03-04', '2021-03-04', null]]);
  });

  it('reads a month by name, and only a whole date', () => {
    expect(brief('March 4, 2021')).toEqual([['2021-03-04', 'March 4, 2021', null]]);
    expect(brief('4 Mar 2021')).toEqual([['2021-03-04', '4 Mar 2021', null]]);
    expect(brief('Thursday, March 4th, 2021 at 10:30')[0]![0]).toBe('2021-03-04');
    expect(brief('Sync on 4 March 2021 with Acme')[0]![0]).toBe('2021-03-04');
    // No day, no year, or no date at all.
    for (const text of ['March 2021', 'March 4', 'next Friday', 'today', 'Q1 2021', 'version 4.2', 'call 555-0100', 'room 2021']) {
      expect(read(text)).toEqual([]);
    }
  });

  it('reads day and month by the number over 12, and is unsure when both could be either', () => {
    expect(read('25/03/2021')).toEqual([{ date: '2021-03-25', text: '25/03/2021', index: 0, doubt: null, order: 'day_first' }]);
    expect(read('03/25/2021')).toEqual([{ date: '2021-03-25', text: '03/25/2021', index: 0, doubt: null, order: 'month_first' }]);
    expect(read('04.04.2021')).toEqual([{ date: '2021-04-04', text: '04.04.2021', index: 0, doubt: null }]);
    expect(read('03/04/2021')).toEqual([{ date: null, text: '03/04/2021', index: 0, doubt: 'day_or_month', readings: ['2021-04-03', '2021-03-04'] }]);
    expect(brief('03/04/2021', 'day_first')).toEqual([['2021-04-03', '03/04/2021', 'day_or_month']]);
    expect(brief('03/04/2021', 'month_first')).toEqual([['2021-03-04', '03/04/2021', 'day_or_month']]);
  });

  it('is unsure about a two-digit year', () => {
    expect(brief('25/03/21')).toEqual([['2021-03-25', '25/03/21', 'two_digit_year']]);
    expect(brief('25/03/87')).toEqual([['1987-03-25', '25/03/87', 'two_digit_year']]);
    expect(brief('4 Mar 21')).toEqual([['2021-03-04', '4 Mar 21', 'two_digit_year']]);
  });

  it('reads no date that is not a real day', () => {
    for (const text of ['2021-02-30', '2021-13-01', '31/04/2021', '1800-01-01', '99999999', '1.2.3']) expect(read(text)).toEqual([]);
  });

  it('reads a span of days as its first day, and says it is a span', () => {
    expect(read('March 4-6, 2021')).toMatchObject([{ date: '2021-03-04', range: true }]);
    expect(read('March 4 to March 6, 2021')).toMatchObject([{ date: '2021-03-04', range: true }]);
    expect(read('March 4, 2021')[0]!.range).toBeUndefined();
  });

  it('returns every date in the order written', () => {
    expect(brief('From 2021-03-04 to March 9, 2021 (was 25/02/2021)').map(found => found[0])).toEqual(['2021-03-04', '2021-03-09', '2021-02-25']);
  });
});

describe('orderOf', () => {
  it('learns the order from dates that can be read one way only', () => {
    expect(orderOf([...read('25/03/2021'), ...read('13/01/2020'), ...read('03/04/2021')])).toBe('day_first');
    expect(orderOf(read('03/25/2021'))).toBe('month_first');
    expect(orderOf([...read('25/03/2021'), ...read('03/25/2021')])).toBeNull();
    expect(orderOf(read('03/04/2021'))).toBeNull();
  });

  it('takes the same evidence from the numbers alone', () => {
    expect(orderEvidence('25/03/2021 and 13.01.20', now)).toEqual(['day_first', 'day_first']);
    expect(orderEvidence('03/25/2021', now)).toEqual(['month_first']);
    // Either way, the same both ways, year first, and a month by name say nothing about the order.
    expect(orderEvidence('03/04/2021, 04/04/2021, 2021-03-25, 25 March 2021', now)).toEqual([]);
    expect(orderOf([...orderEvidence('25/03/2021', now), ...orderEvidence('03/25/2021', now)])).toBeNull();
  });
});

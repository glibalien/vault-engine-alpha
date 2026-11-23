import { describe, expect, it } from 'vitest';
import { carriedRawText, rawTextFitsValue } from '../../src/pipeline/carried-raw-text.js';

const list = (...items: unknown[]): string => JSON.stringify(items);

describe('rawTextFitsValue', () => {
  it('accepts a raw text that reads as its value', () => {
    expect(rawTextFitsValue('Dana W', '[[Dana W]]')).toBe(true);
    expect(rawTextFitsValue('Dana W', '[[Dana W|Dana]]')).toBe(true);
    expect(rawTextFitsValue('met Dana W at the fair', 'met [[Dana W]] at the fair')).toBe(true);
    expect(rawTextFitsValue(['Dana W', 'Lee Okafor'], list('[[Dana W]]', 'Lee Okafor'))).toBe(true);
    expect(rawTextFitsValue({ who: 'Dana W' }, '{"who":"[[Dana W]]"}')).toBe(true);
    // A one-item list a change of field type made of a text, and the other way round.
    expect(rawTextFitsValue(['Dana W'], '[[Dana W]]')).toBe(true);
    expect(rawTextFitsValue('Dana W', list('[[Dana W]]'))).toBe(true);
  });

  it('accepts a raw text that is the value itself', () => {
    // The Engine stores a settings note's model fields with their brackets.
    expect(rawTextFitsValue('[[Model A]]', '[[Model A]]')).toBe(true);
    expect(rawTextFitsValue(['[[Model A]]'], list('[[Model A]]'))).toBe(true);
  });

  it('refuses a raw text left from an earlier value', () => {
    expect(rawTextFitsValue('Lee Okafor', '[[Dana W]]')).toBe(false);
    expect(rawTextFitsValue(['Lee Okafor'], list('[[Dana W]]'))).toBe(false);
    expect(rawTextFitsValue(['Dana W', 'Lee Okafor'], list('[[Dana W]]'))).toBe(false);
    expect(rawTextFitsValue({ who: 'Lee Okafor' }, '{"who":"[[Dana W]]"}')).toBe(false);
    expect(rawTextFitsValue(null, '[[Dana W]]')).toBe(false);
  });
});

describe('carriedRawText', () => {
  it('keeps the raw text of a value the write did not change', () => {
    expect(carriedRawText('Dana W', '[[Dana W]]', 'Dana W')).toEqual({ raw: '[[Dana W]]', value: 'Dana W' });
    expect(carriedRawText(['Dana W', 'Lee'], list('[[Dana W]]', 'Lee'), ['Dana W', 'Lee']))
      .toEqual({ raw: list('[[Dana W]]', 'Lee'), value: ['Dana W', 'Lee'] });
    // A value that keeps its brackets itself (a settings note's model field) keeps its raw text.
    expect(carriedRawText('[[Model A]]', '[[Model A]]', '[[Model A]]')).toEqual({ raw: '[[Model A]]', value: '[[Model A]]' });
    // So does a one-item list a change of field type made of a text.
    expect(carriedRawText(['Dana W'], '[[Dana W|Dana]]', ['Dana W'])).toEqual({ raw: '[[Dana W|Dana]]', value: ['Dana W'] });
  });

  it('writes an unchanged value from itself when its raw text is left from an earlier value (#668)', () => {
    // An older watcher path stored an edit's value beside the link it replaced.
    expect(carriedRawText('Lee Okafor', '[[Dana W]]', 'Lee Okafor')).toBeNull();
    expect(carriedRawText(['Lee Okafor', 'Priya Raman'], list('[[Dana W]]', 'Lee Okafor'), ['Lee Okafor', 'Priya Raman'])).toBeNull();
    expect(carriedRawText('2001-02-03', '[[2024-05-06]]', '2001-02-03')).toBeNull();
    expect(carriedRawText({ who: 'Lee Okafor' }, '{"who":"[[Dana W]]"}', { who: 'Lee Okafor' })).toBeNull();
  });

  it('keeps nothing of a text that changed', () => {
    expect(carriedRawText('Dana W', '[[Dana W]]', 'Lee Okafor')).toBeNull();
    expect(carriedRawText('Dana W', '[[Dana W|Dana]]', 'Dana Whitfield')).toBeNull();
    expect(carriedRawText('met Dana W at the fair', 'met [[Dana W]] at the fair', 'met Dana W at the fair, twice')).toBeNull();
    // The caller's own link is the caller's to write.
    expect(carriedRawText('Dana W', '[[Dana W]]', '[[Dana W|Dana]]')).toBeNull();
  });

  it('keeps the link of each list item that is still there', () => {
    const raw = list('[[Dana W|Dana]]', 'Lee Okafor', '[[Acme]] (buyer)');
    const stored = ['Dana W', 'Lee Okafor', 'Acme (buyer)'];
    // One added, at either end.
    expect(carriedRawText(stored, raw, [...stored, 'Priya Raman'])).toEqual({
      raw: list('[[Dana W|Dana]]', 'Lee Okafor', '[[Acme]] (buyer)', 'Priya Raman'), value: [...stored, 'Priya Raman'],
    });
    expect(carriedRawText(stored, raw, ['Priya Raman', ...stored])?.raw).toBe(list('Priya Raman', '[[Dana W|Dana]]', 'Lee Okafor', '[[Acme]] (buyer)'));
    // One removed, and the rest in another order.
    expect(carriedRawText(stored, raw, ['Acme (buyer)', 'Dana W'])).toEqual({
      raw: list('[[Acme]] (buyer)', '[[Dana W|Dana]]'), value: ['Acme (buyer)', 'Dana W'],
    });
    // One changed: it is written as given, the others as they were.
    expect(carriedRawText(stored, raw, ['Dana Whitfield', 'Lee Okafor', 'Acme (buyer)'])?.raw).toBe(list('Dana Whitfield', 'Lee Okafor', '[[Acme]] (buyer)'));
  });

  it('reads a link the caller wrote in a new item as the parser will', () => {
    expect(carriedRawText(['Dana W'], list('[[Dana W]]'), ['Dana W', '[[Priya Raman]]'])).toEqual({
      raw: list('[[Dana W]]', '[[Priya Raman]]'), value: ['Dana W', 'Priya Raman'],
    });
  });

  it('keeps nothing when no item with a link is left', () => {
    const raw = list('[[Dana W]]', 'Lee Okafor');
    expect(carriedRawText(['Dana W', 'Lee Okafor'], raw, ['Lee Okafor', 'Priya Raman'])).toBeNull();
    expect(carriedRawText(['Dana W', 'Lee Okafor'], raw, [])).toBeNull();
  });

  it('gives each stored item to one new item only', () => {
    // One link and one plain name that read the same: a third copy gets neither.
    const raw = list('[[Dana W]]', 'Dana W');
    expect(carriedRawText(['Dana W', 'Dana W'], raw, ['Dana W', 'Dana W', 'Dana W'])?.raw).toBe(list('[[Dana W]]', 'Dana W', 'Dana W'));
    expect(carriedRawText(['Dana W'], list('[[Dana W]]'), ['Dana W', 'Dana W'])?.raw).toBe(list('[[Dana W]]', 'Dana W'));
  });

  it('keeps items that are not text, and links inside them', () => {
    const raw = list('[[Dana W]]', 3, { who: '[[Acme]]' });
    const stored = ['Dana W', 3, { who: 'Acme' }];
    expect(carriedRawText(stored, raw, [{ who: 'Acme' }, 3, 'Lee'])).toEqual({
      raw: list({ who: '[[Acme]]' }, 3, 'Lee'), value: [{ who: 'Acme' }, 3, 'Lee'],
    });
  });

  it('reads a text that looks like JSON as a text', () => {
    const text = '{"who":"Dana W"}';
    const raw = '{"who":"[[Dana W]]"}';
    expect(carriedRawText(text, raw, [text, 'Lee'])).toEqual({ raw: JSON.stringify([raw, 'Lee']), value: [text, 'Lee'] });
    // And a map raw text as a map beside a map value.
    expect(carriedRawText({ who: 'Dana W' }, raw, [{ who: 'Dana W' }, 'Lee'])).toEqual({
      raw: JSON.stringify([{ who: '[[Dana W]]' }, 'Lee']), value: [{ who: 'Dana W' }, 'Lee'],
    });
  });

  it('keeps nothing when the raw text does not read as the stored list', () => {
    // A stale raw text, left by an edit that took the links out.
    expect(carriedRawText(['Lee Okafor', 'Priya Raman'], list('[[Dana W]]', 'Lee Okafor'), ['Lee Okafor', 'Priya Raman', 'Sam'])).toBeNull();
    expect(carriedRawText(['Dana W'], list('[[Dana W]]', 'Lee Okafor'), ['Dana W', 'Sam'])).toBeNull();
    expect(carriedRawText(['Dana W', 'Lee'], '[[Dana W]]', ['Dana W', 'Sam'])).toBeNull();
    expect(carriedRawText(['Dana W'], 'not a list', ['Dana W', 'Sam'])).toBeNull();
    expect(carriedRawText('Lee Okafor', '[[Dana W]]', ['Lee Okafor', 'Sam'])).toBeNull();
  });

  it('keeps an item across a change between one value and a list', () => {
    // One name becomes a list with that name in it.
    expect(carriedRawText('Dana W', '[[Dana W|Dana]]', ['Dana W', 'Lee Okafor'])).toEqual({
      raw: list('[[Dana W|Dana]]', 'Lee Okafor'), value: ['Dana W', 'Lee Okafor'],
    });
    // A list becomes one of its names.
    expect(carriedRawText(['Dana W', 'Lee Okafor'], list('[[Dana W|Dana]]', 'Lee Okafor'), 'Dana W')).toEqual({ raw: '[[Dana W|Dana]]', value: 'Dana W' });
    expect(carriedRawText(['Dana W', 'Lee Okafor'], list('[[Dana W]]', 'Lee Okafor'), 'Lee Okafor')).toBeNull();
    expect(carriedRawText(['Dana W'], list('[[Dana W]]'), 'Priya Raman')).toBeNull();
    // A one-item list a change of field type made of a text keeps that text as its item.
    expect(carriedRawText(['Dana W'], '[[Dana W|Dana]]', ['Dana W', 'Lee Okafor'])?.raw).toBe(list('[[Dana W|Dana]]', 'Lee Okafor'));
  });

  it('writes a new item as a link in a field defined as a list of references', () => {
    const options = { listOfReferences: true };
    expect(carriedRawText(['Dana W'], list('[[Dana W|Dana]]'), ['Dana W', 'Lee Okafor', 'Dana W', '[[Priya Raman]]', 3], options)).toEqual({
      raw: list('[[Dana W|Dana]]', '[[Lee Okafor]]', '[[Dana W]]', '[[Priya Raman]]', 3), value: ['Dana W', 'Lee Okafor', 'Dana W', 'Priya Raman', 3],
    });
    // With nothing carried there is no raw text: the renderer writes every item as a link itself.
    expect(carriedRawText(['Dana W'], list('[[Dana W|Dana]]'), ['Lee Okafor'], options)).toBeNull();
  });

  it('keeps nothing when the field is cleared or holds something that was not there', () => {
    expect(carriedRawText('Dana W', '[[Dana W]]', undefined)).toBeNull();
    expect(carriedRawText('Dana W', '[[Dana W]]', null)).toBeNull();
    expect(carriedRawText('Dana W', '[[Dana W]]', 3)).toBeNull();
    expect(carriedRawText('Dana W', '[[Dana W]]', { who: 'Dana W' })).toBeNull();
  });
});

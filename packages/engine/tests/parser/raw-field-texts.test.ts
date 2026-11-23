import { describe, expect, it } from 'vitest';
import { extractRawFieldTexts, holdsMap, linksInWritten, mapWrittenTexts, rawFieldText, relinkedRawText, renderedRawText, writtenForm, writtenFormOf } from '../../src/parser/raw-field-texts.js';

const note = (...frontmatter: string[]): string => `---\n${frontmatter.join('\n')}\n---\nBody.\n`;

describe('extractRawFieldTexts', () => {
  it('keeps a text that holds a link as it is', () => {
    expect(extractRawFieldTexts(note('lead: "[[Dana W|Dana]]"', 'summary: met [[Dana W]] at the fair', 'place: Hall 2')))
      .toEqual({ lead: '[[Dana W|Dana]]', summary: 'met [[Dana W]] at the fair' });
  });

  it('reads an unquoted link as the link it is, as the whole value', () => {
    expect(extractRawFieldTexts(note('lead: [[Dana W]]'))).toEqual({ lead: '[[Dana W]]' });
  });

  it('reads an unquoted link as an item of a list (#667)', () => {
    expect(extractRawFieldTexts(note('people:', '  - [[Dana W]]', '  - Lee Okafor'))).toEqual({ people: JSON.stringify(['[[Dana W]]', 'Lee Okafor']) });
    expect(extractRawFieldTexts(note('people: [[[Dana W]], [[Lee Okafor]]]'))).toEqual({ people: JSON.stringify(['[[Dana W]]', '[[Lee Okafor]]']) });
    // Quoted and unquoted in one list.
    expect(extractRawFieldTexts(note('people:', '  - "[[Dana W|Dana]]"', '  - [[Lee Okafor]]', '  - Priya Raman')))
      .toEqual({ people: JSON.stringify(['[[Dana W|Dana]]', '[[Lee Okafor]]', 'Priya Raman']) });
  });

  it('reads a link inside a map, at any depth (#667)', () => {
    expect(extractRawFieldTexts(note('contact:', '  who: "[[Acme]]"', '  phone: 555-0100'))).toEqual({ contact: JSON.stringify({ who: '[[Acme]]', phone: '555-0100' }) });
    expect(extractRawFieldTexts(note('contact:', '  who: [[Acme]]'))).toEqual({ contact: JSON.stringify({ who: '[[Acme]]' }) });
    expect(extractRawFieldTexts(note('attendees:', '  - name: [[Dana W]]', '    role: buyer', '  - name: Lee Okafor')))
      .toEqual({ attendees: JSON.stringify([{ name: '[[Dana W]]', role: 'buyer' }, { name: 'Lee Okafor' }]) });
  });

  it('keeps nothing for a value with no link', () => {
    expect(extractRawFieldTexts(note('people:', '  - Dana W', '  - Lee Okafor', 'contact:', '  who: Acme', 'count: 3', 'tags: [a, b]'))).toEqual({});
    // Lists in a list are not links unless each is one item of text, as the parser reads them.
    expect(extractRawFieldTexts(note('grid: [[a, b], [c]]', 'pairs:', '  - [[1]]'))).toEqual({});
  });

  it('leaves out the type key, and reads duplicate keys as the parser does', () => {
    expect(extractRawFieldTexts(note('types: [[Meeting]]', 'lead: "[[Dana W]]"', 'lead: "[[Lee Okafor]]"'))).toEqual({ lead: '[[Lee Okafor]]' });
  });

  it('reads nothing from a note with no frontmatter or frontmatter that does not parse', () => {
    expect(extractRawFieldTexts('Just text with [[Dana W]].\n')).toEqual({});
    expect(extractRawFieldTexts('---\nlead: "[[Dana W]]\n---\nBody.\n')).toEqual({});
  });
});

describe('writtenForm and rawFieldText', () => {
  it('turn unquoted links back into their text and leave everything else', () => {
    expect(writtenForm([['Dana W']])).toBe('[[Dana W]]');
    expect(writtenForm([[['Dana W']], 3, null, { k: [['B']] }])).toEqual(['[[Dana W]]', 3, null, { k: '[[B]]' }]);
    expect(writtenForm({ __proto__: [['x']] } as unknown)).toEqual({});
    expect(rawFieldText(['Dana W', 3])).toBeNull();
    expect(rawFieldText(42)).toBeNull();
  });
});

describe('reading a stored raw text beside its value', () => {
  const mapText = JSON.stringify({ who: '[[Dana W]]' });

  it('reads a list or a map as JSON, and a text as itself, by the value', () => {
    expect(writtenFormOf(JSON.stringify(['[[Dana W]]', 'Lee']), ['Dana W', 'Lee'])).toEqual(['[[Dana W]]', 'Lee']);
    expect(writtenFormOf(mapText, { who: 'Dana W' })).toEqual({ who: '[[Dana W]]' });
    // A text that is JSON of a map is still a text beside a text value.
    expect(writtenFormOf(mapText, '{"who":"Dana W"}')).toBe(mapText);
    expect(writtenFormOf('[[Dana W|Dana]]', 'Dana W')).toBe('[[Dana W|Dana]]');
    expect(writtenFormOf('[[Dana W]]', 'Lee')).toBeNull();
  });

  it('renders a map raw text as a map only beside a map value', () => {
    expect(renderedRawText(mapText, { who: 'Dana W' })).toEqual({ who: '[[Dana W]]' });
    expect(renderedRawText(mapText, '{"who":"Dana W"}')).toBe(mapText);
    expect(renderedRawText(JSON.stringify(['[[A]]']), ['A'])).toEqual(['[[A]]']);
    expect(renderedRawText('[[A]] and [[B]]', 'A and B')).toBe('[[A]] and [[B]]');
  });

  it('reads each link from its own text, so JSON escapes are not part of a target', () => {
    const written = { who: '[[Acme "West"|West]]', path: ['[[C:\\notes]]', 3] };
    expect(linksInWritten(written)).toEqual([{ target: 'Acme "West"', alias: 'West' }, { target: 'C:\\notes', alias: null }]);
    expect(mapWrittenTexts(written, text => text.toUpperCase())).toEqual({ who: '[[ACME "WEST"|WEST]]', path: ['[[C:\\NOTES]]', 3] });
  });
});


describe('relinkedRawText (#670)', () => {
  const targets = new Map([['Acme', 'Acme Corp'], ['Dana W', 'People/Dana W']]);

  it('rewrites each named link at any depth and reads the value again', () => {
    const raw = JSON.stringify({ who: '[[Acme|the vendor]]', terms: 'see [[Acme#Pricing]] and [[Northwind]]', list: ['[[Dana W]]', 3] });
    const value = { who: 'Acme', terms: 'see Acme#Pricing and Northwind', list: ['Dana W', 3] };
    expect(relinkedRawText(raw, value, new Map([...targets, ['Acme#Pricing', 'Acme Corp#Pricing']]))).toEqual({
      raw: JSON.stringify({ who: '[[Acme Corp|the vendor]]', terms: 'see [[Acme Corp#Pricing]] and [[Northwind]]', list: ['[[People/Dana W]]', 3] }),
      value: { who: 'Acme Corp', terms: 'see Acme Corp#Pricing and Northwind', list: ['People/Dana W', 3] },
    });
  });

  it('rewrites a text and a list as well', () => {
    expect(relinkedRawText('ask [[Acme]]', 'ask Acme', targets)).toEqual({ raw: 'ask [[Acme Corp]]', value: 'ask Acme Corp' });
    expect(relinkedRawText(JSON.stringify(['[[Acme]]', { who: '[[Acme]]' }]), ['Acme', { who: 'Acme' }], targets)).toEqual({
      raw: JSON.stringify(['[[Acme Corp]]', { who: '[[Acme Corp]]' }]), value: ['Acme Corp', { who: 'Acme Corp' }],
    });
  });

  it('leaves plain text that reads like a target alone', () => {
    expect(relinkedRawText(JSON.stringify({ who: '[[Acme]]', named: 'Acme' }), { who: 'Acme', named: 'Acme' }, targets)?.value)
      .toEqual({ who: 'Acme Corp', named: 'Acme' });
  });

  it('gives nothing when no link changes or the raw text does not read as the value', () => {
    expect(relinkedRawText(JSON.stringify({ who: '[[Northwind]]' }), { who: 'Northwind' }, targets)).toBeNull();
    expect(relinkedRawText(JSON.stringify({ who: '[[Acme]]' }), { who: 'Lee Okafor' }, targets)).toBeNull();
  });
});

describe('holdsMap', () => {
  it('finds a map as the value or inside a list, at any depth', () => {
    expect(holdsMap({ who: 'Acme' })).toBe(true);
    expect(holdsMap(['Acme', ['Dana W', { who: 'Acme' }]])).toBe(true);
    expect(holdsMap(['Acme', 'Dana W'])).toBe(false);
    expect(holdsMap('Acme')).toBe(false);
    expect(holdsMap(null)).toBe(false);
  });
});

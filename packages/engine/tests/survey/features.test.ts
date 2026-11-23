import { describe, expect, it } from 'vitest';
import { bodyFeatures, ShareCounter, titlePattern } from '../../src/survey/features.js';

describe('titlePattern', () => {
  it.each([
    ['2021-03-04 Weekly sync', '<date> …'],
    ['Weekly sync 2021-03-04', '… <date>'],
    ['Planning — March 4, 2021', '… <date>'],
    ['4 Mar 2021 planning', '<date> …'],
    ['20210304 standup', '<date> …'],
    ['Call 3/4/21 14:30', '… <date> <time>'],
    ['Recipe ideas 0123456789abcdef0123456789abcdef', '… <id>'],
    ['Untitled 12', 'Untitled'],
    ['Chapter 3', '… <n>'],
    ['Plain words only', '…'],
    ['   ', ''],
  ])('%s -> %s', (title, pattern) => {
    expect(titlePattern(title)).toBe(pattern);
  });
});

describe('bodyFeatures', () => {
  it('finds labelled lines with their first spelling, once per note', () => {
    const { labels } = bodyFeatures([
      'Attendees: Dana, Lee',
      '- **Date:** 2021-03-04',
      'Location:: Room 2',
      '> Next steps: send notes',
      'attendees: again',
    ].join('\n'));
    expect([...labels.entries()]).toEqual([
      ['attendees', 'Attendees'],
      ['date', 'Date'],
      ['location', 'Location'],
      ['next steps', 'Next steps'],
    ]);
  });

  it('leaves out links, long lead-ins, empty labels and fenced code', () => {
    const { labels } = bodyFeatures([
      'https://example.com/page',
      'This is a long sentence that happens to have: a colon',
      'Empty:',
      '```',
      'Key: value',
      '```',
    ].join('\n'));
    expect(labels.size).toBe(0);
  });

  it('finds headings with dates and numbers as tokens', () => {
    const { headings } = bodyFeatures('# Notes\n\n## Action items\n\n## 2021-03-04\n\n### **Action items**\n');
    expect([...headings.values()]).toEqual(['Notes', 'Action items', '<date>']);
  });

  it('reads only the start of a long note', () => {
    const { labels } = bodyFeatures(`${'x\n'.repeat(3000)}Late: value`);
    expect(labels.size).toBe(0);
  });
});

describe('ShareCounter', () => {
  it('reports names in enough notes, most common first', () => {
    const counter = new ShareCounter();
    for (let i = 0; i < 6; i++) counter.add('attendees', 'Attendees');
    for (let i = 0; i < 3; i++) counter.add('date', 'Date');
    counter.add('once', 'Once');
    expect(counter.top(10, 0.25, 5)).toEqual([
      { name: 'Attendees', share: 0.6 },
      { name: 'Date', share: 0.3 },
    ]);
    expect(counter.top(0, 0.25, 5)).toEqual([]);
  });
});

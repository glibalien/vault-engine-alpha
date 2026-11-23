import { describe, expect, it } from 'vitest';
import { TEXT_LIMITS, bodyHash, normalizeBody, similarity, sketchOf, wordsOf } from '../../src/duplicates/text.js';

const sketch = (text: string) => sketchOf(wordsOf(normalizeBody(text)));
/** `count` distinct made-up words from `from`: no two runs of them are alike. */
const words = (from: number, count: number): string => Array.from({ length: count }, (_, i) => `w${from + i}`).join(' ');

describe('reading a note\'s text', () => {
  it('sets line endings, trailing spaces and blank lines at either end aside', () => {
    expect(normalizeBody('\r\n\r\nTitle  \r\nline two\t\r\n\r\nlast\r\n\r\n')).toBe('Title\nline two\n\nlast');
    expect(bodyHash(normalizeBody('a  \r\nb\n\n'))).toBe(bodyHash(normalizeBody('\na\nb')));
    // Words inside a line are the text: an added space within it is a change.
    expect(bodyHash(normalizeBody('a b'))).not.toBe(bodyHash(normalizeBody('a  b')));
  });

  it('takes words as letters and digits, so markup is not text', () => {
    expect(wordsOf('## Action items\n- **Dana** to send 2 quotes (by 2024-03-01).')).toEqual(
      ['action', 'items', 'dana', 'to', 'send', '2', 'quotes', 'by', '2024', '03', '01']);
    expect(wordsOf('Kraków café: naïve Größe')).toEqual(['kraków', 'café', 'naïve', 'größe']);
    expect(wordsOf('  \n# \n---\n')).toEqual([]);
  });
});

describe('how alike two texts are', () => {
  it('is 1 for the same words in another app\'s markup, and 0 for different words', () => {
    const evernote = '**Discussion**\n\nWe talked through the renewal pricing and the hiring plan.\n\n**Action items**\n\n- Dana to send the revised quote';
    const notion = '## Discussion\n\nWe talked through the renewal pricing and the hiring plan.\n\n## Action items\n\n* Dana to send the revised quote';
    expect(similarity(sketch(evernote), sketch(notion))).toBe(1);
    expect(similarity(sketch(words(0, 40)), sketch(words(100, 40)))).toBe(0);
  });

  it('is the share of three-word runs in common, exactly, for notes of ordinary length', () => {
    // 40 words give 38 runs. Sharing the first 30 words shares 28 runs: 28 of the 48 runs either has.
    const a = `${words(0, 30)} ${words(100, 10)}`;
    const b = `${words(0, 30)} ${words(200, 10)}`;
    expect(sketch(a)).toMatchObject({ shingles: 38, complete: true });
    expect(similarity(sketch(a), sketch(b))).toBeCloseTo(28 / 48, 10);
    // One word changed in the middle of 40 breaks the three runs through it.
    const edited = a.replace('w15 ', 'changed ');
    expect(similarity(sketch(a), sketch(edited))).toBeCloseTo(35 / 41, 10);
    // The order two notes are given in does not matter.
    expect(similarity(sketch(b), sketch(a))).toBe(similarity(sketch(a), sketch(b)));
  });

  it('counts a repeated run once, and gives a text too short for a run nothing to compare', () => {
    expect(sketch('to be or not to be or not to be').shingles).toBe(4);
    expect(sketch('two words')).toMatchObject({ shingles: 0, complete: true });
    expect(similarity(sketch('two words'), sketch('two words'))).toBe(0);
  });

  it('estimates within a few hundredths for long notes, from a bounded sketch', () => {
    // Two 3,000-word texts with the first 2,400 words in common: 2,398 shared runs of 3,598.
    const a = `${words(0, 2400)} ${words(10_000, 600)}`;
    const b = `${words(0, 2400)} ${words(20_000, 600)}`;
    const long = sketch(a);
    expect(long).toMatchObject({ shingles: 2998, complete: false });
    expect(long.hashes).toHaveLength(TEXT_LIMITS.sketch);
    expect(Math.abs(similarity(long, sketch(b)) - 2398 / 3598)).toBeLessThan(0.06);
    expect(similarity(long, sketch(a))).toBe(1);
    // A short note beside a long one that contains it shares little of the long one's text.
    expect(similarity(sketch(words(0, 60)), long)).toBeLessThan(0.1);
  });
});

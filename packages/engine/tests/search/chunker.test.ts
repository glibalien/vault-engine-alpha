import { describe, it, expect } from 'vitest';
import { chunkForEmbedding, chunkForEmbeddingWithHeadings, renderHeadingTrails } from '../../src/search/chunker.js';

// Approx 4 chars/token — matches Nomic's real ratio closely enough for tests.
const approxTokenize = (s: string): number => Math.ceil(s.length / 4);

describe('chunkForEmbedding', () => {
  it('returns a single chunk when under the token budget', () => {
    const text = 'Hello world.';
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toEqual(['Hello world.']);
  });

  it('splits on markdown headings when text exceeds budget', () => {
    const text = [
      '## Section A',
      'Alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha.',
      '',
      '## Section B',
      'Beta beta beta beta beta beta beta beta beta beta beta beta beta beta.',
      '',
      '## Section C',
      'Gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma gamma.',
    ].join('\n');
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 30, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]).toContain('Section A');
    expect(chunks[1]).toContain('Section B');
    expect(chunks[2]).toContain('Section C');
  });

  it('splits on paragraphs when a section is still too large', () => {
    const big = 'p' + 'aragraph '.repeat(50);
    const text = `${big}\n\n${big}\n\n${big}`;
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 120, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(130);
    }
  });

  it('splits on sentences when a paragraph is still too large', () => {
    const sentence = 'This is a sentence with some words in it.';
    const paragraph = Array(30).fill(sentence).join(' ');
    const chunks = chunkForEmbedding(paragraph, approxTokenize, { maxTokens: 50, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(60);
    }
  });

  it('hard-splits with overlap when even a sentence exceeds the budget', () => {
    const noBoundaries = 'x'.repeat(4000);
    const chunks = chunkForEmbedding(noBoundaries, approxTokenize, { maxTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(approxTokenize(c)).toBeLessThanOrEqual(220);
    }
    const tail = chunks[0].slice(-40);
    const head = chunks[1].slice(0, 120);
    expect(head).toContain(tail.slice(-20));
  });

  it('packs small adjacent sections up to the budget', () => {
    const parts = Array.from({ length: 10 }, (_, i) => `## H${i}\nshort body for section ${i}.`);
    const text = parts.join('\n\n');
    const chunks = chunkForEmbedding(text, approxTokenize, { maxTokens: 200, overlapTokens: 0 });
    expect(chunks.length).toBeLessThan(5);
  });

  it('returns empty array for empty input', () => {
    expect(chunkForEmbedding('', approxTokenize, { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });
});

describe('chunkForEmbeddingWithHeadings (cycle 5 heading trails)', () => {
  it('tracks nested ATX heading trails', () => {
    const text = [
      '# Top',
      'intro text',
      '## Middle',
      'mid text',
      '### Deep',
      'deep text',
      '## Sibling',
      'sib text',
    ].join('\n');
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 6, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const byContent = (needle: string) => chunks.find(c => c.text.includes(needle))!;
    expect(byContent('intro text').trails).toEqual([['Top']]);
    expect(byContent('mid text').trails).toEqual([['Top', 'Middle']]);
    expect(byContent('deep text').trails).toEqual([['Top', 'Middle', 'Deep']]);
    // Sibling replaces Middle at level 2 (and drops Deep)
    expect(byContent('sib text').trails).toEqual([['Top', 'Sibling']]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const text = [
      '## Real Section',
      'before code',
      '```markdown',
      '# Not A Heading',
      '## Also Not',
      '```',
      'after code',
    ].join('\n');
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].trails).toEqual([['Real Section']]);
    // The fenced content stays in the body verbatim
    expect(chunks[0].text).toContain('# Not A Heading');
  });

  it('does not close a longer fence with a shorter marker run', () => {
    const text = [
      '## Real Section',
      '````markdown',
      '```',
      '# Still Code',
      '````',
      'after code',
    ].join('\n');
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].trails).toEqual([['Real Section']]);
  });

  it('does not close a fence when the marker has trailing content', () => {
    const text = [
      '## Real Section',
      '```markdown',
      '``` not a closer',
      '# Still Code',
      '```',
    ].join('\n');
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].trails).toEqual([['Real Section']]);
  });

  it('carries every ordered, unique trail when packing combines sections', () => {
    // H2 nests under H1 — nesting is real structure, so the packed chunk
    // carries each section's own trail in first-appearance order.
    const text = [
      '## Alpha',
      'body a.',
      '',
      '## Beta',
      'body b.',
      '',
      '### Beta Child',
      'body bc.',
      '',
      '## Gamma',
      'body g.',
    ].join('\n');
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].trails).toEqual([['Alpha'], ['Beta'], ['Beta', 'Beta Child'], ['Gamma']]);
  });

  it('deduplicates repeated trails within a packed chunk', () => {
    // Two paragraphs under the same heading, packed together → one trail.
    const text = '## Sec\n\n' + 'word '.repeat(40).trim() + '\n\n' + 'word '.repeat(40).trim();
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].trails).toEqual([['Sec']]);
  });

  it('keeps the trail through paragraph, sentence, and hard splits', () => {
    const bigPara = 'p' + 'iece '.repeat(60);
    const sentences = Array(30).fill('This is a fairly long sentence for splitting.').join(' ');
    const noBoundaries = 'x'.repeat(2000);
    const text = ['## Trail', bigPara, '', sentences, '', noBoundaries].join('\n');
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.trails).toEqual([['Trail']]);
    }
  });

  it('hard-split overlap still works with trails attached', () => {
    const text = '## Sec\n' + 'y'.repeat(1200);
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const tail = chunks[0].text.slice(-30);
    expect(chunks[1].text.slice(0, 60)).toContain(tail.slice(-15));
  });

  it('content before the first heading has an empty trail', () => {
    const text = 'preamble text\n\n## First\nbody';
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 5, overlapTokens: 0 });
    const preamble = chunks.find(c => c.text.includes('preamble'))!;
    expect(preamble.trails).toEqual([[]]);
  });

  it('strips closing ATX hashes from trail entries', () => {
    const text = '## My Section ##\nbody';
    const chunks = chunkForEmbeddingWithHeadings(text, approxTokenize, { maxTokens: 1000, overlapTokens: 0 });
    expect(chunks[0].trails).toEqual([['My Section']]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkForEmbeddingWithHeadings('', approxTokenize, { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });

  it('renderHeadingTrails renders one H1 > H2 line per trail', () => {
    expect(renderHeadingTrails([['A', 'B'], ['C']])).toBe('A > B\nC');
    expect(renderHeadingTrails([])).toBe('');
    expect(renderHeadingTrails([[]])).toBe('');
  });
});

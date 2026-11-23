// tests/search/document-embedder.test.ts
//
// Cycle 5 worker orchestration (src/search/document-embedder.ts) with a fake
// tokenizer + embedOne: rendered-input shape, context repetition across
// chunks, heading trails, token ceilings, and the unchanged legacy path.

import { describe, it, expect } from 'vitest';
import { embedRequest, type DocumentEmbedDeps } from '../../src/search/document-embedder.js';
import type { EmbeddingDocumentContext } from '../../src/search/semantic-context.js';

// Approx 4 chars/token — matches the chunker tests' approximation.
const approxTokenize = (s: string): number => Math.ceil(s.length / 4);

const MAX_TOKENS = 200;

interface Recording {
  inputs: string[];
}

function makeDeps(recording: Recording, maxTokens = MAX_TOKENS): DocumentEmbedDeps {
  return {
    tokenCount: approxTokenize,
    embedOne: async (rendered: string) => {
      recording.inputs.push(rendered);
      return [rendered.length / 1000];
    },
    maxTokens,
    overlapTokens: 20,
    prefixHeadroomTokens: 32,
  };
}

function ctx(overrides: Partial<EmbeddingDocumentContext> = {}): EmbeddingDocumentContext {
  return {
    source: { kind: 'node' },
    title: 'Quarterly Review',
    path: 'Projects/Quarterly Review.md',
    types: ['note'],
    fields: { tags: ['planning', 'q3'] },
    links: ['Roadmap'],
    ...overrides,
  };
}

describe('embedRequest — legacy path (no context)', () => {
  it('renders short documents as `prefix: text`, byte-for-byte', async () => {
    const rec: Recording = { inputs: [] };
    const vectors = await embedRequest({ text: 'hello world', prefix: 'search_document' }, makeDeps(rec));
    expect(vectors).toHaveLength(1);
    expect(rec.inputs).toEqual(['search_document: hello world']);
  });

  it('renders queries identically to v2 (no context handling, no Content: marker)', async () => {
    const rec: Recording = { inputs: [] };
    await embedRequest({ text: 'find meetings', prefix: 'search_query' }, makeDeps(rec));
    expect(rec.inputs).toEqual(['search_query: find meetings']);
  });

  it('chunks long documents and re-applies only the prefix per chunk', async () => {
    const rec: Recording = { inputs: [] };
    const long = Array.from({ length: 20 }, (_, i) => `## S${i}\n` + 'word '.repeat(40)).join('\n\n');
    const vectors = await embedRequest({ text: long, prefix: 'search_document' }, makeDeps(rec));
    expect(vectors.length).toBeGreaterThan(1);
    for (const input of rec.inputs) {
      expect(input.startsWith('search_document: ')).toBe(true);
      expect(input).not.toContain('Content:');
    }
  });
});

describe('embedRequest — context-rich path', () => {
  it('renders prefix + context + Content: body for a short document', async () => {
    const rec: Recording = { inputs: [] };
    const vectors = await embedRequest(
      { text: 'The body text.', prefix: 'search_document', context: ctx() },
      makeDeps(rec),
    );
    expect(vectors).toHaveLength(1);
    const [input] = rec.inputs;
    expect(input.startsWith('search_document: Source: node\n')).toBe(true);
    expect(input).toContain('Title: Quarterly Review');
    expect(input).toContain('Path: Projects/Quarterly Review.md');
    expect(input).toContain('Types: note');
    expect(input).toContain('tags: planning, q3');
    expect(input).toContain('Links: Roadmap');
    expect(input).toContain('\nContent: The body text.');
  });

  it('repeats the full context on every chunk of a multi-chunk document', async () => {
    const rec: Recording = { inputs: [] };
    const long = Array.from({ length: 12 }, (_, i) => `## Part ${i}\n` + 'body '.repeat(30)).join('\n\n');
    const vectors = await embedRequest(
      { text: long, prefix: 'search_document', context: ctx() },
      makeDeps(rec),
    );
    expect(vectors.length).toBeGreaterThan(1);
    for (const input of rec.inputs) {
      expect(input).toContain('Title: Quarterly Review');
      expect(input).toContain('Links: Roadmap');
      expect(input).toContain('\nContent: ');
    }
  });

  it('includes heading trails in the rendered chunk', async () => {
    const rec: Recording = { inputs: [] };
    const text = '# Big\n\n## Sub Section\n\n' + 'detail '.repeat(80);
    await embedRequest({ text, prefix: 'search_document', context: ctx() }, makeDeps(rec, 120));
    const withTrail = rec.inputs.filter(i => i.includes('Big > Sub Section'));
    expect(withTrail.length).toBeGreaterThan(0);
  });

  it('keeps every rendered input within the token ceiling (real-tokenizer contract)', async () => {
    const rec: Recording = { inputs: [] };
    // Long sections + a sizeable context: the render overhead shrinks the body budget.
    const long = Array.from({ length: 25 }, (_, i) => `## Section ${i}\n` + 'payload '.repeat(50)).join('\n\n');
    await embedRequest(
      {
        text: long,
        prefix: 'search_document',
        context: ctx({ fields: { notes: 'x'.repeat(600), tags: ['a', 'b'] } }),
      },
      makeDeps(rec),
    );
    expect(rec.inputs.length).toBeGreaterThan(1);
    for (const input of rec.inputs) {
      expect(approxTokenize(input)).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it('caps the static context at 256 tokens', async () => {
    const rec: Recording = { inputs: [] };
    const huge = ctx({
      fields: { blob: 'y'.repeat(4000), other: 'z'.repeat(4000) },
    });
    await embedRequest({ text: 'small body', prefix: 'search_document', context: huge }, makeDeps(rec, 2048));
    const [input] = rec.inputs;
    // Context portion = everything before "\nContent:"
    const contextPart = input.slice('search_document: '.length, input.indexOf('\nContent:'));
    expect(approxTokenize(contextPart)).toBeLessThanOrEqual(256);
    // Identity rows survive the cap
    expect(contextPart).toContain('Title: Quarterly Review');
  });

  it('produces exactly one vector for a context-only node (empty body)', async () => {
    const rec: Recording = { inputs: [] };
    const vectors = await embedRequest(
      { text: '', prefix: 'search_document', context: ctx() },
      makeDeps(rec),
    );
    expect(vectors).toHaveLength(1);
    expect(rec.inputs[0]).toContain('Title: Quarterly Review');
    expect(rec.inputs[0]).toContain('Content:');
  });

  it('keeps an oversized context-only identity within the full model ceiling', async () => {
    const rec: Recording = { inputs: [] };
    await embedRequest(
      {
        text: '',
        prefix: 'search_document',
        context: ctx({ title: 't'.repeat(600), path: 'p'.repeat(600) }),
      },
      makeDeps(rec, 100),
    );
    expect(rec.inputs).toHaveLength(1);
    expect(approxTokenize(rec.inputs[0])).toBeLessThanOrEqual(100);
  });

  it('renders attachment identity for extraction contexts', async () => {
    const rec: Recording = { inputs: [] };
    await embedRequest(
      {
        text: 'transcribed words',
        prefix: 'search_document',
        context: ctx({ source: { kind: 'extraction', ref: 'lecture.mp3', media_type: 'audio' } }),
      },
      makeDeps(rec),
    );
    expect(rec.inputs[0]).toContain('Attachment: lecture.mp3 (audio)');
  });
});

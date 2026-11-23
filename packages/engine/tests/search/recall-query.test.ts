import { describe, it, expect } from 'vitest';
import { buildRecallMatchQuery } from '../../src/search/search.js';

describe('buildRecallMatchQuery', () => {
  it('ORs content tokens and drops stopwords', () => {
    const q = buildRecallMatchQuery('planning a trip to northstar coast');
    // stopwords: a, to. content: planning, trip, northstar, coast.
    expect(q).toBe('"planning" OR "trip" OR "northstar" OR "coast"');
  });

  it('returns empty string when fewer than two content tokens survive', () => {
    expect(buildRecallMatchQuery('the northwind')).toBe(''); // only "northwind" survives
    expect(buildRecallMatchQuery('for the of a')).toBe(''); // all stopwords
    expect(buildRecallMatchQuery('')).toBe('');
  });

  it('keeps content words that look common (planning, trip, proposal)', () => {
    expect(buildRecallMatchQuery('proposal deal')).toBe('"proposal" OR "deal"');
  });
});

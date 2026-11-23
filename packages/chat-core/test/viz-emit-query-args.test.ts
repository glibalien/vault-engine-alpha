import { describe, it, expect } from 'vitest';
import { sanitizeQueryArgs, VIZ_SPEC_RULES, buildInterpretSystem } from '../src/index.js';

describe('sanitizeQueryArgs', () => {
  it('strips unknown keys and clamps limit', () => {
    const r = sanitizeQueryArgs({ types: ['task'], evil: 'x', limit: 9999 });
    expect(r).toEqual({ query: { types: ['task'], limit: 200 } });
  });
  it('rejects non-objects', () => {
    expect(sanitizeQueryArgs('nope')).toEqual({ error: 'query must be an object' });
    expect(sanitizeQueryArgs([1])).toEqual({ error: 'query must be an object' });
  });
});

describe('VIZ_SPEC_RULES', () => {
  it('is embedded verbatim in the phase-1 interpreter system prompt', () => {
    const sys = buildInterpretSystem({ types: [] });
    expect(sys).toContain(VIZ_SPEC_RULES);
  });
});

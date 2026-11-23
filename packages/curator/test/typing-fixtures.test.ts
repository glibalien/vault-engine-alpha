import { describe, expect, it } from 'vitest';
import { EVAL_CATALOG, TYPING_FIXTURES, scoreTyping } from '../src/eval/typing-fixtures.js';

describe('typing fixtures', () => {
  it('every expected type exists in the eval catalog', () => {
    const names = new Set(EVAL_CATALOG.map(s => s.name));
    for (const f of TYPING_FIXTURES) {
      if (f.expected !== null) expect(names.has(f.expected), f.title).toBe(true);
    }
  });

  it('covers a null case and an adversarial case', () => {
    expect(TYPING_FIXTURES.some(f => f.expected === null)).toBe(true);
    expect(TYPING_FIXTURES.some(f => /ignore.*instructions/i.test(f.body))).toBe(true);
  });
});

describe('scoreTyping', () => {
  it('counts exact matches and reports mismatches', () => {
    const fixtures = [
      { title: 'A', file_path: 'A.md', body: '', expected: 'person' },
      { title: 'B', file_path: 'B.md', body: '', expected: null },
    ];
    const { correct, total, mismatches } = scoreTyping(fixtures, ['person', 'note']);
    expect(total).toBe(2);
    expect(correct).toBe(1);
    expect(mismatches).toEqual(['B: expected null, got note']);
  });
});

import { describe, expect, it } from 'vitest';
import { canonicalJson, digestJson, digestText } from '../../src/provenance/canonical.js';

describe('provenance canonical bytes', () => {
  it('sorts object keys, preserving exact Unicode, nulls and array order', () => {
    expect(canonicalJson({ z: null, a: ['é', 'e\u0301'] })).toBe('{"a":["é","é"],"z":null}');
    expect(digestJson({ a: 1, b: 2 })).toBe(digestJson({ b: 2, a: 1 }));
    expect(digestJson({ a: null })).not.toBe(digestJson({}));
    expect(digestJson(['a', 'b'])).not.toBe(digestJson(['b', 'a']));
    expect(digestText('é')).not.toBe(digestText('e\u0301'));
    expect(digestText('x')).toMatch(/^sha256:text-v1:[a-f0-9]{64}$/);
    expect(digestJson('x')).toMatch(/^sha256:json-v1:[a-f0-9]{64}$/);
  });
  it.each([undefined, NaN, Infinity, 1n, new Date(), { a: undefined }, Array(2), { f() {} }])(
    'rejects values that JSON would silently lose or change', value => {
      expect(() => canonicalJson(value as never)).toThrow();
    },
  );
  it('rejects cycles and excessive nesting', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => canonicalJson(cycle as never)).toThrow();
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => canonicalJson(deep as never)).toThrow();
  });
});

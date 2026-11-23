import { describe, it, expect } from 'vitest';
import { envelopeOk, envelopeMs, envelopeWarnings } from '../src/index.js';

describe('envelope helpers', () => {
  it('envelopeOk: true only for { ok: true }', () => {
    expect(envelopeOk({ ok: true })).toBe(true);
    expect(envelopeOk({ ok: false })).toBe(false);
    expect(envelopeOk(null)).toBe(false);
    expect(envelopeOk('x')).toBe(false);
  });
  it('envelopeMs: reads numeric _ms, else undefined', () => {
    expect(envelopeMs({ _ms: 42 })).toBe(42);
    expect(envelopeMs({ _ms: 'x' })).toBeUndefined();
    expect(envelopeMs({})).toBeUndefined();
    expect(envelopeMs(null)).toBeUndefined();
  });
  it('envelopeWarnings: returns the array or []', () => {
    const w = [{ code: 'X', message: 'm' }];
    expect(envelopeWarnings({ warnings: w })).toEqual(w);
    expect(envelopeWarnings({ warnings: 'nope' })).toEqual([]);
    expect(envelopeWarnings({})).toEqual([]);
  });
});

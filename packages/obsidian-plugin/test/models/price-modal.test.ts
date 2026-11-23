import { describe, expect, it } from 'vitest';
import { parsePriceForm } from '../../src/models/price-modal.js';

const form = (input: string, output: string, cacheRead = '', cacheWrite = '') => ({ input, output, cacheRead, cacheWrite });

describe('parsePriceForm', () => {
  it('reads input and output, and cache prices only when filled in', () => {
    expect(parsePriceForm(form('3', '15'))).toEqual({ ok: true, pricing: { input: 3, output: 15 } });
    expect(parsePriceForm(form(' 0.5 ', '2', '0.05', '0.6'))).toEqual({ ok: true, pricing: { input: 0.5, output: 2, cache_read: 0.05, cache_write: 0.6 } });
    expect(parsePriceForm(form('0', '0'))).toEqual({ ok: true, pricing: { input: 0, output: 0 } });
  });

  it('requires input and output and rejects anything that is not a number of 0 or more', () => {
    expect(parsePriceForm(form('', '15'))).toEqual({ ok: false, message: 'Enter the input price' });
    expect(parsePriceForm(form('3', ''))).toEqual({ ok: false, message: 'Enter the output price' });
    expect(parsePriceForm(form('-1', '15'))).toEqual({ ok: false, message: 'The input price must be a number of 0 or more' });
    expect(parsePriceForm(form('3', 'abc'))).toEqual({ ok: false, message: 'The output price must be a number of 0 or more' });
    expect(parsePriceForm(form('3', '15', 'x'))).toEqual({ ok: false, message: 'The cache read price must be a number of 0 or more' });
  });
});

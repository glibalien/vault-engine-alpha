import { describe, it, expect } from 'vitest';
import { verdict } from '@vault/contract';

describe('workspace wiring', () => {
  it('imports verdict() from @vault/contract', () => {
    expect(verdict('get-node', { ok: true, data: {}, warnings: [] })).toBe('PASS');
  });
});

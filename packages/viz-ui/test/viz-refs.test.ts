import { describe, expect, it } from 'vitest';
import { referenceFieldNames } from '../src/viz-refs';

describe('referenceFieldNames', () => {
  it('returns field names that have a non-empty reference_target', () => {
    const fields = [
      { name: 'status', type: 'enum' },
      { name: 'project', type: 'reference', reference_target: 'project' },
      { name: 'owner', type: 'reference', reference_target: 'person' },
      { name: 'blank', type: 'reference', reference_target: '' },
      { name: 'maybe', type: 'reference', reference_target: null },
    ];
    expect(referenceFieldNames(fields)).toEqual(['project', 'owner']);
  });
  it('handles undefined / empty', () => {
    expect(referenceFieldNames(undefined)).toEqual([]);
    expect(referenceFieldNames([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { computeFieldOrdering, frontmatterKeyOrder } from '../../src/renderer/field-order.js';
import { renderNode } from '../../src/renderer/render.js';
import type { EffectiveField, EffectiveFieldSet } from '../../src/validation/types.js';

function claims(order: Record<string, number>): EffectiveFieldSet {
  return new Map(Object.entries(order).map(([name, resolved_order]) =>
    [name, { resolved_order } as unknown as EffectiveField]));
}

describe('frontmatterKeyOrder', () => {
  it('lists the top-level keys in file order', () => {
    expect(frontmatterKeyOrder('---\ntypes:\nzeta: 1\nalpha: 2\ndue:\n---\nBody')).toEqual(['types', 'zeta', 'alpha', 'due']);
  });

  it('is empty without content, frontmatter, or parseable YAML', () => {
    expect(frontmatterKeyOrder(null)).toEqual([]);
    expect(frontmatterKeyOrder('Just a body')).toEqual([]);
    expect(frontmatterKeyOrder('---\nkey: [unclosed\n---\n')).toEqual([]);
  });
});

describe('computeFieldOrdering', () => {
  it('keeps unclaimed fields in the note\'s order and adds new ones after, in codepoint order', () => {
    const ordering = computeFieldOrdering(
      claims({ status: 1 }),
      ['zeta', 'alpha', 'middle', 'beta', 'aardvark'],
      { status: 'open', zeta: 1, alpha: 2, middle: 3, beta: 4, aardvark: 5 },
      ['types', 'zeta', 'status', 'alpha', 'gone', 'middle'],
    );
    expect(ordering).toEqual([
      { field: 'status', category: 'claimed' },
      { field: 'zeta', category: 'orphan' },
      { field: 'alpha', category: 'orphan' },
      { field: 'middle', category: 'orphan' },
      { field: 'aardvark', category: 'orphan' },
      { field: 'beta', category: 'orphan' },
    ]);
  });

  it('sorts unclaimed fields by codepoint when the note has no order to keep', () => {
    expect(computeFieldOrdering(claims({}), ['b', 'B', 'a'], { b: 1, B: 2, a: 3 }).map(e => e.field))
      .toEqual(['B', 'a', 'b']);
  });

  it('places unclaimed keys the note holds empty with the other unclaimed fields', () => {
    const ordering = computeFieldOrdering(
      claims({ owner: 1 }),
      ['zeta', 'alpha'],
      { zeta: 1, alpha: 2 },
      ['zeta', 'due', 'alpha', 'owner'],
      ['due', 'owner'],
    );
    expect(ordering).toEqual([
      { field: 'zeta', category: 'orphan' },
      { field: 'due', category: 'orphan' },
      { field: 'alpha', category: 'orphan' },
    ]);
  });
});

describe('renderNode with a kept order', () => {
  it('writes an unclaimed empty key in place and a claimed one at the end', () => {
    const content = renderNode({
      types: [],
      fields: { status: 'open', zeta: 1, alpha: 2 },
      body: '',
      fieldOrdering: computeFieldOrdering(claims({ status: 1 }), ['zeta', 'alpha'], { status: 'open', zeta: 1, alpha: 2 },
        ['zeta', 'due', 'alpha', 'owner'], ['due', 'owner']),
      referenceFields: new Set(),
      listReferenceFields: new Set(),
      orphanRawValues: {},
      explicitNullFields: new Set(['due', 'owner']),
    });
    expect(content).toBe('---\ntypes:\nstatus: open\nzeta: 1\ndue:\nalpha: 2\nowner:\n---\n');
  });
});

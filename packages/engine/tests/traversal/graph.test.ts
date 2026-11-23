import { expect, it } from 'vitest';
import { cyclicComponents } from '../../src/traversal/graph.js';
const edges = (pairs: string[][]) =>
  pairs.map(([source_id, target_id]) => ({
    source_id,
    target_id,
    field: 'blockedBy',
  }));
it('does not mistake shared descendants for a cycle', () => {
  expect(
    cyclicComponents(
      ['A', 'B', 'C', 'D'],
      edges([
        ['A', 'B'],
        ['A', 'C'],
        ['B', 'D'],
        ['C', 'D'],
      ]),
    ),
  ).toEqual([]);
});
it('reports sorted cyclic components and self loops only', () => {
  expect(
    cyclicComponents(
      ['D', 'C', 'B', 'A', 'E'],
      edges([
        ['C', 'A'],
        ['A', 'B'],
        ['B', 'C'],
        ['D', 'D'],
        ['E', 'D'],
      ]),
    ),
  ).toEqual([['A', 'B', 'C'], ['D']]);
});
it('handles the maximum node population without enumerating paths', () => {
  const ids = Array.from({ length: 500 }, (_, i) => String(i).padStart(3, '0'));
  const cycle = ids.map((id, i) => ({
    source_id: id,
    target_id: ids[(i + 1) % ids.length],
    field: 'blockedBy',
  }));
  expect(cyclicComponents(ids, cycle)).toEqual([ids]);
});

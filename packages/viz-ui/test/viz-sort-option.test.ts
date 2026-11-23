import { expect, test } from 'vitest';
import { SORT_OPTIONS, sortOptionKey } from '../src/viz-spec.js';
test('SORT_OPTIONS cover the directioned choices, link counts included', () => {
  expect(SORT_OPTIONS.map(o => o.label)).toEqual([
    'Newest first', 'Oldest first', 'Recently indexed', 'Title A–Z', 'Title Z–A',
    'Fewest links in', 'Most links in', 'Fewest links out', 'Most links out', 'Most unresolved links',
  ]);
});
test('sortOptionKey maps (field, order) to the matching option key', () => {
  const o = SORT_OPTIONS.find(x => x.key === sortOptionKey('file_mtime', 'desc'))!;
  expect([o.sort_by, o.sort_order]).toEqual(['file_mtime', 'desc']);
});

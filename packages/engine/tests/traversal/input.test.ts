import { expect, it } from 'vitest';
import { parseTraversalRequest } from '../../src/traversal/input.js';
const base = { root_id: 'A', field: 'blockedBy', direction: 'outgoing' };
it('defaults to a bounded identity-only dependency read', () => {
  expect(parseTraversalRequest(base)).toEqual({
    ...base,
    max_depth: 4,
    include_fields: [],
  });
});
it.each([
  { root_id: '' },
  { root_id: 'a'.repeat(257) },
  { field: '' },
  { field: 'a'.repeat(1025) },
  { direction: 'both' },
  { max_depth: 0 },
  { max_depth: 9 },
  { max_depth: 1.5 },
  { include_fields: ['status', 'status'] },
  { include_fields: ['a', 'b', 'c', 'd', 'e', 'f'] },
  { filter: {} },
  { limit: 1 },
  { root_id: null },
  JSON.parse('{"__proto__":1}'),
])('rejects unsupported or unbounded request %j', (patch) => {
  expect(() => parseTraversalRequest({ ...base, ...patch })).toThrow();
});
it('rejects oversized serialized input before traversal', () => {
  expect(() =>
    parseTraversalRequest({ ...base, extra: 'x'.repeat(16384) }),
  ).toThrow();
});

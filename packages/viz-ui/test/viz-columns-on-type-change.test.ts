import { test, expect } from 'vitest';
import { specForTypeChange } from '../src/viz-spec.js';
test('switching type locks the new type and clears display_fields for re-derivation', () => {
  const spec = { kind: 'table', query: { types: ['task'] }, display_fields: ['status', 'priority', 'due'] } as any;
  const next = specForTypeChange(spec, 'meeting');
  expect(next.query.types).toEqual(['meeting']);
  expect(next.display_fields).toEqual([]);
});

test('preserves unrelated spec + query fields across the type change', () => {
  const spec = {
    kind: 'kanban',
    title: 'My board',
    query: { types: ['task'], limit: 25, query: 'urgent' },
    display_fields: ['status'],
    group_by: 'priority',
    density: 'compact',
  } as any;
  const next = specForTypeChange(spec, 'meeting');
  // Only types + display_fields change; everything else survives the spread.
  expect(next.kind).toBe('kanban');
  expect(next.title).toBe('My board');
  expect(next.group_by).toBe('priority');
  expect(next.density).toBe('compact');
  expect(next.query.limit).toBe(25);
  expect(next.query.query).toBe('urgent');
});

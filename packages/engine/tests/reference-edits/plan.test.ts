import { describe, expect, it } from 'vitest';
import { buildIdentityIndex } from '../../src/reference-edits/identity.js';
import { planReferenceEdit } from '../../src/reference-edits/plan.js';
import type { Presence, ReferenceEdit } from '../../src/reference-edits/types.js';

describe('reference member planning', () => {
  const identity = buildIdentityIndex([
    { id: 'p1', title: 'P1', file_path: 'Projects/P1.md' },
    { id: 'p2', title: 'P2', file_path: 'Projects/P2.md' },
    { id: 'x', title: 'Ambiguous', file_path: 'X.md' },
    { id: 'y', title: 'Ambiguous', file_path: 'Y.md' },
  ]);
  const plan = (action: 'add' | 'remove', values: string[], target: ReferenceEdit['target'] = { node_id: 'p1' }, presence: Presence = 'list') =>
    planReferenceEdit({ edit: { field: 'project', action, target }, before: { presence, values }, identity });
  it('preserves spelling, duplicates and order on already-present add', () => {
    expect(plan('add', ['Projects/P1.md', 'P1', 'P2'])).toMatchObject({ changed: false, values: ['Projects/P1.md', 'P1', 'P2'], outcome: 'already_present' });
  });
  it('removes all unique spellings while preserving unrelated ambiguous and dangling entries', () => {
    expect(plan('remove', ['P1', 'Projects/P1.md', 'Ambiguous', 'Gone', 'P2'])).toMatchObject({ values: ['Ambiguous', 'Gone', 'P2'], removed_count: 2 });
    expect(() => plan('remove', ['Ambiguous'], { node_id: 'x' })).toThrow(/ambiguous/i);
  });
  it('selects raw stored values exactly without normalization', () => {
    expect(plan('remove', [' P1 ', 'P1', ' P1 '], { stored_value: ' P1 ' })).toMatchObject({ values: ['P1'], removed_count: 2 });
  });
  it.each(['absent', 'explicit_null', 'list'] as const)('preserves %s on absent remove and creates a list on add', presence => {
    expect(plan('remove', [], { node_id: 'p1' }, presence)).toMatchObject({ changed: false, after: { presence, count: 0 } });
    expect(plan('add', [], { node_id: 'p1' }, presence)).toMatchObject({ values: ['P1'], after: { presence: 'list', count: 1 } });
  });
  it('keeps an empty list after the last removal', () => {
    expect(plan('remove', ['P1'])).toMatchObject({ values: [], after: { presence: 'list', count: 0 } });
  });
  it('enforces both input and proposed list limits including UTF-8 bytes', () => {
    expect(plan('remove', Array(1000).fill('Gone')).changed).toBe(false);
    expect(() => plan('add', Array(1000).fill('Gone'))).toThrow(/limit/i);
    expect(() => plan('remove', Array(1001).fill('Gone'))).toThrow(/limit/i);
    expect(plan('remove', ['a'.repeat(256 * 1024 - 4)]).changed).toBe(false);
    expect(() => plan('remove', ['a'.repeat(256 * 1024 - 3)])).toThrow(/limit/i);
    expect(() => plan('remove', ['界'.repeat(90_000)])).toThrow(/limit/i);
  });
});

import { describe, expect, it } from 'vitest';
import type { VizRow } from '../src/viz-spec';
import {
  STATUS_ORDER, statusColorVar, isStatus, fieldText, sortRows, filterRows, groupRows, MISSING_BUCKET,
} from '../src/viz-state';

const row = (id: string, title: string, fields: Record<string, unknown>): VizRow =>
  ({ id, title, file_path: `${id}.md`, types: ['task'], fields });

const ROWS = [
  row('a', 'Bravo task', { status: 'done', due: '2026-06-20', project: ['Vault Engine'] }),
  row('b', 'Alpha task', { status: 'open', due: '2026-06-10', project: ['Atlas Project'] }),
  row('c', 'Charlie task', { status: 'in-progress', due: '', project: ['Vault Engine'] }),
];

describe('fieldText', () => {
  it('stringifies scalars, joins arrays, blanks null/undefined', () => {
    expect(fieldText('open')).toBe('open');
    expect(fieldText(['A', 'B'])).toBe('A, B');
    expect(fieldText(undefined)).toBe('');
    expect(fieldText(3)).toBe('3');
  });
});

describe('statusColorVar', () => {
  it('maps known statuses case-insensitively and falls back for unknown values', () => {
    expect(statusColorVar('done')).toBe('--st-done');
    expect(statusColorVar('Done')).toBe('--st-done');
    expect(statusColorVar('In-Progress')).toBe('--st-progress');
    expect(statusColorVar('pending')).toBe('--st-blocked');
    expect(statusColorVar('whatever')).toBe('--st-todo');
  });
});

describe('isStatus', () => {
  it('recognizes the status enum case-insensitively, blank is not a status', () => {
    expect(isStatus('done')).toBe(true);
    expect(isStatus('In-Progress')).toBe(true);
    expect(isStatus('frobnicate')).toBe(false);
    expect(isStatus('')).toBe(false);
  });
});

describe('sortRows', () => {
  it('sorts by title and flips direction', () => {
    expect(sortRows(ROWS, { key: 'title', dir: 1 }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(ROWS, { key: 'title', dir: -1 }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
  it('sorts a status field by canonical order, not alphabetically', () => {
    expect(sortRows(ROWS, { key: 'status', dir: 1 }).map((r) => r.fields.status)).toEqual(['open', 'in-progress', 'done']);
  });
  it('sorts other fields lexically and does not mutate input', () => {
    const input = [...ROWS];
    expect(sortRows(input, { key: 'due', dir: 1 }).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('falls back to lexical sort when any status value is off-enum', () => {
    const mixed = [row('a', 'A', { status: 'done' }), row('b', 'B', { status: 'in-review' }), row('c', 'C', { status: 'open' })];
    expect(sortRows(mixed, { key: 'status', dir: 1 }).map((r) => r.fields.status)).toEqual(['done', 'in-review', 'open']);
  });
  it('sorts blank-status rows last, independent of direction (mirrors groupRows)', () => {
    const withBlank = [row('a', 'A', { status: 'done' }), row('b', 'B', { status: '' }), row('c', 'C', { status: 'open' })];
    expect(sortRows(withBlank, { key: 'status', dir: 1 }).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortRows(withBlank, { key: 'status', dir: -1 }).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('filterRows', () => {
  it('matches title and field text case-insensitively', () => {
    expect(filterRows(ROWS, 'atlas', 'status', null).map((r) => r.id)).toEqual(['b']);
    expect(filterRows(ROWS, 'ALPHA', 'status', null).map((r) => r.id)).toEqual(['b']);
  });
  it('applies the group-value chip filter and combines with text', () => {
    expect(filterRows(ROWS, '', 'status', 'done').map((r) => r.id)).toEqual(['a']);
    expect(filterRows(ROWS, 'vault', 'status', 'done').map((r) => r.id)).toEqual(['a']);
    expect(filterRows(ROWS, 'atlas', 'status', 'done')).toEqual([]);
  });
  it('chip-filters the missing bucket (empty value) to rows with no group value', () => {
    expect(filterRows([...ROWS, row('d', 'No status', {})], '', 'status', '').map((r) => r.id)).toEqual(['d']);
  });
  it('chip-filters a literal "—" value without catching missing rows', () => {
    const rows = [row('p', 'P', { status: '—' }), row('q', 'Q', {})];
    expect(filterRows(rows, '', 'status', '—').map((r) => r.id)).toEqual(['p']);
  });
});

describe('groupRows', () => {
  it('orders groups canonically and labels the missing bucket —', () => {
    const groups = groupRows([...ROWS, row('d', 'No status', {})], 'status');
    expect(groups.map((g) => g.label)).toEqual(['open', 'in-progress', 'done', '—']);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['b']);
    expect(groups.at(-1)!.missing).toBe(true);
    expect(groups.at(-1)!.value).toBe('');
  });
  it('orders mixed-case statuses by canonical rank, preserving the original label', () => {
    const mixed = [row('a', 'A', { status: 'Done' }), row('b', 'B', { status: 'Open' })];
    expect(groupRows(mixed, 'status').map((g) => g.label)).toEqual(['Open', 'Done']);
  });
  it('keeps a literal "—" group value distinct from the missing bucket', () => {
    const groups = groupRows([row('p', 'P', { status: '—' }), row('q', 'Q', {})], 'status');
    const real = groups.find((g) => !g.missing);
    const missing = groups.find((g) => g.missing);
    expect(real?.value).toBe('—');
    expect(real?.rows.map((r) => r.id)).toEqual(['p']);
    expect(missing?.rows.map((r) => r.id)).toEqual(['q']);
  });
  it('sorts unknown group values after known, alphabetically', () => {
    const groups = groupRows([row('x', 'X', { owner: 'zoe' }), row('y', 'Y', { owner: 'amy' })], 'owner');
    expect(groups.map((g) => g.value)).toEqual(['amy', 'zoe']);
  });
  it('sorts the missing bucket after unknown values', () => {
    const groups = groupRows([row('x', 'X', { owner: 'zoe' }), row('y', 'Y', {}), row('z', 'Z', { owner: 'amy' })], 'owner');
    expect(groups.map((g) => g.label)).toEqual(['amy', 'zoe', '—']);
  });
});

describe('STATUS_ORDER', () => {
  it('covers the vault status enum', () => {
    expect(STATUS_ORDER).toEqual(['backlog', 'open', 'next', 'in-progress', 'pending', 'done', 'dropped']);
  });
});

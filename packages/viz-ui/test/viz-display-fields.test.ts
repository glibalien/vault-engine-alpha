import { describe, expect, it } from 'vitest';
import { isVizSpec, parseVizFence, serializeVizFence, type VizSpec } from '../src/viz-spec.js';
import { parseBoardCardSpec } from '../src/board-card-spec.js';

const parsers = {
  fence: (spec: unknown) => parseVizFence(JSON.stringify(spec)),
  board: (spec: unknown) => parseBoardCardSpec(spec),
};

describe.each(Object.entries(parsers))('%s display-field normalization', (_name, parse) => {
  it.each(['table', 'kanban', 'list', 'calendar', 'tasklist'])('keeps the first occurrence in %s without changing widths or input', kind => {
    const widths = Object.freeze({ table: Object.freeze({ status: 175, due: 240 }), kanban: Object.freeze({ open: 310 }) });
    const input = Object.freeze({
      kind, title: 'Work', query: { types: ['task'] },
      display_fields: Object.freeze(['status', 'due', 'status', 'priority', 'due']), column_widths: widths,
    });
    const parsed = parse(input);
    expect(parsed).toEqual({ ...input, kind: kind === 'tasklist' ? 'list' : kind, display_fields: ['status', 'due', 'priority'] });
    expect(input.display_fields).toEqual(['status', 'due', 'status', 'priority', 'due']);
    expect(parse(parsed)).toEqual(parsed);
    const fence = serializeVizFence(parsed as VizSpec);
    expect(parseVizFence(fence.slice('```viz\n'.length, -'\n```'.length))).toEqual(parsed);
  });

  it('retains legacy flat widths and exact field spelling', () => {
    const parsed = parse({
      kind: 'kanban', title: 'Work', query: {},
      display_fields: ['status', 'Status', ' status', 'status', '__proto__', '__proto__'],
      column_widths: { open: 260, closed: 330 },
    });
    expect(parsed).toMatchObject({
      display_fields: ['status', 'Status', ' status', '__proto__'],
      column_widths: { open: 260, closed: 330 },
    });
  });

  it('preserves empty lists and rejects non-string entries', () => {
    const base = { kind: 'table', title: 'Work', query: {}, display_fields: [] };
    expect(parse(base)).toEqual(base);
    expect(parse({ ...base, display_fields: ['status', 1, 'status'] })).toBeNull();
  });
});

it('keeps duplicate-bearing legacy specs structurally valid without mutating the guard input', () => {
  const input = { kind: 'table', title: 'Work', query: {}, display_fields: ['status', 'status'] };
  expect(isVizSpec(input)).toBe(true);
  expect(input.display_fields).toEqual(['status', 'status']);
});

it('normalizes duplicates in an empty-title board preset', () => {
  expect(parseBoardCardSpec({ kind: 'table', title: '', query: {}, display_fields: ['status', 'status'] }))
    .toEqual({ kind: 'table', title: '', query: {}, display_fields: ['status'] });
});

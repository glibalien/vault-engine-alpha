import { describe, expect, it } from 'vitest';
import { sanitizeQueryArgs, sanitizeVizInput, createPresentVizTool, deriveVizTitle, synthesizeVizSpec, PRESENT_VIZ_SCHEMA } from '../src/viz-emit.js';
import { interpretSchema } from '../src/viz-interpret.js';

describe('unique display fields', () => {
  it('keeps first occurrences before applying the eight-field cap', () => {
    const input = { kind: 'table', title: 'Work', query: {}, display_fields: ['a', 'a', 'b', 'c', 'd', 'b', 'e', 'f', 'g', 'h', 'i'] };
    const result = sanitizeVizInput(input);
    expect(result).toMatchObject({ spec: { display_fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] } });
    expect(input.display_fields).toEqual(['a', 'a', 'b', 'c', 'd', 'b', 'e', 'f', 'g', 'h', 'i']);
  });

  it('preserves exact field names and remains idempotent', () => {
    const result = sanitizeVizInput({ kind: 'table', title: 'Work', query: {}, display_fields: ['status', 'Status', ' status', 'status', '__proto__', '__proto__'] });
    expect(result).toMatchObject({ spec: { display_fields: ['status', 'Status', ' status', '__proto__'] } });
    if ('error' in result) throw new Error(result.error);
    expect(sanitizeVizInput(result.spec)).toEqual(result);
  });

  it('deduplicates synthesized query cards after filtering and before the cap', () => {
    const input = { include_fields: ['*', 'a', 'a', 1, 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] };
    const result = synthesizeVizSpec(input);
    expect(result?.display_fields).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(input.include_fields).toEqual(['*', 'a', 'a', 1, 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });
});

describe('synthesized link counts (#611)', () => {
  it('shows the count columns when the call selected a count, and drops select', () => {
    const spec = synthesizeVizSpec({ title_eq: 'Alpha', select: ['title', 'inlink_count'] });
    expect(spec?.show_link_counts).toBe(true);
    expect(spec?.query).toEqual({ title_eq: 'Alpha' });
    expect(synthesizeVizSpec({ select: ['title'] })).not.toHaveProperty('show_link_counts');
  });
});

describe('sanitizeVizInput – calendar kind (Task 2)', () => {
  it('accepts calendar kind and carries date_field through', () => {
    const out = sanitizeVizInput({
      kind: 'calendar',
      title: 'x',
      query: {},
      display_fields: ['due'],
      date_field: 'due',
    });
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.spec.kind).toBe('calendar');
    expect((out.spec as { date_field?: string }).date_field).toBe('due');
  });
  it('carries an end_date_field through, and leaves it out when absent or not a string (#574)', () => {
    const base = { kind: 'calendar', title: 'trips', query: { types: ['trip'] }, display_fields: [], date_field: 'start' };
    const out = sanitizeVizInput({ ...base, end_date_field: 'end' });
    if ('error' in out) throw new Error(out.error);
    expect(out.spec.end_date_field).toBe('end');
    for (const input of [base, { ...base, end_date_field: 5 }]) {
      const v = sanitizeVizInput(input);
      if ('error' in v) throw new Error(v.error);
      expect(v.spec).not.toHaveProperty('end_date_field');
    }
  });
  it('offers end_date_field to AI callers in the present-viz and board interpreter schemas (#574)', () => {
    expect(PRESENT_VIZ_SCHEMA.properties.end_date_field.type).toBe('string');
    expect(interpretSchema().properties).toHaveProperty('end_date_field');
  });
});

describe('sanitizeVizInput – full query surface (Task 2)', () => {
  it('accepts every supported sort field and order', () => {
    expect(sanitizeQueryArgs({ sort_by: 'title', sort_order: 'asc' }))
      .toEqual({ query: { sort_by: 'title', sort_order: 'asc' } });
    expect(sanitizeQueryArgs({ sort_by: 'file_mtime', sort_order: 'desc' }))
      .toEqual({ query: { sort_by: 'file_mtime', sort_order: 'desc' } });
    expect(sanitizeQueryArgs({ sort_by: 'indexed_at', sort_order: 'asc' }))
      .toEqual({ query: { sort_by: 'indexed_at', sort_order: 'asc' } });
  });

  it('passes through the full owned-args query surface (join_filters, offset, title_contains)', () => {
    const out = sanitizeVizInput({
      kind: 'table',
      title: 'x',
      query: {
        types: ['task'],
        join_filters: [{ rel_type: 'project', target: { node_ids: ['p1'] } }],
        offset: 5,
        title_contains: 'draft',
        without_types: ['archived'],
      },
      display_fields: ['status'],
    });
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.spec.query.join_filters).toEqual([{ rel_type: 'project', target: { node_ids: ['p1'] } }]);
    expect(out.spec.query.offset).toBe(5);
    expect(out.spec.query.title_contains).toBe('draft');
    expect(out.spec.query.without_types).toEqual(['archived']);
  });

  it('still caps limit and display_fields', () => {
    const out = sanitizeVizInput({ kind: 'table', title: 'x', query: { limit: 9999 }, display_fields: Array.from({ length: 30 }, (_, i) => `f${i}`) });
    if ('error' in out) throw new Error('unexpected');
    expect((out.spec.query.limit as number) <= 200).toBe(true);  // MAX_LIMIT
    expect(out.spec.display_fields.length <= 8).toBe(true);       // MAX_DISPLAY_FIELDS
  });
});

const GOOD = {
  kind: 'kanban', title: 'open Vault Engine tasks',
  query: { types: ['task'], fields: { status: { ne: 'done' } } },
  display_fields: ['status', 'due'], group_by: 'status',
};

describe('sanitizeVizInput', () => {
  it('accepts a good spec, defaults pin false', () => {
    const v = sanitizeVizInput(GOOD);
    expect('error' in v).toBe(false);
    if ('error' in v) return;
    expect(v.pin).toBe(false);
    expect(v.spec.kind).toBe('kanban');
  });
  it('strips unknown query keys and caps limits', () => {
    const v = sanitizeVizInput({ ...GOOD, query: { types: ['task'], evil: 'x', limit: 9999 }, pin: true });
    if ('error' in v) throw new Error(v.error);
    expect(v.spec.query).toEqual({ types: ['task'], limit: 200 });
    expect(v.pin).toBe(true);
  });
  it('caps display_fields at 8 and rejects garbage', () => {
    const v = sanitizeVizInput({ ...GOOD, display_fields: ['a','b','c','d','e','f','g','h','i','j'] });
    if ('error' in v) throw new Error(v.error);
    expect(v.spec.display_fields).toHaveLength(8);
    expect('error' in sanitizeVizInput({ ...GOOD, kind: 'pie' })).toBe(true);
    expect('error' in sanitizeVizInput({ ...GOOD, title: '' })).toBe(true);
    expect('error' in sanitizeVizInput(null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveVizTitle (Inc 6)
// ---------------------------------------------------------------------------

describe('deriveVizTitle', () => {
  it('returns "nodes" for empty query', () => {
    expect(deriveVizTitle({})).toBe('nodes');
  });

  it('joins types with " + " and appends query string', () => {
    expect(deriveVizTitle({ types: ['task', 'note'], query: 'roadmap' })).toBe('task + note · "roadmap"');
  });

  it('uses only types when no query string', () => {
    expect(deriveVizTitle({ types: ['task'] })).toBe('task');
  });

  it('ignores whitespace-only query string', () => {
    expect(deriveVizTitle({ types: ['note'], query: '   ' })).toBe('note');
  });
});

// ---------------------------------------------------------------------------
// synthesizeVizSpec (Inc 6)
// ---------------------------------------------------------------------------

describe('synthesizeVizSpec', () => {
  it('returns null for non-object input', () => {
    expect(synthesizeVizSpec(null)).toBeNull();
    expect(synthesizeVizSpec('string')).toBeNull();
    expect(synthesizeVizSpec([])).toBeNull();
    expect(synthesizeVizSpec(42)).toBeNull();
  });

  it('synthesizes a full table spec, drops *, caps limit, exclude include_fields from query', () => {
    const result = synthesizeVizSpec({
      types: ['task'],
      fields: { status: { eq: 'todo' } },
      include_fields: ['status', 'due', '*'],
      limit: 9999,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('table');
    expect(result?.query).toEqual({ types: ['task'], fields: { status: { eq: 'todo' } }, limit: 200 });
    expect(result?.display_fields).toEqual(['status', 'due']);
    expect(result?.title).toBe('task');
    // include_fields must NOT be in query
    expect((result?.query as Record<string, unknown>).include_fields).toBeUndefined();
  });

  it('returns empty display_fields when include_fields is absent', () => {
    const result = synthesizeVizSpec({ types: ['note'] });
    expect(result?.display_fields).toEqual([]);
  });

  it('caps display_fields at MAX_DISPLAY_FIELDS (8)', () => {
    const result = synthesizeVizSpec({
      include_fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    });
    expect(result?.display_fields).toHaveLength(8);
  });

  it('drops "*" entries from display_fields', () => {
    const result = synthesizeVizSpec({ include_fields: ['status', '*', 'due'] });
    expect(result?.display_fields).toEqual(['status', 'due']);
  });

  it('returns a spec with kind:table when input is a valid empty object', () => {
    const result = synthesizeVizSpec({});
    expect(result?.kind).toBe('table');
    expect(result?.display_fields).toEqual([]);
    expect(result?.title).toBe('nodes');
  });
});

import { emitVizParts, emitSynthesizedVizParts, type VizDataPart } from '../src/viz-emit.js';

const okPresentViz = { toolCallId: 't1', toolName: 'present-viz', input: { kind: 'table', title: 'Tasks', query: { types: ['task'] }, display_fields: ['status'] }, output: { ok: true } };
const okQueryNodes = { toolCallId: 't2', toolName: 'query-nodes', input: { types: ['task'], include_fields: ['status'] }, output: { ok: true } };

describe('emitVizParts', () => {
  it('writes a data-viz part for a successful present-viz result and pins', () => {
    const parts: VizDataPart[] = [];
    const pins: string[] = [];
    emitVizParts({ write: (p) => parts.push(p) }, [okPresentViz], (id) => pins.push(id));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'data-viz', id: 't1', data: { toolCallId: 't1', spec: { kind: 'table' } } });
    expect(parts[0].data.collapsed).toBeUndefined();
    expect(pins).toEqual(['t1']);
  });

  it('ignores non-present-viz and failed results', () => {
    const parts: VizDataPart[] = [];
    emitVizParts({ write: (p) => parts.push(p) }, [okQueryNodes, { ...okPresentViz, output: { ok: false } }], () => {});
    expect(parts).toHaveLength(0);
  });
});

describe('emitSynthesizedVizParts', () => {
  it('writes a collapsed table card for a successful query-nodes result', () => {
    const parts: VizDataPart[] = [];
    emitSynthesizedVizParts({ write: (p) => parts.push(p) }, [okQueryNodes]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'data-viz', id: 't2', data: { toolCallId: 't2', collapsed: true, spec: { kind: 'table' } } });
  });

  it('ignores non-query-nodes and failed results', () => {
    const parts: VizDataPart[] = [];
    emitSynthesizedVizParts({ write: (p) => parts.push(p) }, [okPresentViz, { ...okQueryNodes, output: { ok: false } }]);
    expect(parts).toHaveLength(0);
  });
});

describe('createPresentVizTool', () => {
  const envelope = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

  it('runs query-nodes and returns a count summary to the model', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const tool = createPresentVizTool(async (name, args) => {
      calls.push([name, args]);
      return envelope({ ok: true, data: { nodes: [{ title: 'A' }, { title: 'B' }], total: 12 }, warnings: [] });
    });
    const out = (await tool.execute!(GOOD, { toolCallId: 't1', messages: [] })) as Record<string, unknown>;
    expect(calls[0]?.[0]).toBe('query-nodes');
    expect(calls[0]?.[1].include_fields).toEqual(['status', 'due']);
    expect(out.ok).toBe(true);
    expect((out.data as { count: number }).count).toBe(12);
    expect((out.data as { sample: string[] }).sample).toEqual(['A', 'B']);
  });

  it('includes the default group field (status) when group_by is omitted', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const tool = createPresentVizTool(async (name, args) => {
      calls.push([name, args]);
      return envelope({ ok: true, data: { nodes: [], total: 0 }, warnings: [] });
    });
    await tool.execute!({ kind: 'kanban', title: 't', query: { types: ['task'] }, display_fields: ['due'] }, { toolCallId: 't1', messages: [] });
    expect(calls[0]?.[1].include_fields).toEqual(['due', 'status']);
  });

  it('propagates engine failures and invalid input as failed envelopes', async () => {
    const tool = createPresentVizTool(async () => envelope({ ok: false, error: { code: 'X', message: 'nope' }, warnings: [] }));
    const fail = (await tool.execute!(GOOD, { toolCallId: 't1', messages: [] })) as Record<string, unknown>;
    expect(fail.ok).toBe(false);
    const bad = (await tool.execute!({ kind: 'pie' }, { toolCallId: 't2', messages: [] })) as Record<string, unknown>;
    expect(bad.ok).toBe(false);
  });
});

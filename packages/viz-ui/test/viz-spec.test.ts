import { describe, expect, it } from 'vitest';
import {
  VIZ_KINDS, isVizSpec, parseVizFence, serializeVizFence, rowsFromCallResult, vizQueryArgs, defaultDisplayFields,
} from '../src/viz-spec';
import type { Schema } from "@vault/query-core";

const SPEC = {
  kind: 'kanban' as const,
  title: 'open Vault Engine tasks',
  query: { types: ['task'], fields: { status: { ne: 'done' } }, limit: 50 },
  display_fields: ['status', 'due', 'project'],
  group_by: 'status',
};

describe('isVizSpec', () => {
  it('accepts a complete spec and rejects broken ones', () => {
    expect(isVizSpec(SPEC)).toBe(true);
    expect(isVizSpec({ ...SPEC, kind: 'pie' })).toBe(false);
    expect(isVizSpec({ ...SPEC, title: ' ' })).toBe(false);
    expect(isVizSpec({ ...SPEC, display_fields: 'status' })).toBe(false);
    expect(isVizSpec(null)).toBe(false);
  });
});

describe('viz codefence', () => {
  it('round-trips through serialize → parse', () => {
    const fence = serializeVizFence(SPEC);
    expect(fence.startsWith('```viz\n')).toBe(true);
    expect(fence.endsWith('\n```')).toBe(true);
    const body = fence.slice('```viz\n'.length, -'\n```'.length);
    expect(parseVizFence(body)).toEqual(SPEC);
  });
  it('returns null for non-JSON or non-spec bodies', () => {
    expect(parseVizFence('kind: kanban')).toBeNull();
    expect(parseVizFence('{"kind":"kanban"}')).toBeNull();
  });
});

describe('rowsFromCallResult', () => {
  const envelope = (data: unknown, ok = true) => ({
    content: [{ type: 'text', text: JSON.stringify(ok ? { ok, data, warnings: [] } : { ok, error: { message: 'boom' }, warnings: [] }) }],
  });
  it('maps nodes to rows with fields and total', () => {
    const result = rowsFromCallResult(envelope({
      nodes: [{ id: 'n1', title: 'T', file_path: 'a/T.md', types: ['task'], fields: { status: 'open', project: ['X'] } }],
      total: 41,
    }));
    expect(result).toEqual({
      rows: [{ id: 'n1', title: 'T', file_path: 'a/T.md', types: ['task'], fields: { status: 'open', project: ['X'] } }],
      total: 41,
    });
  });
  it('marks rows that came back ranked by a search (hits carry a score)', () => {
    const ranked = rowsFromCallResult(envelope({ nodes: [{ id: 'n1', title: 'T', file_path: 'a/T.md', fields: {}, score: 0.4 }], total: 1 }));
    expect(ranked).toMatchObject({ total: 1, ranked: true });
    const plain = rowsFromCallResult(envelope({ nodes: [{ id: 'n1', title: 'T', file_path: 'a/T.md', fields: {} }], total: 1 }));
    expect('ranked' in plain).toBe(false);
  });
  it('surfaces envelope errors and empty results', () => {
    expect(rowsFromCallResult(envelope(null, false))).toEqual({ error: 'boom' });
    expect(rowsFromCallResult({ content: [] })).toEqual({ error: 'empty tool result' });
  });
  it('surfaces plain-text MCP tool errors instead of masking them as non-JSON', () => {
    const result = {
      content: [{ type: 'text', text: 'MCP error -32602: Input validation error: invalid sort_by' }],
      isError: true,
    };
    expect(rowsFromCallResult(result)).toEqual({
      error: 'MCP error -32602: Input validation error: invalid sort_by',
    });
  });
  it('keeps the generic fallback for malformed non-error text', () => {
    expect(rowsFromCallResult({ content: [{ type: 'text', text: 'not json' }] }))
      .toEqual({ error: 'non-JSON tool result' });
  });
  it('treats ok:true with no data as an empty result', () => {
    expect(rowsFromCallResult({ content: [{ type: 'text', text: '{"ok":true,"warnings":[]}' }] }))
      .toEqual({ rows: [], total: 0 });
  });
  it('falls back to file_path for a node missing an id (stable React key)', () => {
    const result = rowsFromCallResult(envelope({ nodes: [{ title: 'T', file_path: 'a/T.md', fields: {} }], total: 1 }));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.rows[0]!.id).toBe('a/T.md');
  });
});

it("accepts and preserves full query-nodes args beyond the VizQuery subset", () => {
  const fence = JSON.stringify({
    kind: "table",
    title: "tasks blocked by done projects",
    query: {
      types: ["task"],
      join_filters: [{ rel_type: "project", target: { types: ["project"], fields: { status: { eq: "done" } } } }],
      offset: 10,
    },
    display_fields: ["status", "priority"],
  });
  const spec = parseVizFence(fence);
  expect(spec).not.toBeNull();
  expect(isVizSpec(spec)).toBe(true);
  const args = vizQueryArgs(spec!);
  // the wider keys survive into the query-nodes args
  expect(args.join_filters).toEqual([{ rel_type: "project", target: { types: ["project"], fields: { status: { eq: "done" } } } }]);
  expect(args.offset).toBe(10);
  expect(args.types).toEqual(["task"]);
});

describe('vizQueryArgs', () => {
  it('merges display fields and group_by into include_fields with a default limit', () => {
    expect(vizQueryArgs(SPEC)).toEqual({
      types: ['task'], fields: { status: { ne: 'done' } }, limit: 50,
      include_fields: ['status', 'due', 'project'],
    });
    expect(vizQueryArgs({ ...SPEC, query: { types: ['task'] }, group_by: 'owner' }).include_fields)
      .toEqual(['status', 'due', 'project', 'owner']);
    expect(vizQueryArgs({ ...SPEC, query: { types: ['task'] } }).limit).toBe(50);
  });
  it('includes the default group field (status) for a kanban without explicit group_by', () => {
    expect(vizQueryArgs({ kind: 'kanban', title: 't', query: { types: ['task'] }, display_fields: ['due'] }).include_fields)
      .toEqual(['due', 'status']);
  });
});

// ── defaultDisplayFields ───────────────────────────────────────────────────────

function makeField(name: string, widget: string): Schema['fields'][number] {
  return {
    name,
    type: 'string' as const,
    required: false,
    default_value: null,
    ui: { widget: widget as Schema['fields'][number]['ui']['widget'] },
  };
}

const MIXED_SCHEMA: Schema = {
  name: 'thing',
  display_name: 'Thing',
  fields: [
    makeField('title', 'text'),
    makeField('status', 'enum'),
    makeField('due', 'date'),
    makeField('count', 'number'),
    makeField('done', 'bool'),
    makeField('project', 'link'),
    makeField('tags', 'tags'),
    makeField('notes', 'textarea'),
    makeField('body', 'text'),
  ],
};

describe('defaultDisplayFields', () => {
  it('returns scalar field names, excluding link/tags/textarea and the body field', () => {
    expect(defaultDisplayFields(MIXED_SCHEMA)).toEqual(['title', 'status', 'due', 'count', 'done']);
  });

  it('caps at 6 when schema has more than 6 scalar fields', () => {
    const schema: Schema = {
      name: 's',
      display_name: null,
      fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => makeField(n, 'text')),
    };
    expect(defaultDisplayFields(schema)).toHaveLength(6);
    expect(defaultDisplayFields(schema)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('returns [] for an empty schema', () => {
    expect(defaultDisplayFields({ name: 'x', display_name: null, fields: [] })).toEqual([]);
  });
});

describe('viz kind: tasklist -> list rename (F3)', () => {
  const base = { title: 'x', query: { types: ['task'] }, display_fields: ['status'] };

  it('exposes the canonical four kinds, with "list" replacing "tasklist"', () => {
    expect([...VIZ_KINDS]).toEqual(['table', 'kanban', 'list', 'calendar']);
  });

  it('still validates a persisted spec that says "tasklist"', () => {
    // Real prod boards carry kind:'tasklist' in cards_json. If isVizSpec stops
    // accepting it, those cards fail the guard and vanish from the board.
    expect(isVizSpec({ ...base, kind: 'tasklist' })).toBe(true);
  });

  it('normalizes a legacy "tasklist" fence to "list" on parse', () => {
    const spec = parseVizFence(JSON.stringify({ ...base, kind: 'tasklist' }));
    expect(spec?.kind).toBe('list');
  });

  it('leaves the canonical kinds untouched on parse', () => {
    expect(parseVizFence(JSON.stringify({ ...base, kind: 'list' }))?.kind).toBe('list');
    expect(parseVizFence(JSON.stringify({ ...base, kind: 'table' }))?.kind).toBe('table');
  });

  it('still rejects an unknown kind', () => {
    expect(isVizSpec({ ...base, kind: 'gantt' })).toBe(false);
  });
});

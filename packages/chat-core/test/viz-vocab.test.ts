import { describe, expect, it } from 'vitest';
import { fetchVizVocabulary, renderVocabulary, MAX_VOCAB_TYPES } from '../src/viz-vocab.js';
import type { EngineCall } from '../src/tools.js';

const env = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

const engine = (types: unknown, schemas: Record<string, unknown>): EngineCall =>
  async (name, args) => {
    if (name === 'list-schemas') return env({ ok: true, data: types, warnings: [] });
    if (name === 'describe-schema') return env({ ok: true, data: schemas[(args as { name: string }).name], warnings: [] });
    throw new Error(`unexpected call ${name}`);
  };

const TASK_SCHEMA = {
  name: 'task', display_name: null,
  fields: [
    { name: 'status', type: 'enum', required: false, default_value: null, enum_values: ['open', 'done'], ui: null },
    { name: 'due', type: 'date', required: false, default_value: null, ui: null },
    { name: 'project', type: 'reference', required: false, default_value: null, reference_target: 'project', ui: null },
  ],
};

describe('fetchVizVocabulary', () => {
  it('describes schema-bearing types and carries enum values + reference targets', async () => {
    const call = engine(
      [{ name: 'mystery', node_count: 9, has_schema: false, claim_count: null },
       { name: 'person', node_count: 0, has_schema: true, claim_count: 2 },
       { name: 'task', node_count: 312, has_schema: true, claim_count: 5 }],
      { task: TASK_SCHEMA },
    );
    const v = await fetchVizVocabulary(call);
    expect(v.types).toHaveLength(1); // schema-less and unused types skipped
    expect(v.types[0]).toEqual({
      name: 'task', count: 312,
      fields: [
        { name: 'status', type: 'enum', enum_values: ['open', 'done'] },
        { name: 'due', type: 'date' },
        { name: 'project', type: 'reference', reference_target: 'project' },
      ],
    });
  });

  it('caps at MAX_VOCAB_TYPES, most-used first (list-schemas rows come in name order)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `t${String(i).padStart(2, '0')}`, node_count: i + 1, has_schema: true, claim_count: 0 }));
    const schemas = Object.fromEntries(many.map((t) => [t.name, { name: t.name, display_name: null, fields: [] }]));
    const v = await fetchVizVocabulary(engine(many, schemas));
    expect(v.types).toHaveLength(MAX_VOCAB_TYPES);
    expect(v.types[0]).toMatchObject({ name: 't19', count: 20 });
  });

  it('throws with the engine message when list-schemas itself fails (unchanged)', async () => {
    const call: EngineCall = async () => env({ ok: false, error: { code: 'X', message: 'db locked' }, warnings: [] });
    await expect(fetchVizVocabulary(call)).rejects.toThrow('db locked');
  });

  it('throws when every describe-schema call fails (all-failed, single schema-bearing type)', async () => {
    const call: EngineCall = async (name) => {
      if (name === 'list-schemas') return env({ ok: true, data: [{ name: 'task', node_count: 312, has_schema: true, claim_count: 5 }], warnings: [] });
      return env({ ok: false, error: { code: 'X', message: 'schema corrupt' }, warnings: [] });
    };
    await expect(fetchVizVocabulary(call)).rejects.toThrow('schema corrupt');
  });

  it('skips a type whose describe-schema fails, keeping the surviving type (Promise.allSettled)', async () => {
    const call: EngineCall = async (name, args) => {
      if (name === 'list-schemas') {
        return env({ ok: true, data: [
          { name: 'broken', node_count: 9, has_schema: true, claim_count: 1 },
          { name: 'task', node_count: 312, has_schema: true, claim_count: 5 },
        ], warnings: [] });
      }
      const requested = (args as { name: string }).name;
      if (requested === 'broken') return env({ ok: false, error: { code: 'X', message: 'schema corrupt' }, warnings: [] });
      return env({ ok: true, data: TASK_SCHEMA, warnings: [] });
    };
    const v = await fetchVizVocabulary(call);
    expect(v.types).toHaveLength(1);
    expect(v.types[0]!.name).toBe('task');
  });
});

describe('renderVocabulary', () => {
  it('renders one line per type with enum pipes and reference arrows', () => {
    const out = renderVocabulary({ types: [{ name: 'task', count: 312, fields: [
      { name: 'status', type: 'enum', enum_values: ['open', 'done'] },
      { name: 'due', type: 'date' },
      { name: 'project', type: 'reference', reference_target: 'project' },
    ] }] });
    expect(out).toBe('task (312): status: enum(open|done) · due: date · project: reference→project');
  });

  it('caps enum values per field, appending |… when truncated', () => {
    const enumValues = Array.from({ length: 25 }, (_, i) => `v${i}`);
    const out = renderVocabulary({ types: [{ name: 'task', count: 1, fields: [
      { name: 'status', type: 'enum', enum_values: enumValues },
    ] }] });
    expect(out).toBe(`task (1): status: enum(${enumValues.slice(0, 20).join('|')}|…)`);
  });

  it('caps fields per type, appending  · … at the end of the field list when truncated', () => {
    const fields = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, type: 'text' }));
    const out = renderVocabulary({ types: [{ name: 'task', count: 1, fields }] });
    const expectedFields = fields.slice(0, 32).map((f) => `${f.name}: ${f.type}`).join(' · ');
    expect(out).toBe(`task (1): ${expectedFields} · …`);
  });

  it('keeps a field\'s kind apart from its name, so `due: date` cannot read as a field named "due date" (#620)', () => {
    const out = renderVocabulary({ types: [{ name: 'trip', count: 3, fields: [
      { name: 'start', type: 'date' }, { name: 'end', type: 'date' }, { name: 'people involved', type: 'list' },
    ] }] });
    expect(out).toBe('trip (3): start: date · end: date · people involved: list');
    expect(out).not.toContain('start date');
  });

  it('does not append truncation markers when under both caps', () => {
    const out = renderVocabulary({ types: [{ name: 'task', count: 1, fields: [{ name: 'status', type: 'text' }] }] });
    expect(out).not.toContain('…');
  });
});

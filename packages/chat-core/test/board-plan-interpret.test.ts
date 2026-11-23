import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  sanitizeBoardPlan, buildBoardPlanSystem, serializeBoardContext, interpretBoardPlan,
  VIZ_SPEC_RULES, currentDateLine, normalizeBoardPlanShape, BOARD_PLAN_SCHEMA, type BoardContextCard,
} from '../src/index.js';

const CARDS: BoardContextCard[] = [
  { card_id: 'c1', kind: 'table', title: 'Open tasks', spec: { kind: 'table', title: 'Open tasks', query: { types: ['task'] }, display_fields: ['status'] } },
  { card_id: 'c2', kind: 'stats', title: 'Vault stats' },
];
const VIZ = { kind: 'table', title: 't', query: { types: ['task'] }, display_fields: ['status'] };

describe('sanitizeBoardPlan', () => {
  it('accepts a mixed valid plan and trims/truncates summary to 60 chars', () => {
    const r = sanitizeBoardPlan({
      summary: '  ' + 'x'.repeat(80),
      ops: [
        { op: 'add_viz', spec: VIZ },
        { op: 'add_stats', title: 'Health' },
        { op: 'add_from_query', kind: 'node', query: { fields: { status: { eq: 'active' } }, junk: 1 }, cap: 99 },
        { op: 'replace_viz', card_id: 'c1', spec: VIZ },
        { op: 'remove', card_id: 'c2' },
      ],
    }, CARDS);
    if ('error' in r) throw new Error(r.error);
    expect(r.value.summary).toBe('x'.repeat(60));
    expect(r.value.ops).toHaveLength(5);
    const afq = r.value.ops[2] as { op: 'add_from_query'; query: Record<string, unknown>; cap?: number };
    expect(afq.query.junk).toBeUndefined();          // sanitizeQueryArgs stripped it
    expect(afq.cap).toBe(12);                        // clamped
  });
  it('rejects empty ops, >8 ops, missing summary, unknown op', () => {
    expect(sanitizeBoardPlan({ summary: 's', ops: [] }, CARDS)).toHaveProperty('error');
    expect(sanitizeBoardPlan({ summary: 's', ops: Array(9).fill({ op: 'add_stats', title: 't' }) }, CARDS)).toHaveProperty('error');
    expect(sanitizeBoardPlan({ ops: [{ op: 'add_stats', title: 't' }] }, CARDS)).toHaveProperty('error');
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'explode' }] }, CARDS)).toHaveProperty('error');
  });
  it('rejects a bad viz spec inside add_viz with the sanitize message', () => {
    const r = sanitizeBoardPlan({ summary: 's', ops: [{ op: 'add_viz', spec: { kind: 'pie' } }] }, CARDS);
    expect(r).toMatchObject({ error: expect.stringContaining('kind must be one of') });
  });
  it('rejects a viz whose query uses an unsupported sort field', () => {
    const r = sanitizeBoardPlan({
      summary: 'add work tasks',
      ops: [{
        op: 'add_viz',
        spec: {
          kind: 'table',
          title: 'Work tasks',
          query: { types: ['task'], sort_by: 'due date', sort_order: 'asc' },
          display_fields: ['status', 'due'],
        },
      }],
    }, CARDS);
    expect(r).toEqual({ error: 'add_viz: sort_by must be one of title, file_mtime, indexed_at, inlink_count, outlink_count, unresolved_link_count' });
  });
  it('rejects a viz whose query uses an unsupported sort order', () => {
    const r = sanitizeBoardPlan({
      summary: 'add work tasks',
      ops: [{
        op: 'add_viz',
        spec: {
          kind: 'table',
          title: 'Work tasks',
          query: { types: ['task'], sort_by: 'title', sort_order: 'newest' },
          display_fields: ['status', 'due'],
        },
      }],
    }, CARDS);
    expect(r).toEqual({ error: 'add_viz: sort_order must be one of asc, desc' });
  });
  it('rejects an unknown card_id naming the valid ids', () => {
    const r = sanitizeBoardPlan({ summary: 's', ops: [{ op: 'remove', card_id: 'zzz' }] }, CARDS);
    expect(r).toMatchObject({ error: expect.stringContaining('c1') });
    expect((r as { error: string }).error).toContain('c2');
  });
});

describe('buildBoardPlanSystem', () => {
  const NOW = new Date('2026-07-26T12:00:00Z');
  it('carries the op rules, shared viz rules, board context, and the date line LAST', () => {
    const sys = buildBoardPlanSystem({ types: [] }, CARDS, NOW);
    expect(sys).toContain(VIZ_SPEC_RULES);
    expect(sys).toContain('c1 · table · "Open tasks"');
    expect(sys).toContain('add_from_query');
    expect(sys.trimEnd().endsWith(currentDateLine(NOW))).toBe(true);
  });
  it('serializes an empty board explicitly', () => {
    expect(serializeBoardContext([])).toBe('(the board is empty)');
  });
  it('no longer offers the retired evidence card (#281)', () => {
    const sys = buildBoardPlanSystem({ types: [] }, CARDS, new Date('2026-07-27T12:00:00Z'));
    expect(sys).not.toMatch(/evidence/i);
    expect(sys).toContain('add_from_query {kind:"node", query, cap?}');
  });
  it('rejects the retired evidence kind in add_from_query and templates (#281)', () => {
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'add_from_query', kind: 'evidence', query: {} }] }, CARDS))
      .toMatchObject({ error: 'add_from_query: kind must be "node"' });
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', target: 'x', cards: [{ kind: 'evidence' }] }] }, []))
      .toMatchObject({ error: 'create_board: template card kind must be "node", "stats", or "viz"' });
  });
});

describe('normalizeBoardPlanShape — live-captured malformations (2026-07-27)', () => {
  it('rescues op-name-as-key items (repro attempt 1)', () => {
    const raw = {
      name: 'Create boards for each active project',
      summary: 'Add a board for a project with a digest and task list',
      ops: [{ create_board: { target: 'Project Alpha Onboarding', cards: [{ kind: 'node' }] } }],
    };
    const r = sanitizeBoardPlan(raw, []);
    if ('error' in r) throw new Error(r.error);
    expect(r.value.ops[0]).toMatchObject({ op: 'create_board', target: 'Project Alpha Onboarding' });
  });
  it('rescues a top-level op key with no ops array (repro attempt 2)', () => {
    const raw = {
      summary: 'Create a board for a project',
      create_board: { target: 'Project Alpha Onboarding', cards: [{ kind: 'node' }] },
    };
    const r = sanitizeBoardPlan(raw, []);
    if ('error' in r) throw new Error(r.error);
    expect(r.value.summary).toBe('Create a board for a project');
    expect(r.value.ops).toHaveLength(1);
    expect(r.value.ops[0]).toMatchObject({ op: 'create_board' });
  });
  it('top-level rescue falls back to the op name when summary is missing', () => {
    const r = sanitizeBoardPlan({ create_board: { name: 'Ops', cards: [{ kind: 'stats' }] } }, []);
    if ('error' in r) throw new Error(r.error);
    expect(r.value.summary).toBe('create_board');
  });
  it('does not rescue ambiguous shapes (two op-name keys)', () => {
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ add_stats: { title: 't' }, remove: { card_id: 'c1' } }] }, []))
      .toHaveProperty('error');
  });
  it('does NOT rescue an op-name key whose body carries its own contradictory op', () => {
    const item = sanitizeBoardPlan({ summary: 's', ops: [{ create_board: { op: 'remove', card_id: 'c1' } }] }, CARDS);
    expect(item).toMatchObject({ error: expect.stringContaining('unknown op') });
    const top = sanitizeBoardPlan({ summary: 's', create_board: { op: 'remove', card_id: 'c1' } }, CARDS);
    expect(top).toMatchObject({ error: expect.stringContaining('ops must be a non-empty array') });
  });
});

describe('sanitizeBoardPlan — create_board', () => {
  const VIZ_T = { kind: 'viz', spec: { kind: 'table', title: 'Tasks — {{title}}', query: { references: { target: '{{title}}', rel_type: 'project' } }, display_fields: ['status'] } };
  it('accepts targeted create with defaults and placeholder templates', () => {
    const r = sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', target: '  Project Alpha Onboarding ', cards: [{ kind: 'node' }, VIZ_T, { kind: 'stats', title: 'Health' }] }] }, []);
    if ('error' in r) throw new Error(r.error);
    const op = r.value.ops[0] as { op: 'create_board'; target?: string; name?: string; cards: unknown[] };
    expect(op.target).toBe('Project Alpha Onboarding');
    expect(op.name).toBeUndefined();          // default applied client-side
    expect(op.cards).toHaveLength(3);
  });
  it('targetless: name required; node templates rejected; placeholders rejected', () => {
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', cards: [{ kind: 'stats' }] }] }, []))
      .toMatchObject({ error: expect.stringContaining('name is required') });
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', name: 'Ops', cards: [{ kind: 'node' }] }] }, []))
      .toMatchObject({ error: expect.stringContaining('need a target note') });
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', name: 'Ops {{title}}', cards: [{ kind: 'stats' }] }] }, []))
      .toMatchObject({ error: expect.stringContaining('placeholders need a target note') });
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', name: 'Ops', cards: [VIZ_T] }] }, []))
      .toMatchObject({ error: expect.stringContaining('placeholders need a target note') });
    const ok = sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', name: 'Ops', cards: [{ kind: 'stats' }, { kind: 'viz', spec: { kind: 'table', title: 'Overdue', query: { types: ['task'] }, display_fields: ['due'] } }] }] }, []);
    expect(ok).toHaveProperty('value');
  });
  it('template card bounds and junk kinds still enforced', () => {
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', target: 'x', cards: [] }] }, [])).toHaveProperty('error');
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', target: 'x', cards: Array(5).fill({ kind: 'node' }) }] }, [])).toHaveProperty('error');
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', target: 'x', cards: [{ kind: 'spend' }] }] }, [])).toHaveProperty('error');
  });
  it('mixing rule: create_board must be the only op (new exact string)', () => {
    const r = sanitizeBoardPlan({ summary: 's', ops: [{ op: 'create_board', target: 'x', cards: [{ kind: 'node' }] }, { op: 'add_stats', title: 't' }] }, []);
    expect(r).toEqual({ error: 'a plan contains either card-level ops or exactly ONE create_board — never both' });
  });
  it('spawn_boards and split_board are gone', () => {
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'spawn_boards', query: {}, cards: [{ kind: 'node' }] }] }, []))
      .toMatchObject({ error: expect.stringContaining('add_viz, add_stats, add_from_query, replace_viz, remove, create_board') });
    expect(sanitizeBoardPlan({ summary: 's', ops: [{ op: 'split_board', card_ids: ['c1'], name: 'X' }] }, CARDS))
      .toMatchObject({ error: expect.stringContaining('unknown op') });
  });
});

describe('schema + prompt after the rework', () => {
  it('the schema stays under the prompt-advisory size budget', () => {
    expect(JSON.stringify(BOARD_PLAN_SCHEMA).length).toBeLessThan(2500);
  });
  it('prompt carries create_board, the new mixing/steering lines, and no spawn/split', () => {
    const sys = buildBoardPlanSystem({ types: [] }, CARDS, new Date('2026-07-27T12:00:00Z'));
    expect(sys).toContain('create_board');
    expect(sys).toContain('EITHER card-level ops OR exactly one create_board');
    expect(sys).toContain('Creating a board is heavier than adding cards');
    expect(sys).not.toContain('spawn_boards');
    expect(sys).not.toContain('split_board');
    expect(sys.trimEnd().endsWith(currentDateLine(new Date('2026-07-27T12:00:00Z')))).toBe(true);
  });
});

describe('interpretBoardPlan', () => {
  const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
  it('happy path returns the sanitized plan with usage', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ summary: 'add a table', ops: [{ op: 'add_viz', spec: VIZ }] }) }],
        finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
      }),
    });
    const r = await interpretBoardPlan({ text: 'add a task table', cards: CARDS, vocab: { types: [] }, model });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.summary).toBe('add a table');
    expect(r.value.ops[0]).toMatchObject({ op: 'add_viz' });
    expect(r.usage.inputTokens?.total ?? r.usage.inputTokens).toBeTruthy();
  });
});

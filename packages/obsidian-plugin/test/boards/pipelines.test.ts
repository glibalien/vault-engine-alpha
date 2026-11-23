import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { makeBoardPipelines } from '../../src/boards/pipelines.js';
import type { BoardInterpreterDeps } from '../../src/boards/interpreter.js';

const env = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const CATALOG = [{ title: 'GPT-OSS 120B', provider: 'fireworks' as const, model: 'accounts/fireworks/models/gpt-oss-120b', enabled: true }];

function deps(over: Partial<BoardInterpreterDeps> = {}): BoardInterpreterDeps {
  return {
    engineCall: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'query-nodes') {
        const hit = (args.types as string[] | undefined)?.includes('project')
          ? { id: 'p1', title: 'Vault Engine' }
          : { id: 'n1', title: 'Vault Engine - Charter' };
        return env({ ok: true, data: { nodes: [hit], total: 1 }, warnings: [] });
      }
      if (name === 'list-schemas') return env({ ok: true, data: [], warnings: [] });
      return env({ ok: true, data: {}, warnings: [] });
    }),
    effective: async () => ({ settings: { vizModel: '[[GPT-OSS 120B]]' } as never, catalog: CATALOG }),
    keys: { fireworks: 'fk' },
    makeModel: () => new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ title: 'this month · by model', args: { group_by: ['model'], since: '2026-07-01' } }) }],
        finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
      }),
    }),
    recordUsage: vi.fn(), log: vi.fn(),
    ...over,
  };
}

describe('makeBoardPipelines', () => {
  it('get-node: search top hit → node spec, no LLM, no spend record', async () => {
    const d = deps();
    const got = await makeBoardPipelines(d)('get-node', 'the charter');
    expect(got).toEqual({ ok: true, spec: { kind: 'node', title: 'Vault Engine - Charter', node_id: 'n1' } });
    expect(d.engineCall).toHaveBeenCalledWith('query-nodes', { query: 'the charter', limit: 1 });
    expect(d.recordUsage).not.toHaveBeenCalled();
  });
  it('get-node: no hits → bar error', async () => {
    const d = deps({ engineCall: vi.fn(async () => env({ ok: true, data: { nodes: [], total: 0 }, warnings: [] })) });
    const got = await makeBoardPipelines(d)('get-node', 'zzz');
    expect(got).toMatchObject({ ok: false, error: expect.stringContaining('no note matched') });
  });
  it('get-node tweak: re-resolves, carrying expanded forward', async () => {
    const got = await makeBoardPipelines(deps())('get-node', 'charter', { kind: 'node', title: 'Old', node_id: 'old', expanded: true });
    expect(got).toEqual({ ok: true, spec: { kind: 'node', title: 'Vault Engine - Charter', node_id: 'n1', expanded: true } });
  });
  it('vault-stats: instant, empty text allowed, default title', async () => {
    const d = deps();
    expect(await makeBoardPipelines(d)('vault-stats', '')).toEqual({ ok: true, spec: { kind: 'stats', title: 'Vault stats' } });
    expect(await makeBoardPipelines(d)('vault-stats', 'Health')).toEqual({ ok: true, spec: { kind: 'stats', title: 'Health' } });
    expect(d.engineCall).not.toHaveBeenCalled();
  });
  it('query-nodes: delegates to the existing viz interpreter', async () => {
    const d = deps({
      makeModel: () => new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ kind: 'table', title: 't', query: { types: ['task'] }, display_fields: ['status'] }) }],
          finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
        }),
      }),
    });
    const got = await makeBoardPipelines(d)('query-nodes', 'open tasks');
    expect(got).toMatchObject({ ok: true, spec: { kind: 'table' } });
  });

  const PLAN = { summary: 'a note per active project', ops: [{ op: 'add_from_query', kind: 'node', query: { types: ['project'], fields: { status: { eq: 'active' } } } }] };
  const planModel = (plan: unknown) => new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(plan) }],
      finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
    }),
  });

  it('board: plan → one note card per matched node + spend record', async () => {
    const hits = [{ id: 'p1', title: 'Vault Engine' }, { id: 'p2', title: 'Home Lab' }];
    const d = deps({
      engineCall: vi.fn(async (name: string) => {
        if (name === 'query-nodes') return env({ ok: true, data: { nodes: hits, total: 2 }, warnings: [] });
        if (name === 'list-schemas') return env({ ok: true, data: [], warnings: [] });
        return env({ ok: true, data: {}, warnings: [] });
      }),
      makeModel: () => planModel(PLAN),
    });
    const got = await makeBoardPipelines(d)('board', 'a note card per active project', undefined, []);
    if (!got.ok || !('ops' in got)) throw new Error('expected ops');
    expect(got.summary).toBe('a note per active project');
    expect(got.capped).toBe(false);
    expect(got.ops).toEqual([
      { op: 'add', spec: { kind: 'node', title: 'Vault Engine', node_id: 'p1' } },
      { op: 'add', spec: { kind: 'node', title: 'Home Lab', node_id: 'p2' } },
    ]);
    const qn = (d.engineCall as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'query-nodes')!;
    expect(qn[1]).toMatchObject({ types: ['project'], limit: 12 });
    expect(d.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'viz-interpret' }));
  });

  it('board: partial-empty plan (one add_from_query hits, one comes up empty) → ok with real counts from the non-empty query only', async () => {
    const hits = [{ id: 'n1', title: 'Alpha' }, { id: 'n2', title: 'Beta' }];
    const plan = { summary: 'two queries, one dry', ops: [
      { op: 'add_from_query', kind: 'node', query: { types: ['task'] } },
      { op: 'add_from_query', kind: 'node', query: { types: ['archived'] } },
    ] };
    const d = deps({
      engineCall: vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'query-nodes') {
          const types = args.types as string[] | undefined;
          return types?.includes('archived')
            ? env({ ok: true, data: { nodes: [], total: 0 }, warnings: [] })
            : env({ ok: true, data: { nodes: hits, total: 2 }, warnings: [] });
        }
        if (name === 'list-schemas') return env({ ok: true, data: [], warnings: [] });
        return env({ ok: true, data: {}, warnings: [] });
      }),
      makeModel: () => planModel(plan),
    });
    const got = await makeBoardPipelines(d)('board', 'x', undefined, []);
    if (!got.ok || !('ops' in got)) throw new Error('expected ops');
    expect(got.ops).toEqual([
      { op: 'add', spec: { kind: 'node', title: 'Alpha', node_id: 'n1' } },
      { op: 'add', spec: { kind: 'node', title: 'Beta', node_id: 'n2' } },
    ]);
    expect(got.capped).toBe(false);
  });

  it('board: zero-effect plan → "matched nothing — nothing applied"', async () => {
    const d = deps({
      engineCall: vi.fn(async (name: string) => name === 'query-nodes'
        ? env({ ok: true, data: { nodes: [], total: 0 }, warnings: [] })
        : env({ ok: true, data: [], warnings: [] })),
      makeModel: () => planModel(PLAN),
    });
    const got = await makeBoardPipelines(d)('board', 'x', undefined, []);
    expect(got).toMatchObject({ ok: false, error: 'matched nothing — nothing applied' });
  });

  it('board: adds beyond 12 are dropped and flagged capped', async () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: `P${i}` }));
    const plan = { summary: 's', ops: [
      { op: 'add_from_query', kind: 'node', query: {} },
      { op: 'add_stats', title: 'extra' },
    ] };
    const d = deps({
      engineCall: vi.fn(async (name: string) => name === 'query-nodes'
        ? env({ ok: true, data: { nodes: hits, total: 12 }, warnings: [] })
        : env({ ok: true, data: [], warnings: [] })),
      makeModel: () => planModel(plan),
    });
    const got = await makeBoardPipelines(d)('board', 'x', undefined, []);
    if (!got.ok || !('ops' in got)) throw new Error('expected ops');
    expect(got.ops).toHaveLength(12);
    expect(got.capped).toBe(true);
  });

  it('board: expansion stops querying once the add cap is filled', async () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: `P${i}` }));
    const plan = { summary: 's', ops: [
      { op: 'add_from_query', kind: 'node', query: {} },
      { op: 'add_from_query', kind: 'node', query: { types: ['task'] } },
    ] };
    const d = deps({
      engineCall: vi.fn(async (name: string) => name === 'query-nodes'
        ? env({ ok: true, data: { nodes: hits, total: 12 }, warnings: [] })
        : env({ ok: true, data: [], warnings: [] })),
      makeModel: () => planModel(plan),
    });
    const got = await makeBoardPipelines(d)('board', 'x', undefined, []);
    if (!got.ok || !('ops' in got)) throw new Error('expected ops');
    expect(got.ops).toHaveLength(12);
    expect(got.capped).toBe(true);
    expect((d.engineCall as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'query-nodes')).toHaveLength(1);
  });

  it('board: expansion envelope error → bar error, no ops', async () => {
    const d = deps({
      engineCall: vi.fn(async (name: string) => name === 'query-nodes'
        ? env({ ok: false, error: { message: 'db locked' }, warnings: [] })
        : env({ ok: true, data: [], warnings: [] })),
      makeModel: () => planModel(PLAN),
    });
    const got = await makeBoardPipelines(d)('board', 'x', undefined, []);
    expect(got).toMatchObject({ ok: false, error: expect.stringContaining('db locked') });
  });

  it('board: unresolvable model → strict error before any engine call', async () => {
    const d = deps({ effective: async () => ({ settings: { vizModel: '[[Nope]]' } as never, catalog: CATALOG }) });
    const got = await makeBoardPipelines(d)('board', 'x', undefined, []);
    expect(got).toMatchObject({ ok: false, error: expect.stringContaining('[[Nope]]') });
  });

  it('board: create_board with a target resolves top-hit, substitutes name/cards, links', async () => {
    const plan = { summary: 'board for project alpha', ops: [{ op: 'create_board', target: 'project alpha onboarding', name: '{{title}} HQ',
      cards: [{ kind: 'node' }, { kind: 'viz', spec: { kind: 'table', title: '{{title}} tasks', query: { references: { target: '{{title}}', rel_type: 'project' } }, display_fields: ['status'] } }] }] };
    const d = deps({
      engineCall: vi.fn(async (name: string) => name === 'query-nodes'
        ? env({ ok: true, data: { nodes: [{ id: 'p9', title: 'Project Alpha Onboarding' }], total: 1 }, warnings: [] })
        : env({ ok: true, data: [], warnings: [] })),
      makeModel: () => planModel(plan),
    });
    const got = await makeBoardPipelines(d)('board', 'a board for project alpha', undefined, []);
    if (!got.ok || !('boardPlan' in got)) throw new Error('expected boardPlan');
    expect(got.boardPlan).toMatchObject({ kind: 'create', name: 'Project Alpha Onboarding HQ', linkNodeId: 'p9', summary: 'board for project alpha' });
    expect(got.boardPlan.cards[0]).toEqual({ kind: 'node', title: 'Project Alpha Onboarding', node_id: 'p9' });
    expect(got.boardPlan.cards[1]).toMatchObject({ title: 'Project Alpha Onboarding tasks', query: { references: { target: 'Project Alpha Onboarding' } } });
    const qn = (d.engineCall as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'query-nodes')!;
    expect(qn[1]).toEqual({ query: 'project alpha onboarding', limit: 1 });
  });
  it('board: create_board target miss → "no note matched — try different words"', async () => {
    const plan = { summary: 's', ops: [{ op: 'create_board', target: 'zzz', cards: [{ kind: 'node' }] }] };
    const d = deps({
      engineCall: vi.fn(async (name: string) => name === 'query-nodes'
        ? env({ ok: true, data: { nodes: [], total: 0 }, warnings: [] })
        : env({ ok: true, data: [], warnings: [] })),
      makeModel: () => planModel(plan),
    });
    expect(await makeBoardPipelines(d)('board', 'x', undefined, [])).toMatchObject({ ok: false, error: 'no note matched — try different words' });
  });
  it('board: targetless create_board makes no query-nodes call, no linkNodeId, verbatim cards', async () => {
    const plan = { summary: 'ops board', ops: [{ op: 'create_board', name: 'Ops', cards: [{ kind: 'stats' }, { kind: 'viz', spec: { kind: 'table', title: 'Overdue', query: { types: ['task'] }, display_fields: ['due'] } }] }] };
    const d = deps({ makeModel: () => planModel(plan) });
    const got = await makeBoardPipelines(d)('board', 'a board called Ops', undefined, []);
    if (!got.ok || !('boardPlan' in got)) throw new Error('expected boardPlan');
    expect(got.boardPlan.name).toBe('Ops');
    expect(got.boardPlan.linkNodeId).toBeUndefined();
    expect(got.boardPlan.cards[0]).toEqual({ kind: 'stats', title: 'Vault stats' });
    expect((d.engineCall as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'query-nodes')).toHaveLength(0);
  });
});

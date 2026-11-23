import { describe, expect, it } from 'vitest';
import { boardProvider, docRefProvider, nodesProvider } from '../../src/context/providers.js';
import type { ContextProviderInput } from '../../src/context/types.js';

function jsonResult(obj: unknown) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

const base: Omit<ContextProviderInput, 'call' | 'manifest' | 'state'> = { estimateTokens: (t) => t.length };

describe('boardProvider', () => {
  /** A row as query-nodes returns it: identity columns at the top, include_fields values under `fields`. */
  const row = (id: string, title: string, fields: Record<string, unknown> = {}) => ({ id, title, file_path: `Tasks/${title}.md`, types: ['task'], fields });
  const boardOf = (...specs: unknown[]) => jsonResult({ ok: true, data: { cards: specs.map((spec) => ({ spec })) } });

  it('returns null without an active board', async () => {
    const r = await boardProvider.build({ ...base, call: async () => ({ content: [] }), manifest: {}, state: { doc: true, board: true, nodes: [] } });
    expect(r).toBeNull();
  });
  it('fetches the board and its card rows, naming each note by title and id', async () => {
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'table', title: 'Open', query: {}, display_fields: ['title'] });
      return jsonResult({ ok: true, data: { nodes: [row('n1', 'N1')], total: 1 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.label).toBe('board');
    expect(r?.text).toContain('### Board — 1 view');
    expect(r?.text).toContain('    N1 (id n1)');
  });
  it('reads row values from query-nodes\' fields, not the top of the row', async () => {
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'table', title: 'Open tasks', query: { types: ['task'] }, display_fields: ['status', 'due', 'project'] });
      return jsonResult({ ok: true, data: { nodes: [row('t1', 'Draft the brief', { status: 'open', due: '2026-11-20', project: ['[[Acme rollout]]', '[[Northwind]]'] })], total: 1 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('    Draft the brief (id t1) — status: open, due: 2026-11-20, project: [[Acme rollout]]; [[Northwind]]');
    expect(r?.text).not.toContain('status: ,');
  });
  it('writes each view\'s saved query on a query line, with the limit it runs with', async () => {
    const calls: Array<[string, unknown]> = [];
    const call = async (name: string, args?: unknown) => {
      calls.push([name, args]);
      if (name === 'get-board') {
        return boardOf({
          kind: 'kanban', title: 'Rollout', group_by: 'status', display_fields: ['status', 'due'],
          query: {
            types: ['task'],
            fields: { status: { one_of: ['open', 'in-progress', 'backlog'] }, project: { includes: 'Acme rollout' } },
            query: 'launch', title_contains: 'Q3', sort_by: 'title', sort_order: 'asc',
          },
        });
      }
      return jsonResult({ ok: true, data: { nodes: [], total: 0 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('- kanban "Rollout" by status; fields: status, due');
    expect(r?.text).toContain('  query: types=[task] · status one_of [open, in-progress, backlog] · project includes "Acme rollout" · search "launch" · title_contains="Q3" · sort title asc · limit 50');
    expect(r?.text).toContain('  rows (0 of 0):');
    // The query line describes the call the view actually ran.
    expect(calls.find(([n]) => n === 'query-nodes')?.[1]).toMatchObject({ types: ['task'], limit: 50 });
  });
  it('caps board rows per view at 12 and says how to see the rest', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`n${i}`, `N${i}`));
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'table', title: 'Open', query: { limit: 100 }, display_fields: ['title'] });
      return jsonResult({ ok: true, data: { nodes: rows, total: 20 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('rows (12 of 20; run query-nodes with this query to see the rest):');
    expect(r?.text).toContain('query: limit 100');
    expect(r?.text).toContain('N11 (id n11)');
    expect(r?.text).not.toContain('N12 (id n12)');
  });
  it('shortens a long join_filters argument on the query line', async () => {
    const join_filters = Array.from({ length: 30 }, (_, i) => ({ direction: 'outgoing', rel_type: 'project', target: { title_eq: `Project ${i}` } }));
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'table', title: 'Joined', query: { types: ['task'], join_filters }, display_fields: [] });
      return jsonResult({ ok: true, data: { nodes: [], total: 0 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    const queryLine = r!.text.split('\n').find((l) => l.startsWith('  query: '))!;
    expect(queryLine).toContain('join_filters=[{');
    expect(queryLine).toContain('…');
    expect(queryLine.length).toBeLessThan(320);
  });
  it('titles a preset view saved with an empty title from its query', async () => {
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'kanban', title: '', query: { types: ['task'] }, display_fields: ['status'], group_by: 'status' });
      return jsonResult({ ok: true, data: { nodes: [], total: 0 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('- kanban "task" by status');
    expect(r?.text).not.toContain('""');
  });
  it('gives one-note, overview and spend views a line each instead of dropping them', async () => {
    const call = async (name: string, args?: unknown) => {
      if (name === 'get-board') {
        return boardOf(
          { kind: 'node', title: '', node_id: 'p1' },
          { kind: 'stats', title: '' },
          { kind: 'spend', title: 'Spend', range: '30d' },
          { kind: 'table', title: 'Open', query: {}, display_fields: [] },
        );
      }
      if ((args as { node_ids?: string[] })?.node_ids?.[0] === 'p1') return jsonResult({ ok: true, data: { nodes: [{ id: 'p1', title: 'Project Alpha' }], total: 1 } });
      return jsonResult({ ok: true, data: { nodes: [row('n1', 'N1')], total: 1 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('### Board — 4 views');
    expect(r?.text).toContain('- note view "Note": Project Alpha (id p1)');
    expect(r?.text).toContain('- overview view "Vault overview": vault counts (vault-stats)');
    expect(r?.text).toContain('- spend view "Spend": usage and cost, range 30d (usage-report)');
    expect(r?.text).toContain('    N1 (id n1)');
  });
  it('a one-note view whose title lookup fails still names the note by id', async () => {
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'node', title: 'Pinned', node_id: 'p9' });
      throw new Error('engine down');
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('- note view "Pinned": (id p9)');
  });
  it('keeps the board cap: views past 15,000 characters are counted, not printed', async () => {
    const long = 'x'.repeat(400);
    const rows = Array.from({ length: 12 }, (_, i) => row(`n${i}`, `${long}${i}`));
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf(...Array.from({ length: 6 }, (_, i) => ({ kind: 'table', title: `V${i}`, query: {}, display_fields: [] })));
      return jsonResult({ ok: true, data: { nodes: rows, total: 12 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toMatch(/- …\d+ more view\(s\) omitted \(board over cap\)/);
    expect(r!.text.length).toBeLessThan(15000 + 200);
  });
  it('gates only on the manifest: renders even when state.board is false', async () => {
    const call = async (name: string) => {
      if (name === 'get-board') return boardOf({ kind: 'table', title: 'Open', query: {}, display_fields: ['title'] });
      return jsonResult({ ok: true, data: { nodes: [row('n1', 'N1')], total: 1 } });
    };
    const r = await boardProvider.build({ ...base, call, manifest: { activeBoardId: 'b1' }, state: { doc: true, board: false, nodes: [] } });
    expect(r?.label).toBe('board');
    expect(r?.text).toContain('N1 (id n1)');
  });
});

describe('docRefProvider', () => {
  const call = async () => ({ content: [] });
  it('returns null when the doc chip is off', async () => {
    const r = await docRefProvider.build({ ...base, call, manifest: { docPath: 'a.md', docId: 'n1' }, state: { doc: false, board: true, nodes: [] } });
    expect(r).toBeNull();
  });
  it('returns null without a docPath', async () => {
    const r = await docRefProvider.build({ ...base, call, manifest: { docId: 'n1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r).toBeNull();
  });
  it('renders a reference (title, path, node id) — never document content', async () => {
    const r = await docRefProvider.build({ ...base, call, manifest: { docPath: 'Notes/Quarterly Planning.md', docId: 'n1' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.label).toBe('doc');
    expect(r?.text).toBe(
      '### Active document — Quarterly Planning (Notes/Quarterly Planning.md, node id n1)\n' +
      'The user has this document open. When they say "this" (note/doc/file), they mean this document. Fetch its content with get-node when needed.',
    );
    expect(r?.tokens).toBe(r?.text.length); // base.estimateTokens is t.length
  });
  it('warns instead of inventing a node id when it is unknown', async () => {
    const r = await docRefProvider.build({ ...base, call, manifest: { docPath: 'Notes/Scratch.md' }, state: { doc: true, board: true, nodes: [] } });
    expect(r?.text).toContain('(Notes/Scratch.md — engine node id unknown (likely not indexed))');
    expect(r?.text).toContain('may not be fetchable');
    expect(r?.text).not.toContain('node id undefined');
  });
});

/**
 * A `call` whose fan-out responses only resolve once `expected` of them have STARTED.
 * A sequential loop can never reach the barrier — the first call blocks forever — so
 * these tests fail by timeout if the fan-out regresses to awaiting one at a time.
 */
function barrierCall(expected: number, respond: (name: string) => unknown) {
  let started = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return async (name: string): Promise<never | unknown> => {
    if (name === 'get-board') {
      return jsonResult({
        ok: true,
        data: { cards: Array.from({ length: expected }, (_, i) => ({ spec: { kind: 'table', title: `V${i}`, query: {}, display_fields: ['title'] } })) },
      });
    }
    started += 1;
    if (started === expected) open();
    await gate;
    return respond(name);
  };
}

describe('context providers fan out concurrently', () => {
  it('boardProvider queries every card view in parallel', async () => {
    const call = barrierCall(3, () => jsonResult({ ok: true, data: { nodes: [{ title: 'N' }], total: 1 } }));
    const r = await boardProvider.build({
      ...base, call: call as ContextProviderInput['call'],
      manifest: { activeBoardId: 'b1' }, state: { doc: true, board: true, nodes: [] },
    });
    expect(r?.text).toContain('### Board — 3 views');
  });

  it('nodesProvider fetches every pinned node in parallel', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const call = barrierCall(ids.length, () => jsonResult({ ok: true, data: { title: 'T', types: [], body: 'x' } }));
    const r = await nodesProvider.build({
      ...base, call: call as ContextProviderInput['call'],
      manifest: {}, state: { doc: true, board: true, nodes: ids },
    });
    expect(r?.text).toContain('### Pinned nodes — 4');
  });

  it('nodesProvider keeps pinned order and still skips a failing node', async () => {
    const call = async (_name: string, args?: Record<string, unknown>) => {
      const id = args?.['node_id'];
      if (id === 'b') throw new Error('boom');
      return jsonResult({ ok: true, data: { title: `T-${String(id)}`, types: [], body: '' } });
    };
    const r = await nodesProvider.build({
      ...base, call: call as unknown as ContextProviderInput['call'],
      manifest: {}, state: { doc: true, board: true, nodes: ['a', 'b', 'c'] },
    });
    expect(r?.text).toContain('### Pinned nodes — 2');
    expect(r?.text.indexOf('T-a')).toBeLessThan(r!.text.indexOf('T-c'));
    expect(r?.text).not.toContain('T-b');
  });
});

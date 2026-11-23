import { describe, expect, it } from 'vitest';
import { memoriesProvider } from '../../src/context/memories-provider.js';
import type { ContextProviderInput } from '../../src/context/types.js';

function jsonResult(obj: unknown) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

const base: Omit<ContextProviderInput, 'call' | 'manifest' | 'state'> = { estimateTokens: (t) => t.length };
const emptyState = { doc: true, board: true, nodes: [] };

describe('memoriesProvider', () => {
  it('returns null when there are no memories', async () => {
    const call = async () => jsonResult({ ok: true, data: { memories: [], total: 0 } });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r).toBeNull();
  });

  it('returns null when the tool call fails', async () => {
    const call = async () => jsonResult({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r).toBeNull();
  });

  it('fetches vault-scoped chat memories and formats "- [category] content" lines', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return jsonResult({
        ok: true,
        data: { memories: [{ id: 1, content: 'prefers terse replies', category: 'preference', scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
      });
    };
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(calls).toHaveLength(4);
    expect(calls.map(c => c.args.source)).toEqual(['chat', 'curator', 'owner', 'claude']);
    expect(calls[0]?.name).toBe('list-memories');
    expect(calls[0]?.args).toMatchObject({ source: 'chat', scope: 'vault' });
    expect(r?.label).toBe('memories');
    expect(r?.text).toContain('### Memories');
    expect(r?.text).toContain('- [preference] prefers terse replies');
  });

  it('renders a category-less memory without a bracket prefix', async () => {
    const call = async () => jsonResult({
      ok: true,
      data: { memories: [{ id: 1, content: 'no category here', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
    });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r?.text).toContain('- no category here');
  });

  it('also fetches node-scoped memories when a docId is present', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (args.scope === 'node') {
        return jsonResult({ ok: true, data: { memories: [{ id: 2, content: 'node-specific fact', category: 'fact', scope: 'node', node_id: 'n1', created_at: '2026-07-02T00:00:00.000Z' }], total: 1 } });
      }
      return jsonResult({ ok: true, data: { memories: [{ id: 1, content: 'vault fact', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 } });
    };
    const r = await memoriesProvider.build({ ...base, call, manifest: { docId: 'n1' }, state: emptyState });
    expect(calls).toHaveLength(10);
    expect(calls[5]?.args).toMatchObject({ source: 'curator', scope: 'node', node_id: 'n1' });
    expect(calls[6]?.args).toMatchObject({ source: 'owner', scope: 'node', node_id: 'n1' });
    expect(calls[8]?.args).toEqual({ subject_of: 'n1', limit: 30 });
    expect(calls[9]?.args).toEqual({ project_of: 'n1', limit: 30 });
    expect(r?.text).toContain('- vault fact');
    expect(r?.text).toContain('- [fact] node-specific fact');
  });

  it('does not fetch node-scoped memories without a docId', async () => {
    const calls: string[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push(String(args.scope));
      return jsonResult({ ok: true, data: { memories: [{ id: 1, content: 'vault fact', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 } });
    };
    await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(calls).toEqual(['vault', 'vault', 'vault', 'vault']);
  });

  it("puts the open note's project memories after preferences and before the rest, once each (#352)", async () => {
    const m = (id: number, content: string, category: string | null, created: string) =>
      ({ id, content, category, scope: 'vault', node_id: null, created_at: created });
    const call = async (_name: string, args: Record<string, unknown>) => {
      if (args.project_of === 'meeting') {
        return jsonResult({ ok: true, data: { memories: [m(3, 'older project fact', 'fact', '2026-01-01T00:00:00.000Z'), m(1, 'prefers terse replies', 'preference', '2026-02-01T00:00:00.000Z')], total: 2 } });
      }
      if (args.source === 'curator' && args.scope === 'vault') {
        return jsonResult({ ok: true, data: { memories: [m(2, 'newest unrelated fact', 'fact', '2026-11-01T00:00:00.000Z'), m(3, 'older project fact', 'fact', '2026-01-01T00:00:00.000Z')], total: 2 } });
      }
      if (args.source === 'chat' && args.scope === 'vault') {
        return jsonResult({ ok: true, data: { memories: [m(1, 'prefers terse replies', 'preference', '2026-02-01T00:00:00.000Z')], total: 1 } });
      }
      return jsonResult({ ok: true, data: { memories: [], total: 0 } });
    };
    const r = await memoriesProvider.build({ ...base, call, manifest: { docId: 'meeting' }, state: emptyState });
    expect(r?.text.split('\n').slice(1)).toEqual([
      '- [preference] prefers terse replies',
      '- [fact] older project fact',
      '- [fact] newest unrelated fact',
    ]);
  });

  it('self-caps long memory text at the char cap', async () => {
    const longContent = 'x'.repeat(10000);
    const call = async () => jsonResult({
      ok: true,
      data: { memories: [{ id: 1, content: longContent, category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
    });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r?.text.length).toBeLessThan(longContent.length);
    expect(r?.text).toContain('…');
  });

  it('sets tokens from estimateTokens', async () => {
    const call = async () => jsonResult({
      ok: true,
      data: { memories: [{ id: 1, content: 'hi', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
    });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r?.tokens).toBe(r?.text.length);
  });

  it('§5 union: fetches curator memories too and injects both sources', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (args.source === 'curator') {
        return jsonResult({ ok: true, data: { memories: [{ id: 2, content: 'curator fact', category: 'fact', scope: 'vault', node_id: null, created_at: '2026-07-02T00:00:00.000Z' }], total: 1 } });
      }
      return jsonResult({ ok: true, data: { memories: [{ id: 1, content: 'chat fact', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 } });
    };
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(calls.map((c) => c.args.source)).toEqual(['chat', 'curator', 'owner', 'claude']);
    expect(calls.every((c) => c.name === 'list-memories')).toBe(true);
    expect(r?.text).toContain('- chat fact');
    expect(r?.text).toContain('- [fact] curator fact');
  });

  it('§5 tiering: preference/correction/rule rank above newer plain entries; recency orders within tiers', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      if (args.source === 'curator') {
        return jsonResult({ ok: true, data: { memories: [
          { id: 10, content: 'newest plain fact', category: 'fact', scope: 'vault', node_id: null, created_at: '2026-07-20T00:00:00.000Z' },
          { id: 11, content: 'old correction', category: 'correction', scope: 'vault', node_id: null, created_at: '2026-06-01T00:00:00.000Z' },
          { id: 12, content: 'oldest rule', category: 'rule', scope: 'vault', node_id: null, created_at: '2026-05-01T00:00:00.000Z' },
        ], total: 3 } });
      }
      return jsonResult({ ok: true, data: { memories: [
        { id: 20, content: 'new preference', category: 'preference', scope: 'vault', node_id: null, created_at: '2026-07-10T00:00:00.000Z' },
        { id: 21, content: 'older plain note', category: null, scope: 'vault', node_id: null, created_at: '2026-07-05T00:00:00.000Z' },
      ], total: 2 } });
    };
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    const order = ['new preference', 'old correction', 'oldest rule', 'newest plain fact', 'older plain note']
      .map((s) => r!.text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // appear in exactly this order
  });

  it('§5 truncation: drops whole oldest entries and notes the count in the header — never mid-line', async () => {
    const entry = (id: number, iso: string) => ({ id, content: `fact-${id} ${'x'.repeat(990)}`, category: null, scope: 'vault', node_id: null, created_at: iso });
    // 8 entries ≈ 1000 chars each ≫ 6000 cap → some must drop
    const memories = Array.from({ length: 8 }, (_, i) => entry(i + 1, `2026-07-0${8 - i}T00:00:00.000Z`)); // id 1 newest … id 8 oldest
    const call = async (name: string, args: Record<string, unknown>) =>
      jsonResult(args.source === 'chat' ? { ok: true, data: { memories, total: 8 } } : { ok: true, data: { memories: [], total: 0 } });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r!.text.length).toBeLessThanOrEqual(6000);
    expect(r!.text).toMatch(/^### Memories \(\+\d+ older not shown\)\n/);
    const kept = r!.text.split('\n').slice(1);
    expect(kept.length).toBeGreaterThan(0);
    for (const line of kept) expect(line).toMatch(/^- fact-\d+ x+$/); // every kept line is a COMPLETE entry
    expect(r!.text).toContain('fact-1 '); // newest kept
    expect(r!.text).not.toContain('fact-8 '); // oldest dropped
    const hidden = Number(/\(\+(\d+) older not shown\)/.exec(r!.text)?.[1]);
    expect(kept.length + hidden).toBe(8); // the note's arithmetic is exact
  });

  it('§5 union resilience: a failed curator fetch degrades to chat-only, not null', async () => {
    const call = async (name: string, args: Record<string, unknown>) =>
      args.source === 'curator'
        ? jsonResult({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } })
        : jsonResult({ ok: true, data: { memories: [{ id: 1, content: 'chat fact', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 } });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    expect(r?.text).toContain('- chat fact');
  });
  it('orders by when each memory became true (#706): a fact from an old note read today is not new', async () => {
    const call = async (_name: string, args: Record<string, unknown>) => args.source !== 'curator'
      ? jsonResult({ ok: true, data: { memories: [], total: 0 } })
      : jsonResult({ ok: true, data: { memories: [
        { id: 2, content: 'from a 2021 meeting, read today', category: null, scope: 'vault', node_id: null,
          created_at: '2026-11-20T10:00:00.000Z', valid_at: '2021-03-04T00:00:00.000Z' },
        { id: 1, content: 'from last week', category: null, scope: 'vault', node_id: null,
          created_at: '2026-11-13T10:00:00.000Z', valid_at: '2026-11-13T10:00:00.000Z' },
        { id: 3, content: 'from an Engine with no valid_at', category: null, scope: 'vault', node_id: null,
          created_at: '2026-11-15T10:00:00.000Z' },
      ], total: 3 } });
    const r = await memoriesProvider.build({ ...base, call, manifest: {}, state: emptyState });
    const lines = r!.text.split('\n').filter(line => line.startsWith('- '));
    expect(lines).toEqual(['- from an Engine with no valid_at', '- from last week', '- from a 2021 meeting, read today']);
  });
  it('ranks the memories about the open note (#554) after preferences and rules and before its project\'s', async () => {
    const m = (id: number, content: string, category: string | null, created_at: string) =>
      ({ id, content, category, scope: 'vault', node_id: null, created_at });
    const call = async (_name: string, args: Record<string, unknown>) => {
      if (args.subject_of === 'person') {
        return jsonResult({ ok: true, data: { memories: [m(3, 'Dana leads the renewal', 'fact', '2026-10-01T00:00:00.000Z')], total: 1 } });
      }
      if (args.project_of === 'person') {
        return jsonResult({ ok: true, data: { memories: [m(2, 'The renewal is due in March', 'fact', '2026-11-01T00:00:00.000Z')], total: 1 } });
      }
      if (args.source === 'chat' && args.scope === 'vault') {
        return jsonResult({ ok: true, data: { memories: [
          m(1, 'Newest unrelated fact', 'fact', '2026-11-15T00:00:00.000Z'),
          m(4, 'Keep answers short', 'preference', '2026-01-01T00:00:00.000Z'),
        ], total: 2 } });
      }
      return jsonResult({ ok: true, data: { memories: [], total: 0 } });
    };
    const r = await memoriesProvider.build({ ...base, call, manifest: { docId: 'person' }, state: emptyState });
    const lines = r!.text.split('\n').filter(line => line.startsWith('- '));
    expect(lines).toEqual([
      '- [preference] Keep answers short',
      '- [fact] Dana leads the renewal',
      '- [fact] The renewal is due in March',
      '- [fact] Newest unrelated fact',
    ]);
  });
});

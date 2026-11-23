import { describe, expect, it } from 'vitest';
import { makeBuildContext } from '../../src/chat/build-context.js';
import type { ChatContextHolder } from '../../src/chat/context-state.js';
import type { EngineCall } from '@vault/chat-core';

function jsonResult(obj: unknown) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }
const emptyCall: EngineCall = async () => ({ content: [] });

describe('makeBuildContext', () => {
  it('renders the active-doc reference from the holder', async () => {
    const holder: ChatContextHolder = { docEnabled: true, docPath: 'Notes/A.md', docId: 'n1' };
    const text = await makeBuildContext(holder, emptyCall)();
    expect(text).toContain('## Working context');
    expect(text).toContain('### Active document — A (Notes/A.md, node id n1)');
  });
  it('drops the doc section when docEnabled is false', async () => {
    const holder: ChatContextHolder = { docEnabled: false, docPath: 'Notes/A.md', docId: 'n1' };
    expect(await makeBuildContext(holder, emptyCall)()).toBe('');
  });
  it('reads the holder live: a doc set after creation is picked up at send time', async () => {
    const holder: ChatContextHolder = { docEnabled: true };
    const build = makeBuildContext(holder, emptyCall);
    expect(await build()).toBe('');
    holder.docPath = 'B.md';
    holder.docId = 'n2';
    expect(await build()).toContain('### Active document — B (B.md, node id n2)');
  });
  it('composes doc + board sections', async () => {
    const call: EngineCall = async (name) => {
      if (name === 'get-board') return jsonResult({ ok: true, data: { cards: [{ spec: { kind: 'table', title: 'Open', query: {}, display_fields: ['title'] } }] } });
      return jsonResult({ ok: true, data: { nodes: [{ title: 'N1' }], total: 1 } });
    };
    const holder: ChatContextHolder = { docEnabled: true, docPath: 'A.md', activeBoardId: 'b1' };
    const text = await makeBuildContext(holder, call)();
    expect(text).toContain('### Active document — A (A.md — engine node id unknown (likely not indexed))');
    expect(text).toContain('### Board — 1 view');
  });
  it('renders board-only context when no doc is active', async () => {
    const call: EngineCall = async (name) => {
      if (name === 'get-board') return jsonResult({ ok: true, data: { cards: [{ spec: { kind: 'table', title: 'Open', query: {}, display_fields: ['title'] } }] } });
      return jsonResult({ ok: true, data: { nodes: [{ title: 'N1' }], total: 1 } });
    };
    const holder: ChatContextHolder = { docEnabled: true, activeBoardId: 'b1' };
    const text = await makeBuildContext(holder, call)();
    expect(text).toContain('### Board — 1 view');
    expect(text).not.toContain('### Active document');
  });
  it('feeds holder.nodes into nodesProvider (pinned nodes appear in the assembled text)', async () => {
    const call: EngineCall = async (name) => {
      if (name === 'get-node') return jsonResult({ ok: true, data: { title: 'Pinned', types: ['note'], body: 'body text' } });
      return jsonResult({ ok: false });
    };
    const holder: ChatContextHolder = { docEnabled: false, nodes: ['n1'] };
    const text = await makeBuildContext(holder, call)();
    expect(text).toContain('### Pinned nodes');
    expect(text).toContain('Pinned');
  });
  it('holder.nodes undefined behaves as [] (no nodes section)', async () => {
    const call: EngineCall = async () => jsonResult({ ok: false });
    const holder: ChatContextHolder = { docEnabled: false };
    const text = await makeBuildContext(holder, call)();
    expect(text).not.toContain('Pinned nodes');
  });
  it('wires memoriesProvider: list-memories is fetched and the section renders', async () => {
    const seenToolNames: string[] = [];
    const call: EngineCall = async (name) => {
      seenToolNames.push(name);
      if (name === 'list-memories') {
        return jsonResult({
          ok: true,
          data: { memories: [{ id: 1, content: 'durable chat fact', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
        });
      }
      return jsonResult({ ok: false });
    };
    const holder: ChatContextHolder = { docEnabled: false };
    const text = await makeBuildContext(holder, call)();
    expect(seenToolNames).toContain('list-memories');
    expect(text).toContain('### Memories');
    expect(text).toContain('durable chat fact');
  });
  it('passes the holder docId through to the node-scoped memories fetch', async () => {
    const memoryCallArgs: Array<Record<string, unknown>> = [];
    const call: EngineCall = async (name, args) => {
      if (name === 'list-memories') {
        memoryCallArgs.push(args as Record<string, unknown>);
        return jsonResult({
          ok: true,
          data: { memories: [{ id: 1, content: 'durable chat fact', category: null, scope: 'vault', node_id: null, created_at: '2026-07-01T00:00:00.000Z' }], total: 1 },
        });
      }
      return jsonResult({ ok: false });
    };
    const holder: ChatContextHolder = { docEnabled: true, docId: 'n1' };
    await makeBuildContext(holder, call)();
    expect(memoryCallArgs.some((a) => a.scope === 'node' && a.node_id === 'n1')).toBe(true);
  });
});

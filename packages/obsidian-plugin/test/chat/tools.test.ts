import { describe, it, expect, vi } from 'vitest';
import { engineCallFor, chatModelCallFor, buildToolSet, CHAT_MODEL_NAME } from '../../src/chat/tools.js';
import type { EngineConnection } from '../../src/engine/transport.js';
import { vaultSettingsFrom } from '@vault/settings-registry';

function fakeConn(toolNames: string[]): EngineConnection {
  return {
    call: vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true,"data":{}}' }] })) as never,
    listTools: vi.fn(async () => toolNames.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }))),
    close: vi.fn(async () => {}),
  };
}

describe('who the Engine is told made a call', () => {
  type Run = { execute: (input: unknown, opts: unknown) => Promise<unknown> };
  const MARK = { 'vault-engine/chat-model': 'Obsidian chat' };

  it('marks every Engine call the chat model\'s tools make', async () => {
    const engine = fakeConn(['update-memory', 'query-nodes']);
    const set = await buildToolSet(engine);
    await (set['update-memory'] as never as Run).execute({ id: 1, category: 'fact' }, {});
    await (set['query-nodes'] as never as Run).execute({ types: ['task'] }, {});
    expect(engine.call).toHaveBeenCalledWith({ name: 'update-memory', arguments: { id: 1, category: 'fact' }, _meta: MARK });
    expect(engine.call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { types: ['task'] }, _meta: MARK });
    expect(CHAT_MODEL_NAME).toBe('Obsidian chat');
  });

  it('leaves the plugin\'s own calls unmarked', async () => {
    const engine = fakeConn([]);
    await engineCallFor(engine)('save-conversation', { id: 'c1' });
    expect(engine.call).toHaveBeenCalledWith({ name: 'save-conversation', arguments: { id: 'c1' } });
    await chatModelCallFor(engine)('get-node', { node_id: 'n1' });
    expect(engine.call).toHaveBeenLastCalledWith({ name: 'get-node', arguments: { node_id: 'n1' }, _meta: MARK });
  });

  it('does not mark calls to the Curator, which has its own rules', async () => {
    const curator = fakeConn(['curator-status']);
    const set = await buildToolSet(fakeConn([]), curator);
    await (set['curator-status'] as never as Run).execute({}, {});
    expect(curator.call).toHaveBeenCalledWith({ name: 'curator-status', arguments: {} });
  });
});

describe('buildToolSet', () => {
  it('wraps engine tools and adds a local present-viz tool', async () => {
    const set = await buildToolSet(fakeConn(['query-nodes', 'get-node']));
    expect(Object.keys(set)).toEqual(expect.arrayContaining(['query-nodes', 'get-node', 'present-viz']));
  });

  it('builds present-viz\'s examples from the vault map, today\'s names without one (#449)', async () => {
    const schemaText = async (vault?: Parameters<typeof buildToolSet>[2]) => {
      const set = await buildToolSet(fakeConn([]), undefined, vault);
      return JSON.stringify((set['present-viz']!.inputSchema as { jsonSchema: unknown }).jsonSchema);
    };
    expect(await schemaText()).toContain("tasks · project = \\\"Vault Engine\\\" · status != done");
    const other = await schemaText({ ...vaultSettingsFrom(undefined), taskType: 'todo', taskStatusField: 'state' });
    expect(other).toContain('todos · project');
    expect(other).toContain('Kanban: its columns (default \\"state\\").');
  });

  it('merges curator tools when a curator connection is given', async () => {
    const set = await buildToolSet(fakeConn(['query-nodes']), fakeConn(['curator-status', 'create-or-update-wiki']));
    expect(Object.keys(set)).toEqual(
      expect.arrayContaining(['query-nodes', 'curator-status', 'create-or-update-wiki', 'present-viz']),
    );
  });

  it('degrades to engine-only when the curator listTools fails (no throw)', async () => {
    const curatorConn = {
      ...fakeConn([]),
      listTools: vi.fn(async () => { throw new Error('tools/list failed'); }),
    } as unknown as EngineConnection;
    const set = await buildToolSet(fakeConn(['query-nodes']), curatorConn);
    expect(Object.keys(set)).toEqual(expect.arrayContaining(['query-nodes', 'present-viz']));
    expect(Object.keys(set)).not.toContain('curator-status');
  });

  it('keeps a single tool when engine and curator collide (engine wins)', async () => {
    const engineConn = {
      ...fakeConn([]),
      listTools: vi.fn(async () => [{ name: 'get-node', description: 'from-engine', inputSchema: { type: 'object' } }]),
    } as unknown as EngineConnection;
    const curatorConn = {
      ...fakeConn([]),
      listTools: vi.fn(async () => [{ name: 'get-node', description: 'from-curator', inputSchema: { type: 'object' } }]),
    } as unknown as EngineConnection;
    const set = await buildToolSet(engineConn, curatorConn);
    expect(Object.keys(set).filter((k) => k === 'get-node')).toHaveLength(1);
    expect((set['get-node'] as { description?: string }).description).toBe('from-engine');
  });
});

describe('engineCallFor', () => {
  it('forwards name + arguments to conn.call', async () => {
    const conn = fakeConn([]);
    await engineCallFor(conn)('query-nodes', { types: ['task'] });
    expect(conn.call).toHaveBeenCalledWith({ name: 'query-nodes', arguments: { types: ['task'] } });
  });
});

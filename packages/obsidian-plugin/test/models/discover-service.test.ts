import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { makeModelService } from '../../src/models/discover-service.js';
import type { EngineConnection } from '../../src/engine/transport.js';

const SETTINGS = { engineUrl: 'http://x/mcp', token: 't' };

/** Wrap an engine envelope as a CallToolResult (text block), like the real transport. */
const envelope = (body: unknown): CallToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(body) }] }) as CallToolResult;

/** A fake connect whose single `call` is a vi.fn the test drives per tool name. */
function fakeConnect(handler: (name: string, args: Record<string, unknown>) => unknown) {
  const call = vi.fn(async (tc: { name: string; arguments: Record<string, unknown> }) => envelope(handler(tc.name, tc.arguments)));
  const close = vi.fn(async () => {});
  const connect = vi.fn(async (): Promise<EngineConnection> => ({ call, listTools: async () => [], close }));
  return { connect, call, close };
}

describe('makeModelService.discover', () => {
  it('returns rows on ok and passes provider/query/limit', async () => {
    const { connect, call } = fakeConnect(() => ({ ok: true, data: { models: [{ model: 'a' }], total_before_limit: 1 } }));
    const svc = makeModelService(SETTINGS, connect);
    const res = await svc.discover('openrouter', 'claude');
    expect(res).toEqual({ ok: true, rows: [{ model: 'a' }] });
    expect(call).toHaveBeenCalledWith({ name: 'discover-models', arguments: { provider: 'openrouter', query: 'claude', limit: 30 } });
  });

  it('surfaces the engine error message on a failed envelope', async () => {
    const { connect } = fakeConnect(() => ({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'boom' } }));
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.discover('fireworks', 'x')).toEqual({ ok: false, message: 'boom' });
  });

  it('surfaces a thrown transport error as a message', async () => {
    const connect = vi.fn(async () => { throw new Error('no engine'); });
    const svc = makeModelService(SETTINGS, connect as never);
    expect(await svc.discover('fireworks', 'x')).toEqual({ ok: false, message: 'no engine' });
  });
});

describe('makeModelService.add with a price (#273)', () => {
  it('passes pricing to add-model only when given', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { connect } = fakeConnect((_name, args) => { seen.push(args); return { ok: true, data: { title: 'Claude', entry: {} } }; });
    const svc = makeModelService(SETTINGS, connect);
    await svc.add('anthropic', 'claude-x', { input: 3, output: 15, cache_read: 0.3 });
    await svc.add('anthropic', 'claude-y');
    expect(seen).toEqual([
      { provider: 'anthropic', model: 'claude-x', pricing: { input: 3, output: 15, cache_read: 0.3 } },
      { provider: 'anthropic', model: 'claude-y' },
    ]);
  });
});

describe('makeModelService.add', () => {
  it('returns the added title on ok', async () => {
    const { connect } = fakeConnect(() => ({ ok: true, data: { title: 'Claude', entry: {} } }));
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.add('openrouter', 'anthropic/claude')).toEqual({ ok: true, title: 'Claude' });
  });

  it('surfaces a CONFLICT message', async () => {
    const { connect } = fakeConnect(() => ({ ok: false, error: { code: 'CONFLICT', message: 'already as "Claude"' } }));
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.add('openrouter', 'anthropic/claude')).toEqual({ ok: false, message: 'already as "Claude"' });
  });
});

/** The calls a service made, without its get-settings read (which finds the settings folder). */
const nodeCalls = (call: ReturnType<typeof vi.fn>) => call.mock.calls.map(([tc]) => tc).filter((tc) => tc.name !== 'get-settings');

describe('makeModelService.toggle', () => {
  it('resolves the node id via get-node then flips enabled via update-node', async () => {
    const { connect, call } = fakeConnect((name) => {
      if (name === 'get-node') return { ok: true, data: { id: 'node-1' } };
      return { ok: true, data: {} };
    });
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.toggle('My Model', true)).toEqual({ ok: true });
    expect(nodeCalls(call)).toEqual([
      { name: 'get-node', arguments: { file_path: 'Settings/Models/My Model.md' } },
      { name: 'update-node', arguments: { node_id: 'node-1', set_fields: { enabled: false } } },
    ]);
  });

  it('stops and reports when get-node fails (no update-node call)', async () => {
    const { connect, call } = fakeConnect(() => ({ ok: false, error: { code: 'NOT_FOUND', message: 'no note' } }));
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.toggle('Gone', false)).toEqual({ ok: false, message: 'no note' });
    expect(nodeCalls(call)).toHaveLength(1);
  });

  it('reads the settings once for the catalog and every toggle of a modal session', async () => {
    const { connect, call } = fakeConnect((name) => {
      if (name === 'get-settings') return { ok: true, data: { settingsDir: 'Settings', domains: { chat: { effective: {} }, models: { catalog: [] } } } };
      if (name === 'get-node') return { ok: true, data: { id: 'node-1' } };
      return { ok: true, data: {} };
    });
    const svc = makeModelService(SETTINGS, connect);
    await svc.catalog();
    await svc.toggle('A', true);
    await svc.toggle('B', false);
    expect(call.mock.calls.filter(([tc]) => tc.name === 'get-settings')).toHaveLength(1);
  });
});

describe('makeModelService.toggle with another settings folder (#449)', () => {
  /** An Engine installed with VAULT_SETTINGS_DIR=Config: its model notes live in Config/Models/. */
  const engineWithSettingsIn = (settingsDir: string | undefined) => fakeConnect((name, args) => {
    if (name === 'get-settings') {
      return { ok: true, data: { ...(settingsDir ? { settingsDir } : {}), domains: { chat: { effective: {} }, models: { catalog: [] } } } };
    }
    if (name === 'get-node') {
      const dir = settingsDir ?? 'Settings';
      return args.file_path === `${dir}/Models/My Model.md`
        ? { ok: true, data: { id: 'node-1' } }
        : { ok: false, error: { code: 'NOT_FOUND', message: `Node not found: ${String(args.file_path)}` } };
    }
    return { ok: true, data: {} };
  });

  it('finds the model note in the settings folder Engine reports', async () => {
    const { connect, call } = engineWithSettingsIn('Config');
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.toggle('My Model', true)).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith({ name: 'get-node', arguments: { file_path: 'Config/Models/My Model.md' } });
    expect(call).toHaveBeenCalledWith({ name: 'update-node', arguments: { node_id: 'node-1', set_fields: { enabled: false } } });
  });

  it('uses Settings/Models/ when the Engine reports no settings folder (an Engine older than the vault map)', async () => {
    const { connect, call } = engineWithSettingsIn(undefined);
    const svc = makeModelService(SETTINGS, connect);
    expect(await svc.toggle('My Model', false)).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith({ name: 'get-node', arguments: { file_path: 'Settings/Models/My Model.md' } });
  });
});

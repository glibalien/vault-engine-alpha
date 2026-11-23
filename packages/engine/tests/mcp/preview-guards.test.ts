import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

describe('node preview optimistic guards', () => {
  let db: ReturnType<typeof createTestDb>;
  let vaultPath: string;
  let cleanup: () => void;
  let server: McpServer;
  let nodeId: string;

  beforeEach(() => {
    db = createTestDb();
    ({ vaultPath, cleanup } = createTempVault());
    const writeLock = new WriteLockManager();
    for (const name of ['note', 'Task', 'Extra']) {
      createSchemaDefinition(db, { name, field_claims: [] });
    }
    nodeId = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Test.md', title: 'Test',
      types: ['Task', 'note'], fields: {}, body: 'Original',
    }).node_id;
    server = new McpServer({ name: 'preview-guards', version: '0' });
    registerAllTools(server, db, { vaultPath, writeLock });
  });

  afterEach(() => { db.close(); cleanup(); });

  async function call(name: string, params: Record<string, unknown>) {
    const registered = (server as unknown as { _registeredTools: Record<string, {
      handler: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    }> })._registeredTools;
    return JSON.parse((await registered[name].handler({ node_id: nodeId, ...params })).content[0].text);
  }

  function snapshot() {
    return {
      node: db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId),
      types: db.prepare('SELECT * FROM node_types WHERE node_id = ?').all(nodeId),
      operations: db.prepare('SELECT * FROM undo_operations').all(),
      snapshots: db.prepare('SELECT * FROM undo_snapshots').all(),
      edits: db.prepare('SELECT * FROM edits_log').all(),
      bytes: readFileSync(join(vaultPath, 'Test.md'), 'utf8'),
    };
  }

  it.each([
    ['update-node', { set_body: 'Changed' }],
    ['update-node', { add_types: ['Extra'] }],
    ['update-node', { remove_types: ['Task'] }],
    // A pure rename or move is a no-op content write, which skips executeMutation's own check.
    ['update-node', { set_title: 'Renamed' }],
    ['update-node', { set_directory: 'Moved' }],
    ['delete-node', { confirm: true, referencing_nodes_limit: 10 }],
  ] as const)('%s rejects the same stale version in preview and live mode', async (tool, params) => {
    const before = snapshot();
    const preview = await call(tool, { ...params, expected_version: 99, dry_run: true });
    expect(preview).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    expect(snapshot()).toEqual(before);
    const live = await call(tool, { ...params, expected_version: 99, dry_run: false });
    expect(live).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    expect(snapshot().node).toEqual(before.node);
    expect(snapshot().bytes).toBe(before.bytes);
  });

  it('checks version in an implicit delete confirmation preview', async () => {
    const before = snapshot();
    expect(await call('delete-node', { expected_version: 99, confirm: false, referencing_nodes_limit: 10 }))
      .toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    expect(snapshot()).toEqual(before);
  });

  it.each(['Original', 'Changed'])('checks database hash before update no-op detection: %s', async body => {
    const before = snapshot();
    for (const dry_run of [true, false]) {
      expect(await call('update-node', { set_body: body, expected_content_hash: 'stale', dry_run }))
        .toMatchObject({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH' } });
      if (dry_run) expect(snapshot()).toEqual(before);
    }
  });

  it('preserves the existing update no-op version exception', async () => {
    const before = snapshot();
    expect(await call('update-node', { set_body: 'Original', expected_version: 99, dry_run: true })).toMatchObject({ ok: true });
    expect(snapshot()).toEqual(before);
    expect(await call('update-node', { set_body: 'Original', expected_version: 99 })).toMatchObject({ ok: true });
    expect(snapshot().node).toEqual(before.node);
  });

  it.each([
    [{ expected_version: 99 }, 'STALE_NODE'],
    [{ expected_content_hash: 'stale' }, 'CONTENT_HASH_MISMATCH'],
  ] as const)('checks guards before a directory move leaves anything behind: %s', async (guards, code) => {
    const before = snapshot();
    const params = { set_directory: 'Moved', ...guards };
    expect(await call('update-node', { ...params, dry_run: true }))
      .toMatchObject({ ok: false, error: { code } });
    expect(snapshot()).toEqual(before);
    expect(await call('update-node', params)).toMatchObject({ ok: false, error: { code } });
    expect(snapshot().node).toEqual(before.node);
    expect(existsSync(join(vaultPath, 'Moved'))).toBe(false);
  });

  it('moves when both guards match, in preview and live mode', async () => {
    const { version, content_hash } = snapshot().node as { version: number; content_hash: string };
    const params = { set_directory: 'Moved', expected_version: version, expected_content_hash: content_hash };
    expect(await call('update-node', { ...params, dry_run: true })).toMatchObject({ ok: true });
    expect(await call('update-node', params)).toMatchObject({ ok: true, data: { file_path: 'Moved/Test.md' } });
    expect(existsSync(join(vaultPath, 'Moved/Test.md'))).toBe(true);
  });
});

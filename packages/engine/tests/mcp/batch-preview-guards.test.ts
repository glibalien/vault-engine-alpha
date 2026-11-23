import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation, StaleNodeError } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { setToolWriteHook } from '../../src/settings/hook.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
});

afterEach(() => {
  setToolWriteHook(null);
  vi.restoreAllMocks();
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function createOriginal() {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'Sequence.md', title: 'Sequence',
    types: [], fields: {}, body: 'Original',
  });
}

function handler(syncLogger?: SyncLogger) {
  let captured!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: typeof captured) => { captured = callback; },
  } as unknown as McpServer;
  registerBatchMutate(server, db, writeLock, vaultPath, syncLogger);
  return async (args: Record<string, unknown>) => {
    const result = await captured(args) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      data?: { failed_at?: number; would_apply?: Array<{ op: string; body_changed?: boolean }>; results?: Array<{ status: string }> };
      warnings: Array<{ code: string; op_index?: number; details?: Record<string, unknown> }>;
    };
  };
}

describe('batch preview guard parity', () => {
  it.each(['update', 'create'] as const)('preserves the live no-op version exemption after an earlier %s', async first => {
    if (first === 'update') createOriginal();
    const operations = [
      first === 'update'
        ? { op: 'update', params: { file_path: 'Sequence.md', set_body: 'Changed', expected_version: 1 } }
        : { op: 'create', params: { title: 'Sequence', body: 'Changed' } },
      { op: 'update', params: { file_path: 'Sequence.md', set_body: 'Changed', expected_version: 99 } },
    ];
    const path = join(vaultPath, 'Sequence.md');
    const beforeDb = db.serialize();
    const beforeFile = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const batch = handler();

    const preview = await batch({ operations, dry_run: true });
    expect(preview.ok).toBe(true);
    expect(db.serialize()).toEqual(beforeDb);
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(beforeFile);

    const live = await batch({ operations, dry_run: false });
    expect(live).toMatchObject({ ok: true, data: { results: [{ status: 'applied' }, { status: 'applied' }] } });
    expect(preview.data?.would_apply).toHaveLength(2);
    expect(preview.data?.would_apply?.[1]).toMatchObject({ op: 'update', body_changed: false });
  });

  it('does not notify the settings hook for rolled-back preview mutations', async () => {
    createOriginal();
    const hook = vi.fn();
    setToolWriteHook(hook);
    const beforeDb = db.serialize();
    const path = join(vaultPath, 'Sequence.md');
    const beforeFile = readFileSync(path, 'utf8');
    const batch = handler();
    const operations = [{ op: 'update', params: { file_path: 'Sequence.md', set_body: 'Changed' } }];

    expect((await batch({ operations, dry_run: true })).ok).toBe(true);
    expect(db.serialize()).toEqual(beforeDb);
    expect(readFileSync(path, 'utf8')).toBe(beforeFile);
    expect(hook).not.toHaveBeenCalled();

    expect((await batch({ operations, dry_run: false })).ok).toBe(true);
    expect(hook).toHaveBeenCalledWith('Sequence.md');
  });

  it('does not call sync observers for an unchanged batch preview', async () => {
    createOriginal();
    const logger = new SyncLogger(db);
    const noop = vi.spyOn(logger, 'noop');
    const beforeDb = db.serialize();

    expect((await handler(logger)({
      dry_run: true, operations: [{ op: 'update', params: { file_path: 'Sequence.md', set_body: 'Original' } }],
    })).ok).toBe(true);

    expect(db.serialize()).toEqual(beforeDb);
    expect(noop).not.toHaveBeenCalled();
  });

  it('does not announce memory expiration during batch deletion preview', async () => {
    const node = createOriginal();
    db.prepare(`INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, evidence_kind, evidence_node_id)
      VALUES ('curator', 'vault', 'Memory', '2026-01-01', '2026-01-01', '2026-01-01', 'note', ?)`).run(node.node_id);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const beforeDb = db.serialize();

    expect((await handler()({
      dry_run: true, operations: [{ op: 'delete', params: { node_id: node.node_id } }],
    })).ok).toBe(true);

    expect(db.serialize()).toEqual(beforeDb);
    expect(existsSync(join(vaultPath, 'Sequence.md'))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('ignores simulated disk hashes on live mutations', () => {
    const node = createOriginal();
    const path = join(vaultPath, 'Sequence.md');
    writeFileSync(path, 'Unindexed edit');
    expect(() => executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: node.node_id, file_path: 'Sequence.md', title: 'Sequence',
      types: [], fields: {}, body: 'Original', expectedVersion: 99,
      previewDiskContentHash: node.rendered_hash,
    })).toThrow(StaleNodeError);
    expect(readFileSync(path, 'utf8')).toBe('Unindexed edit');
  });

  it.each(['first', 'later', 'disk-drift'] as const)('reports a skipped %s stale operation and continues previewing subsequent valid operations', async scenario => {
    createOriginal();
    const path = join(vaultPath, 'Sequence.md');
    if (scenario === 'disk-drift') writeFileSync(path, 'Unindexed edit');
    const prefix = scenario === 'later'
      ? [{ op: 'update', params: { file_path: 'Sequence.md', set_body: 'Changed', expected_version: 1 } }]
      : [];
    const operations = [
      ...prefix,
      { op: 'update', params: {
        file_path: 'Sequence.md', expected_version: 99,
        set_body: scenario === 'disk-drift' ? 'Original' : 'Different',
      } },
      { op: 'update', params: { file_path: 'Sequence.md', set_body: 'Final' } },
    ];
    const beforeDb = db.serialize();
    const beforeFile = readFileSync(path, 'utf8');
    const batch = handler();

    const preview = await batch({ operations, dry_run: true });
    expect(preview.ok).toBe(true);
    expect(db.serialize()).toEqual(beforeDb);
    expect(readFileSync(path, 'utf8')).toBe(beforeFile);
    expect(preview.data?.would_apply).toHaveLength(prefix.length + 1);
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: 'STALE_NODE', op_index: prefix.length,
      details: expect.objectContaining({ expected_version: 99 }),
    }));

    const live = await batch({ operations, dry_run: false });
    expect(live.ok).toBe(true);
    expect(live.data?.results?.[prefix.length]).toMatchObject({ status: 'stale' });
    expect(live.data?.results?.at(-1)).toMatchObject({ status: 'applied' });
    expect(readFileSync(path, 'utf8')).toContain('Final');
  });
});

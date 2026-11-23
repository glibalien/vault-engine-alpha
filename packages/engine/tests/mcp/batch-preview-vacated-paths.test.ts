import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

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
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function seed(filePath: string, title: string) {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: filePath, title,
    types: [], fields: {}, body: `${title} body`,
  });
}

function handler() {
  let captured!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: typeof captured) => { captured = callback; },
  } as unknown as McpServer;
  registerBatchMutate(server, db, writeLock, vaultPath);
  return async (args: Record<string, unknown>) => {
    const result = await captured(args) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      data?: { failed_at?: number; message?: string; would_apply?: Array<{ op: string; file_path?: string }> };
      error?: { message: string; details?: { failed_at?: number } };
    };
  };
}

type BatchResponse = Awaited<ReturnType<ReturnType<typeof handler>>>;

function failedAt(response: BatchResponse): number | undefined {
  return response.data?.failed_at ?? response.error?.details?.failed_at;
}

function snapshot(paths: string[]) {
  return paths.map(p => {
    const abs = join(vaultPath, p);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  });
}

async function previewThenApply(operations: unknown[], watched: string[]) {
  const batch = handler();
  const beforeDb = db.serialize();
  const beforeFiles = snapshot(watched);
  const preview = await batch({ operations, dry_run: true });
  expect(db.serialize()).toEqual(beforeDb);
  expect(snapshot(watched)).toEqual(beforeFiles);
  const live = await batch({ operations, dry_run: false });
  return { preview, live };
}

describe('batch preview tracks paths vacated by earlier operations', () => {
  it('previews rename-then-rename into the vacated path the same way apply runs it', async () => {
    seed('P/A.md', 'A');
    seed('P/B.md', 'B');
    const { preview, live } = await previewThenApply([
      { op: 'update', params: { file_path: 'P/B.md', set_title: 'C' } },
      { op: 'update', params: { file_path: 'P/A.md', set_title: 'B' } },
    ], ['P/A.md', 'P/B.md', 'P/C.md']);

    expect(preview.ok).toBe(true);
    expect(failedAt(preview)).toBeUndefined();
    expect(preview.data?.would_apply?.map(w => w.file_path)).toEqual(['P/C.md', 'P/B.md']);
    expect(live.ok).toBe(true);
    expect(existsSync(join(vaultPath, 'P/A.md'))).toBe(false);
    expect(readFileSync(join(vaultPath, 'P/B.md'), 'utf8')).toContain('A body');
    expect(readFileSync(join(vaultPath, 'P/C.md'), 'utf8')).toContain('B body');
  });

  it('previews delete-then-create at the vacated path the same way apply runs it', async () => {
    seed('Same.md', 'Same');
    const { preview, live } = await previewThenApply([
      { op: 'delete', params: { file_path: 'Same.md' } },
      { op: 'create', params: { title: 'Same', body: 'Replacement' } },
    ], ['Same.md']);

    expect(preview.ok).toBe(true);
    expect(failedAt(preview)).toBeUndefined();
    expect(live.ok).toBe(true);
    expect(readFileSync(join(vaultPath, 'Same.md'), 'utf8')).toContain('Replacement');
  });

  it('previews rename-then-create at the vacated path the same way apply runs it', async () => {
    seed('Old.md', 'Old');
    const { preview, live } = await previewThenApply([
      { op: 'update', params: { file_path: 'Old.md', set_title: 'New' } },
      { op: 'create', params: { title: 'Old', body: 'Fresh' } },
    ], ['Old.md', 'New.md']);

    expect(preview.ok).toBe(true);
    expect(failedAt(preview)).toBeUndefined();
    expect(live.ok).toBe(true);
    expect(readFileSync(join(vaultPath, 'Old.md'), 'utf8')).toContain('Fresh');
    expect(readFileSync(join(vaultPath, 'New.md'), 'utf8')).toContain('Old body');
  });

  it('still rejects a real unindexed file at the destination in preview and apply', async () => {
    seed('P/A.md', 'A');
    mkdirSync(join(vaultPath, 'P'), { recursive: true });
    writeFileSync(join(vaultPath, 'P/Loose.md'), 'unindexed bytes');
    const { preview, live } = await previewThenApply([
      { op: 'update', params: { file_path: 'P/A.md', set_title: 'Loose' } },
    ], ['P/A.md', 'P/Loose.md']);

    expect(failedAt(preview)).toBe(0);
    expect(preview.data?.message).toMatch(/already exists on disk/);
    expect(failedAt(live)).toBe(0);
    expect(readFileSync(join(vaultPath, 'P/Loose.md'), 'utf8')).toBe('unindexed bytes');
  });

  it('still rejects an unindexed file at a create destination in preview and apply', async () => {
    writeFileSync(join(vaultPath, 'Loose.md'), 'unindexed bytes');
    const { preview, live } = await previewThenApply([
      { op: 'create', params: { title: 'Loose', body: 'x' } },
    ], ['Loose.md']);

    expect(failedAt(preview)).toBe(0);
    expect(failedAt(live)).toBe(0);
    expect(readFileSync(join(vaultPath, 'Loose.md'), 'utf8')).toBe('unindexed bytes');
  });

  it('still rejects a destination that stays occupied in the composed preview', async () => {
    seed('P/A.md', 'A');
    seed('P/B.md', 'B');
    seed('P/C.md', 'C');
    const { preview, live } = await previewThenApply([
      { op: 'update', params: { file_path: 'P/C.md', set_title: 'D' } },
      { op: 'update', params: { file_path: 'P/A.md', set_title: 'B' } },
    ], ['P/A.md', 'P/B.md', 'P/C.md', 'P/D.md']);

    expect(failedAt(preview)).toBe(1);
    expect(failedAt(live)).toBe(1);
    expect(readFileSync(join(vaultPath, 'P/B.md'), 'utf8')).toContain('B body');
  });

  it('rejects a path re-occupied by an earlier preview operation', async () => {
    seed('P/A.md', 'A');
    seed('P/B.md', 'B');
    seed('P/X.md', 'X');
    const { preview, live } = await previewThenApply([
      { op: 'update', params: { file_path: 'P/B.md', set_title: 'C' } },
      { op: 'update', params: { file_path: 'P/A.md', set_title: 'B' } },
      { op: 'update', params: { file_path: 'P/X.md', set_title: 'B' } },
    ], ['P/A.md', 'P/B.md', 'P/C.md', 'P/X.md']);

    expect(failedAt(preview)).toBe(2);
    expect(failedAt(live)).toBe(2);
    expect(readFileSync(join(vaultPath, 'P/X.md'), 'utf8')).toContain('X body');
  });
});

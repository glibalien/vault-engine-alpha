import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { MemoryService } from '../../src/memories/service.js';
import { MemoryNoteReceipts } from '../../src/memories/note-receipts.js';
import { MemoryNoteIngest } from '../../src/memories/note-ingest.js';
import { MemoryNoteProjection } from '../../src/memories/note-projection.js';
import { registerRefreshMemoryNote } from '../../src/mcp/tools/refresh-memory-note.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';

const EV = { kind: 'conversation', ref: 'test#0' } as const;

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = tool.callback ? await tool.callback(parsed) : await tool.handler(parsed);
  return JSON.parse(result.content[0].text);
}

describe('refresh-memory-note MCP tool', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let service: MemoryService;
  let projection: MemoryNoteProjection;

  beforeEach(() => {
    db = createTestDb();
    const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
    service = new MemoryService(db);
    const receipts = new MemoryNoteReceipts(db);
    const ingest = new MemoryNoteIngest({ db, vaultPath, settingsDir: 'Settings', service, receipts });
    projection = new MemoryNoteProjection({
      db, writeLock: new WriteLockManager(), vaultPath, settingsDir: 'Settings',
      service, ingest,
    });
  });
  afterEach(() => { cleanup(); db.close(); });

  it('is registered when projection is present', () => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerRefreshMemoryNote(server, projection);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any)._registeredTools['refresh-memory-note']).toBeDefined();
  });

  it('is absent when projection is not in the server context', () => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerAllTools(server, db, {}); // no memoryNoteProjection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server as any)._registeredTools['refresh-memory-note']).toBeUndefined();
  });

  it('dry-run is pure: would_write true, file_written false', async () => {
    await service.create({ source: 'chat', content: 'dry run fact', scope: 'vault', evidence: EV });
    const server = new McpServer({ name: 'test', version: '0' });
    registerRefreshMemoryNote(server, projection);
    const res = await callTool(server, 'refresh-memory-note', { dry_run: true });
    expect(res.ok).toBe(true);
    expect(res.data.would_write).toBe(true);
    expect(res.data.file_written).toBe(false);
    expect(res.data.live_count).toBe(1);
    expect(res.data.total).toBe(1);
  });

  it('first creation: file_written true, node_id non-null', async () => {
    await service.create({ source: 'chat', content: 'create test', scope: 'vault', evidence: EV });
    const server = new McpServer({ name: 'test', version: '0' });
    registerRefreshMemoryNote(server, projection);
    const res = await callTool(server, 'refresh-memory-note', {});
    expect(res.ok).toBe(true);
    expect(res.data.file_written).toBe(true);
    expect(res.data.node_id).not.toBeNull();
  });

  it.each([
    { dry_run: true, state: 'missing' },
    { dry_run: false, state: 'missing' },
    { dry_run: true, state: 'unindexed-edit' },
    { dry_run: false, state: 'unindexed-edit' },
  ])('returns a content-hash conflict without writes for $state (dry_run=$dry_run)', async ({ dry_run, state }) => {
    const server = new McpServer({ name: 'test', version: '0' });
    registerRefreshMemoryNote(server, projection);
    expect((await callTool(server, 'refresh-memory-note', {})).ok).toBe(true);

    const path = join(vaultPath, 'Settings/Memories.md');
    if (state === 'missing') unlinkSync(path);
    else writeFileSync(path, `${readFileSync(path, 'utf8')}\nUnindexed human edit\n`);
    const beforeDb = db.serialize();
    const beforeFile = existsSync(path) ? readFileSync(path, 'utf8') : null;

    const result = await callTool(server, 'refresh-memory-note', { dry_run });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH' } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(beforeFile);
  });

  it('no-op refresh: file_written false on unchanged data', async () => {
    await service.create({ source: 'chat', content: 'stable', scope: 'vault', evidence: EV });
    const server = new McpServer({ name: 'test', version: '0' });
    registerRefreshMemoryNote(server, projection);
    await callTool(server, 'refresh-memory-note', {});
    const res = await callTool(server, 'refresh-memory-note', {});
    expect(res.ok).toBe(true);
    expect(res.data.file_written).toBe(false);
  });
});

import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { referenceEditFixture } from '../helpers/reference-edit.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

function handler(db: Database.Database, vaultPath: string) {
  let callback!: (params: Record<string, unknown>) => Promise<unknown>;
  const server = { tool: (_name: string, _description: string, _schema: unknown, cb: typeof callback) => { callback = cb; } } as unknown as McpServer;
  registerUpdateNode(server, db, new WriteLockManager(), vaultPath);
  return async (params: Record<string, unknown>) => {
    const result = await callback(params) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text);
  };
}

it('acquires a write transaction before reading membership on a second connection, then combines independent intents', async () => {
  const f = referenceEditFixture();
  const dbPath = join(f.vaultPath, 'test.sqlite');
  await f.db.backup(dbPath);
  const reads: string[] = [];
  const a = new Database(dbPath);
  const b = new Database(dbPath, { verbose(sql) { if (typeof sql === 'string') reads.push(sql); } });
  sqliteVec.load(a); sqliteVec.load(b);
  a.pragma('journal_mode = WAL'); b.pragma('journal_mode = WAL'); b.pragma('busy_timeout = 0');
  const callA = handler(a, f.vaultPath);
  const callB = handler(b, f.vaultPath);
  const request = (target: string) => ({ node_id: f.taskId, reference_edit: { field: 'project', action: 'add', target: { node_id: target } }, dry_run: false });
  try {
    a.exec('BEGIN IMMEDIATE');
    reads.length = 0;
    expect(await callB(request(f.projectIds[2]))).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { reason: 'writer_busy' } } });
    expect(reads.some(sql => sql.startsWith('SELECT'))).toBe(false);
    a.exec('ROLLBACK');
    expect(await callA(request(f.projectIds[1]))).toMatchObject({ ok: true });
    reads.length = 0;
    expect(await callB(request(f.projectIds[2]))).toMatchObject({ ok: true });
    expect(reads.findIndex(sql => sql.startsWith('BEGIN IMMEDIATE'))).toBeLessThan(reads.findIndex(sql => sql.startsWith('SELECT')));
    const row = b.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(f.taskId) as { value_json: string };
    expect(JSON.parse(row.value_json)).toEqual(['P1', 'P2', 'P3']);
  } finally { if (a.inTransaction) a.exec('ROLLBACK'); a.close(); b.close(); f.cleanup(); }
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

function insertSyncRow(db: Database.Database, timestamp: number, event: string) {
  db.prepare('INSERT INTO sync_log (timestamp, file_path, event, source, details) VALUES (?, ?, ?, ?, ?)')
    .run(timestamp, 'a.md', event, 'watcher', '{}');
}

describe('vault-stats — db/wal bytes + watcher liveness', () => {
  let db: Database.Database;
  let server: McpServer;
  beforeEach(() => {
    db = createTestDb();
    server = new McpServer({ name: 'test', version: '0' });
    registerVaultStats(server, db);
  });
  afterEach(() => { db.close(); });

  it('reports db_bytes (> 0) and wal_bytes (a number)', async () => {
    const payload = JSON.parse((await callTool(server, 'vault-stats', {})).content[0].text);
    expect(payload.data.db_bytes).toBeGreaterThan(0);
    expect(typeof payload.data.wal_bytes).toBe('number');
  });

  it('marks the watcher active when the latest sync event is recent', async () => {
    insertSyncRow(db, Date.now() - 5_000, 'watcher-event');
    const payload = JSON.parse((await callTool(server, 'vault-stats', {})).content[0].text);
    expect(payload.data.watcher.state).toBe('active');
    expect(typeof payload.data.watcher.last_event_at).toBe('string');
  });

  it('marks the watcher idle when the latest event is old, and null when none', async () => {
    const idle = JSON.parse((await callTool(server, 'vault-stats', {})).content[0].text);
    expect(idle.data.watcher.state).toBe('idle');
    expect(idle.data.watcher.last_event_at).toBeNull();

    insertSyncRow(db, Date.now() - 120_000, 'watcher-event');
    const old = JSON.parse((await callTool(server, 'vault-stats', {})).content[0].text);
    expect(old.data.watcher.state).toBe('idle');
    expect(typeof old.data.watcher.last_event_at).toBe('string');
  });
});

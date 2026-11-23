import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { upgradeForArchiveLog } from '../../src/db/migrate.js';
import { ArchiveLog } from '../../src/extraction/archive-log.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';

let db: Database.Database;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getHandler(): () => Promise<any> {
  let captured: () => Promise<any>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      captured = () => Promise.resolve(handler({})) as Promise<any>;
    },
  } as unknown as McpServer;
  registerVaultStats(fakeServer, db);
  return captured!;
}

beforeEach(() => {
  db = createTestDb();
});

describe('vault-stats archive counters', () => {
  it('reports zeros when archive_log does not exist (pre-migration DB)', async () => {
    const body = parseResult(await getHandler()());
    expect(body.ok).toBe(true);
    expect(body.data.archived_sources).toBe(0);
    expect(body.data.archived_bytes).toBe(0);
  });

  it('sums archive_log rows', async () => {
    upgradeForArchiveLog(db);
    const log = new ArchiveLog(db);
    log.record({ vaultPath: 'a.m4a', contentHash: 'h', bytes: 1000, mode: 'archive', archivePath: 'x', materializedNodeId: null, operationId: null });
    log.record({ vaultPath: 'b.m4a', contentHash: 'h', bytes: 500, mode: 'purge', archivePath: null, materializedNodeId: null, operationId: null });
    const body = parseResult(await getHandler()());
    expect(body.data.archived_sources).toBe(2);
    expect(body.data.archived_bytes).toBe(1500);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerQueryEditsLog } from '../../src/mcp/tools/query-edits-log.js';
import { fullIndex } from '../../src/indexer/index.js';
import { startReconciler } from '../../src/sync/reconciler.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

let db: Database.Database;

function getToolHandler(registerFn: (server: McpServer, db: Database.Database) => void) {
  let capturedHandler: (args: Record<string, unknown>) => unknown;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      capturedHandler = (args) => handler(args);
    },
  } as unknown as McpServer;
  registerFn(fakeServer, db);
  return capturedHandler!;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function insertRow(nodeId: string | null, eventType: string, details: Record<string, unknown>, timestamp?: number): void {
  insertStored(nodeId, eventType, JSON.stringify(details), timestamp);
}

/** A row with `details` stored exactly as given, JSON or not. */
function insertStored(nodeId: string | null, eventType: string, details: string | null, timestamp?: number): void {
  db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)')
    .run(nodeId, timestamp ?? Date.now(), eventType, details);
}

function isJsonObject(stored: string | null): boolean {
  if (stored === null) return false;
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

async function callTool(params: Record<string, unknown>): Promise<any> {
  const handler = getToolHandler(registerQueryEditsLog);
  return parseResult(await handler(params) as any) as any;
}

describe('query-edits-log tool', () => {
  it('returns all entries for a node', async () => {
    insertRow('n1', 'value-coerced', { field: 'date' });
    insertRow('n1', 'field-defaulted', { field: 'status' });
    insertRow('n2', 'value-coerced', { field: 'x' });

    const body = await callTool({ node_id: 'n1' });
    expect(body.ok).toBe(true);
    expect(body.warnings).toEqual([]);
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.rows.every((r: any) => r.node_id === 'n1')).toBe(true);
  });

  it('filters by event_types', async () => {
    insertRow('n1', 'value-coerced', {});
    insertRow('n1', 'merge-conflict', { property: 'enum' });

    const body = await callTool({ node_id: 'n1', event_types: ['merge-conflict'] });
    expect(body.ok).toBe(true);
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0].event_type).toBe('merge-conflict');
  });

  it('respects limit and flags truncation', async () => {
    for (let i = 0; i < 10; i++) insertRow('n1', 'value-coerced', { i });

    const body = await callTool({ node_id: 'n1', limit: 3 });
    expect(body.ok).toBe(true);
    expect(body.data.rows).toHaveLength(3);
    expect(body.data.truncated).toBe(true);
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'RESULT_TRUNCATED' })]),
    );
  });

  it('defaults to newest-first (desc) ordering', async () => {
    insertRow('n1', 'value-coerced', {}, 1000);
    insertRow('n1', 'field-defaulted', {}, 2000);

    const body = await callTool({ node_id: 'n1' });
    expect(body.ok).toBe(true);
    expect(body.data.rows[0].event_type).toBe('field-defaulted');
    expect(body.data.rows[1].event_type).toBe('value-coerced');
  });

  it('supports asc sort order', async () => {
    insertRow('n1', 'value-coerced', {}, 1000);
    insertRow('n1', 'field-defaulted', {}, 2000);

    const body = await callTool({ node_id: 'n1', sort_order: 'asc' });
    expect(body.data.rows[0].event_type).toBe('value-coerced');
    expect(body.data.rows[1].event_type).toBe('field-defaulted');
  });

  it('filters by since with relative time', async () => {
    insertRow('n1', 'value-coerced', {}, Date.now() - 7200_000);
    insertRow('n1', 'field-defaulted', {}, Date.now() - 1800_000);

    const body = await callTool({ node_id: 'n1', since: '1h' });
    expect(body.ok).toBe(true);
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0].event_type).toBe('field-defaulted');
  });

  it('returns all nodes when no node_id specified', async () => {
    insertRow('n1', 'value-coerced', {});
    insertRow('n2', 'field-defaulted', {});
    insertRow(null, 'value-removed', { field: 'g' }); // global-field discard (node_id null)

    const body = await callTool({});
    expect(body.ok).toBe(true);
    expect(body.data.rows).toHaveLength(3);
  });

  it('parses details JSON and surfaces id + ISO time', async () => {
    insertRow('n1', 'value-coerced', { field: 'date', coerced_value: '2026-01-01' }, 1000000);

    const body = await callTool({ node_id: 'n1' });
    expect(body.ok).toBe(true);
    expect(body.data.rows[0].details).toEqual({ field: 'date', coerced_value: '2026-01-01' });
    expect(body.data.rows[0].time).toBe(new Date(1000000).toISOString());
    expect(body.data.rows[0].timestamp).toBe(1000000);
    expect(typeof body.data.rows[0].id).toBe('number');
  });
});

describe('query-edits-log: details that are not a JSON object (#512)', () => {
  it('returns each under text, and every other row of the window as before', async () => {
    insertRow('n1', 'value-coerced', { field: 'date' }, 1000);
    insertStored('n1', 'file-indexed', 'Notes/a.md', 2000);
    insertStored(null, 'index-error', 'Notes/b.md: Unexpected token', 3000);
    insertStored(null, 'other-event', '"a bare string"', 4000);
    insertStored(null, 'other-event', '42', 5000);
    insertStored(null, 'other-event', '[1,2]', 6000);
    insertStored(null, 'other-event', 'null', 7000);
    insertStored(null, 'other-event', '', 8000);
    insertStored(null, 'other-event', null, 9000);
    insertRow('n1', 'field-defaulted', { field: 'status' }, 10000);

    const body = await callTool({ sort_order: 'asc' });
    expect(body.ok).toBe(true);
    expect(body.data.rows.map((r: any) => r.details)).toEqual([
      { field: 'date' },
      { text: 'Notes/a.md' },
      { text: 'Notes/b.md: Unexpected token' },
      { text: '"a bare string"' },
      { text: '42' },
      { text: '[1,2]' },
      { text: 'null' },
      {},
      {},
      { field: 'status' },
    ]);
  });

  it('reads every row the Engine writes while indexing and reconciling a vault', async () => {
    const { vaultPath, cleanup } = createTempVault();
    // A file neither the index nor the reconciler can read: an index-error row, a
    // reconciler-error row and the sweep's summary, beside each note's file-indexed row.
    const unreadable = join(vaultPath, 'unreadable.md');
    writeFileSync(unreadable, '---\ntypes:\n---\n# X\n', 'utf-8');
    chmodSync(unreadable, 0o000);
    try {
      fullIndex(vaultPath, db);
      const reconciler = startReconciler(
        vaultPath, db, new IndexMutex(), new WriteLockManager(), undefined, undefined,
        { initialDelayMs: 10, intervalMs: 60_000 },
      );
      await new Promise(resolve => setTimeout(resolve, 150));
      reconciler.stop();
    } finally {
      chmodSync(unreadable, 0o644);
      cleanup();
    }

    const stored = db.prepare('SELECT event_type, details FROM edits_log').all() as Array<{
      event_type: string; details: string | null;
    }>;
    const events = new Set(stored.map(r => r.event_type));
    expect(events).toContain('file-indexed');
    expect(events).toContain('index-error');
    expect(events).toContain('reconciler-error');
    expect(events).toContain('reconciler-sweep');

    // Writers store a JSON object. The indexer's two plain-text writers are the only
    // ones left (indexer.ts is changing under #510); the reader covers their rows.
    const plainTextWriters = new Set(['file-indexed', 'index-error']);
    expect(stored.filter(r => !isJsonObject(r.details) && !plainTextWriters.has(r.event_type))).toEqual([]);

    const body = await callTool({ limit: 1000 });
    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(stored.length);
    for (const row of body.data.rows) {
      expect(row.details !== null && typeof row.details === 'object' && !Array.isArray(row.details)).toBe(true);
    }
  });
});

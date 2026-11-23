import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { createTempVault } from '../helpers/vault.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

function batch(args: Record<string, unknown>): Promise<Record<string, any>> {
  let handler!: (args: Record<string, unknown>) => Promise<unknown>;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: (...a: unknown[]) => unknown) => {
      handler = (a) => h(a) as Promise<unknown>;
    },
  } as unknown as McpServer;
  registerBatchMutate(fakeServer, db, writeLock, vaultPath);
  return handler(args).then(r => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text));
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUndoTables(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
  createSchemaDefinition(db, { name: 'note', field_claims: [] });
});

afterEach(() => { db.close(); cleanup(); });

// #447: a dry run renders a renamed note with the key order the live rename
// keeps, though the preview does not move its file.
describe('batch-mutate preview keeps the note\'s key order through a rename', () => {
  it('previews the same versions the live batch reaches', async () => {
    writeFileSync(join(vaultPath, 'Plan.md'), '---\ntypes:\n  - note\nzeta: 1\nalpha: two\n---\nBody\n', 'utf-8');
    processFileChange(join(vaultPath, 'Plan.md'), 'Plan.md', db, writeLock, vaultPath);
    const { id, version } = db.prepare('SELECT id, version FROM nodes WHERE file_path = ?').get('Plan.md') as { id: string; version: number };
    const operations = [
      { op: 'update', params: { node_id: id, set_title: 'Plan renamed' } },
      { op: 'update', params: { node_id: id, set_fields: { beta: 'b' }, expected_version: version + 1 } },
    ];

    const preview = await batch({ dry_run: true, operations });
    expect(preview.ok).toBe(true);
    expect(preview.data.failed_at).toBeUndefined();
    expect(preview.warnings.map((w: { code: string }) => w.code)).not.toContain('STALE_NODE');
    expect(preview.data.would_apply).toHaveLength(2);

    const live = await batch({ operations });
    expect(live.ok).toBe(true);
    expect(live.data.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'applied']);
    expect(readFileSync(join(vaultPath, 'Plan renamed.md'), 'utf-8'))
      .toBe('---\ntypes:\n  - note\nzeta: 1\nalpha: two\nbeta: b\n---\nBody\n');
  });
});

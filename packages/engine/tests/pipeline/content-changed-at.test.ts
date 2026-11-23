import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

let vaultPath: string; let cleanup: () => void;
let db: Database.Database; let writeLock: WriteLockManager;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:'); createSchema(db); addUndoTables(db); addUiHints(db);
  writeLock = new WriteLockManager();
});
afterEach(() => { db.close(); cleanup(); });

const readRow = (id: string) =>
  db.prepare('SELECT content_changed_at, file_mtime, content_hash FROM nodes WHERE id = ?').get(id) as
    { content_changed_at: number; file_mtime: number; content_hash: string };

describe('content_changed_at via the MCP write path', () => {
  it('is set on INSERT and advances when content changes', () => {
    const id = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'N.md', title: 'N', types: [], fields: {}, body: 'v0',
    }).node_id;
    const a = readRow(id);
    expect(a.content_changed_at).toBe(a.file_mtime); // set on insert

    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: id, file_path: 'N.md', title: 'N', types: [], fields: {}, body: 'v1',
    });
    const b = readRow(id);
    expect(b.content_hash).not.toBe(a.content_hash);
    expect(b.content_changed_at).toBe(b.file_mtime);                // advanced with the change
    expect(b.content_changed_at).toBeGreaterThanOrEqual(a.content_changed_at);
  });
});

describe('content_changed_at via the indexer path (the Sync-touch case)', () => {
  it('does NOT advance when only the file mtime changes (content identical)', () => {
    const abs = join(vaultPath, 'Doc.md');
    writeFileSync(abs, '---\ntitle: Doc\n---\nbody\n');
    const id = indexFile(abs, vaultPath, db);
    const a = readRow(id);
    expect(a.content_changed_at).toBe(a.file_mtime);

    // Simulate an Obsidian Sync touch: bump fs mtime, same bytes.
    const later = new Date(a.file_mtime + 60_000);
    utimesSync(abs, later, later);
    indexFile(abs, vaultPath, db);
    const b = readRow(id);
    expect(b.content_hash).toBe(a.content_hash);                    // content unchanged
    expect(b.content_changed_at).toBe(a.content_changed_at);        // recency basis frozen
    expect(b.file_mtime).toBe(a.file_mtime + 60_000);              // mtime DID advance (touch was real)
  });
});

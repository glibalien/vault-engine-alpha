import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { sha256 } from '../../src/indexer/hash.js';
import { createTempVault } from '../helpers/vault.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addUiHints(db);
  writeLock = new WriteLockManager();
});

afterEach(() => {
  db.close();
  cleanup();
});

// A file rename changes only identity (file_path + title), not content. For a
// tool-written node the on-disk bytes equal the canonical render, so the no-op
// short-circuit's hash comparison alone cannot distinguish "nothing changed"
// from "renamed without edits" — identity must be part of the no-op condition.
describe('executeMutation — rename is never a no-op', () => {
  it('updates file_path, title, and FTS when a known node arrives at a new path with unchanged content', () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'old-name.md',
      title: 'old-name',
      types: [],
      fields: {},
      body: 'stable body',
    });

    renameSync(join(vaultPath, 'old-name.md'), join(vaultPath, 'new-name.md'));
    const content = readFileSync(join(vaultPath, 'new-name.md'), 'utf-8');

    const result = executeMutation(db, writeLock, vaultPath, {
      source: 'watcher',
      node_id: created.node_id,
      file_path: 'new-name.md',
      title: 'new-name',
      types: [],
      fields: {},
      body: 'stable body',
      db_only: true,
      source_content_hash: sha256(content),
    });

    expect(result.node_id).toBe(created.node_id);

    const row = db.prepare('SELECT file_path, title FROM nodes WHERE id = ?')
      .get(created.node_id) as { file_path: string; title: string };
    expect(row.file_path).toBe('new-name.md');
    expect(row.title).toBe('new-name');

    // nodes_fts is contentless (content='') — column reads return NULL, so
    // verify the reindexed title via MATCH.
    const ftsCount = (q: string): number =>
      (db.prepare('SELECT count(*) AS c FROM nodes_fts WHERE nodes_fts MATCH ?').get(q) as { c: number }).c;
    expect(ftsCount('title:new')).toBe(1);
    expect(ftsCount('title:old')).toBe(0);
  });

  it('still short-circuits as a no-op when nothing changed at all', () => {
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: 'same.md',
      title: 'same',
      types: [],
      fields: {},
      body: 'stable body',
    });
    const versionBefore = (db.prepare('SELECT version FROM nodes WHERE id = ?')
      .get(created.node_id) as { version: number }).version;

    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: created.node_id,
      file_path: 'same.md',
      title: 'same',
      types: [],
      fields: {},
      body: 'stable body',
    });

    const versionAfter = (db.prepare('SELECT version FROM nodes WHERE id = ?')
      .get(created.node_id) as { version: number }).version;
    expect(versionAfter).toBe(versionBefore);
  });
});

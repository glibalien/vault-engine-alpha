import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { startReconciler } from '../../src/sync/reconciler.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

const CONTENT = '---\ntypes:\n---\nStable body content\n';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  return db;
}

function nodeAt(db: Database.Database, filePath: string): { id: string; title: string | null } | undefined {
  return db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as
    | { id: string; title: string | null }
    | undefined;
}

function deletedIds(db: Database.Database): string[] {
  return (db.prepare("SELECT node_id FROM edits_log WHERE event_type = 'file-deleted'").all() as
    Array<{ node_id: string }>).map(r => r.node_id);
}

describe('offline rename identity (fullIndex)', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-rename-identity-test-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('preserves node id when a file was renamed while the engine was down', () => {
    writeFileSync(join(vaultPath, 'a.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);
    const before = nodeAt(db, 'a.md');
    expect(before).toBeDefined();

    renameSync(join(vaultPath, 'a.md'), join(vaultPath, 'b.md'));
    fullIndex(vaultPath, db);

    const after = nodeAt(db, 'b.md');
    expect(after?.id).toBe(before!.id);
    expect(after?.title).toBe('b');
    expect(nodeAt(db, 'a.md')).toBeUndefined();
    expect(deletedIds(db)).not.toContain(before!.id);
  });

  it('deletes and re-creates when content changed during the offline rename', () => {
    writeFileSync(join(vaultPath, 'a.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);
    const before = nodeAt(db, 'a.md')!;

    rmSync(join(vaultPath, 'a.md'));
    writeFileSync(join(vaultPath, 'c.md'), '---\ntypes:\n---\nEntirely new content\n', 'utf-8');
    fullIndex(vaultPath, db);

    const after = nodeAt(db, 'c.md');
    expect(after).toBeDefined();
    expect(after!.id).not.toBe(before.id);
    expect(deletedIds(db)).toContain(before.id);
  });

  it('does not rename-match blank files', () => {
    writeFileSync(join(vaultPath, 'empty-a.md'), '', 'utf-8');
    fullIndex(vaultPath, db);
    const before = nodeAt(db, 'empty-a.md')!;

    rmSync(join(vaultPath, 'empty-a.md'));
    writeFileSync(join(vaultPath, 'empty-b.md'), '', 'utf-8');
    fullIndex(vaultPath, db);

    const after = nodeAt(db, 'empty-b.md');
    expect(after).toBeDefined();
    expect(after!.id).not.toBe(before.id);
    expect(deletedIds(db)).toContain(before.id);
  });

  it('re-resolves inbound edges after an offline rename', () => {
    writeFileSync(join(vaultPath, 'a.md'), CONTENT, 'utf-8');
    writeFileSync(join(vaultPath, 'link.md'), '---\ntypes:\n---\nSee [[a]]\n', 'utf-8');
    fullIndex(vaultPath, db);
    const aId = nodeAt(db, 'a.md')!.id;
    const linkId = nodeAt(db, 'link.md')!.id;
    const edge = () => db.prepare(
      "SELECT resolved_target_id FROM relationships WHERE source_id = ? AND target = 'a'",
    ).get(linkId) as { resolved_target_id: string | null };
    expect(edge().resolved_target_id).toBe(aId);

    renameSync(join(vaultPath, 'a.md'), join(vaultPath, 'b.md'));
    fullIndex(vaultPath, db);

    expect(nodeAt(db, 'b.md')?.id).toBe(aId);
    // [[a]] no longer matches any note — the stale resolution must be cleared,
    // exactly as the pre-fix delete + backfill path would have done.
    expect(edge().resolved_target_id).toBeNull();
  });

  it('refuses ambiguous pairing: identical content, different basenames', () => {
    writeFileSync(join(vaultPath, 'x.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);
    const xId = nodeAt(db, 'x.md')!.id;

    rmSync(join(vaultPath, 'x.md'));
    writeFileSync(join(vaultPath, 'p.md'), CONTENT, 'utf-8');
    writeFileSync(join(vaultPath, 'q.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);

    // One missing node, two identical new paths — no defensible pairing.
    expect(nodeAt(db, 'p.md')!.id).not.toBe(xId);
    expect(nodeAt(db, 'q.md')!.id).not.toBe(xId);
    expect(deletedIds(db)).toContain(xId);
  });

  it('pairs ambiguous hashes by basename: folder move of identical templated notes', () => {
    writeFileSync(join(vaultPath, 't1.md'), CONTENT, 'utf-8');
    writeFileSync(join(vaultPath, 't2.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);
    const t1Id = nodeAt(db, 't1.md')!.id;
    const t2Id = nodeAt(db, 't2.md')!.id;

    mkdirSync(join(vaultPath, 'sub'));
    renameSync(join(vaultPath, 't1.md'), join(vaultPath, 'sub', 't1.md'));
    renameSync(join(vaultPath, 't2.md'), join(vaultPath, 'sub', 't2.md'));
    fullIndex(vaultPath, db);

    expect(nodeAt(db, join('sub', 't1.md'))?.id).toBe(t1Id);
    expect(nodeAt(db, join('sub', 't2.md'))?.id).toBe(t2Id);
    expect(deletedIds(db)).toHaveLength(0);
  });

  it('does not steal identity from a surviving duplicate-content file', () => {
    writeFileSync(join(vaultPath, 'x.md'), CONTENT, 'utf-8');
    writeFileSync(join(vaultPath, 'y.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);
    const xId = nodeAt(db, 'x.md')!.id;
    const yId = nodeAt(db, 'y.md')!.id;

    rmSync(join(vaultPath, 'x.md'));
    fullIndex(vaultPath, db);

    // y.md is not a new path, so x's deletion must not be treated as a rename.
    expect(nodeAt(db, 'y.md')!.id).toBe(yId);
    expect(deletedIds(db)).toContain(xId);
  });
});

describe('offline rename identity (reconciler sweep)', () => {
  let vaultPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-rename-reconciler-test-'));
    db = openDb();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('preserves node id when the sweep sees a rename', async () => {
    writeFileSync(join(vaultPath, 'a.md'), CONTENT, 'utf-8');
    fullIndex(vaultPath, db);
    const before = nodeAt(db, 'a.md')!;

    renameSync(join(vaultPath, 'a.md'), join(vaultPath, 'b.md'));

    const mutex = new IndexMutex();
    const reconciler = startReconciler(
      vaultPath,
      db,
      mutex,
      new WriteLockManager(),
      undefined,
      undefined,
      { initialDelayMs: 10, intervalMs: 60_000 },
    );
    await new Promise(resolve => setTimeout(resolve, 200));
    await mutex.onIdle();
    reconciler.stop();

    const after = nodeAt(db, 'b.md');
    expect(after?.id).toBe(before.id);
    expect(after?.title).toBe('b');
    expect(nodeAt(db, 'a.md')).toBeUndefined();
    expect(deletedIds(db)).not.toContain(before.id);
  });
});

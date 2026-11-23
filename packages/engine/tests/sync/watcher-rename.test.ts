import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { startWatcher, type VaultWatcher } from '../../src/sync/watcher.js';
import { upgradeBoardsStore, upgradeBoardLinksStore, saveBoard, linkBoardToDoc, listBoardsForDoc } from '../../src/boards/store.js';

// Debounce must exceed chokidar's ~100ms atomic-write hold on unlink events so
// the unlink side of a rename is stashed before the add side fires (production:
// 2500ms debounce vs 100ms hold — same ordering, wider margins).
const DEBOUNCE_MS = 200;
const MAX_WAIT_MS = 400;
const RENAME_GRACE_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nodeCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) as cnt FROM nodes').get() as { cnt: number };
  return row.cnt;
}

function nodeAt(db: Database.Database, filePath: string): { id: string; title: string | null } | undefined {
  return db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as
    | { id: string; title: string | null }
    | undefined;
}

function deletedIds(db: Database.Database): string[] {
  return (db.prepare("SELECT node_id FROM edits_log WHERE event_type = 'file-deleted'").all() as
    Array<{ node_id: string }>).map(row => row.node_id);
}

describe('watcher rename identity', () => {
  let vaultPath: string;
  let db: Database.Database;
  let mutex: IndexMutex;
  let writeLock: WriteLockManager;
  let watcher: VaultWatcher;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-watcher-rename-test-'));
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });

    writeFileSync(
      join(vaultPath, 'initial.md'),
      '---\ntitle: Initial\n---\nSome content\n',
      'utf-8',
    );

    db = new Database(join(vaultPath, '.vault-engine', 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);
    createSchema(db);
    upgradeBoardsStore(db);
    upgradeBoardLinksStore(db);

    fullIndex(vaultPath, db);

    mutex = new IndexMutex();
    writeLock = new WriteLockManager();

    watcher = startWatcher(vaultPath, db, mutex, writeLock, new SyncLogger(db), undefined, undefined, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
      renameGraceMs: RENAME_GRACE_MS,
    });

    await watcher.waitUntilReady();
  });

  afterEach(async () => {
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('preserves node id, updates path/title, and logs rename-detected on a file rename', async () => {
    const before = nodeAt(db, 'initial.md');
    expect(before).toBeDefined();
    const count = nodeCount(db);

    renameSync(join(vaultPath, 'initial.md'), join(vaultPath, 'renamed-note.md'));

    await delay(DEBOUNCE_MS + 300);
    await mutex.onIdle();

    const after = nodeAt(db, 'renamed-note.md');
    expect(after?.id).toBe(before!.id);
    expect(after?.title).toBe('renamed-note');
    expect(nodeAt(db, 'initial.md')).toBeUndefined();
    expect(nodeCount(db)).toBe(count);

    // The pending delete for the old path must have been cancelled — the node
    // still exists after the grace period elapses.
    await delay(RENAME_GRACE_MS + 200);
    await mutex.onIdle();
    expect(nodeAt(db, 'renamed-note.md')?.id).toBe(before!.id);

    const logged = db.prepare("SELECT file_path, details FROM sync_log WHERE event = 'rename-detected'").all() as
      Array<{ file_path: string; details: string }>;
    expect(logged).toHaveLength(1);
    expect(logged[0].file_path).toBe('renamed-note.md');
    expect(JSON.parse(logged[0].details).from).toBe('initial.md');
  });

  it('preserves node id when a suspended unlink pairs with an add at a new path', async () => {
    const before = nodeAt(db, 'initial.md')!;
    watcher.suspendDelivery();

    renameSync(join(vaultPath, 'initial.md'), join(vaultPath, 'suspended-rename.md'));
    await delay(DEBOUNCE_MS + 100);

    let completionId: string | undefined;
    await watcher.completeSuspendedHandoff(() => {
      completionId = nodeAt(db, 'suspended-rename.md')?.id;
    });

    expect(completionId).toBe(before.id);
    expect(nodeAt(db, 'initial.md')).toBeUndefined();
    await delay(RENAME_GRACE_MS + 100);
    await mutex.onIdle();
    expect(nodeAt(db, 'suspended-rename.md')?.id).toBe(before.id);
    expect(deletedIds(db)).not.toContain(before.id);
  });

  it('keeps board links attached across a rename', async () => {
    const docId = nodeAt(db, 'initial.md')!.id;
    const { id: boardId } = saveBoard(db, { name: 'Project board', cards: [] }, Date.now());
    linkBoardToDoc(db, boardId, docId, Date.now());

    renameSync(join(vaultPath, 'initial.md'), join(vaultPath, 'project-renamed.md'));

    await delay(DEBOUNCE_MS + 300);
    await mutex.onIdle();

    const renamed = nodeAt(db, 'project-renamed.md');
    expect(renamed?.id).toBe(docId);
    expect(listBoardsForDoc(db, docId).map(b => b.id)).toContain(boardId);
  });

  it('preserves node id when a file is moved to a subdirectory', async () => {
    const before = nodeAt(db, 'initial.md')!;
    mkdirSync(join(vaultPath, 'sub'));

    renameSync(join(vaultPath, 'initial.md'), join(vaultPath, 'sub', 'initial.md'));

    await delay(DEBOUNCE_MS + 300);
    await mutex.onIdle();

    const after = nodeAt(db, join('sub', 'initial.md'));
    expect(after?.id).toBe(before.id);
    expect(after?.title).toBe('initial');
    expect(nodeAt(db, 'initial.md')).toBeUndefined();
  });

  it('preserves the node when a file is deleted and identically re-created within the grace period', async () => {
    const before = nodeAt(db, 'initial.md')!;
    const content = readFileSync(join(vaultPath, 'initial.md'), 'utf-8');

    unlinkSync(join(vaultPath, 'initial.md'));
    // Past chokidar's internal atomic-write coalescing window, so a real
    // unlink event is emitted before the re-create's add event.
    await delay(150);
    writeFileSync(join(vaultPath, 'initial.md'), content, 'utf-8');

    await delay(RENAME_GRACE_MS + 300);
    await mutex.onIdle();

    const after = nodeAt(db, 'initial.md');
    expect(after?.id).toBe(before.id);
  });

  it('still deletes the node after the grace period on a genuine delete', async () => {
    const count = nodeCount(db);

    unlinkSync(join(vaultPath, 'initial.md'));

    // Within the grace window the node must still exist (deletion is deferred
    // so a matching add can reclaim it).
    await delay(300);
    expect(nodeAt(db, 'initial.md')).toBeDefined();

    await delay(RENAME_GRACE_MS + 200);
    await mutex.onIdle();

    expect(nodeAt(db, 'initial.md')).toBeUndefined();
    expect(nodeCount(db)).toBe(count - 1);
  });

  // Characterization: content changed alongside the rename → hash match fails,
  // fall back to today's delete + create semantics.
  it('falls back to delete + create when content changes during the rename', async () => {
    const before = nodeAt(db, 'initial.md')!;

    renameSync(join(vaultPath, 'initial.md'), join(vaultPath, 'changed.md'));
    writeFileSync(join(vaultPath, 'changed.md'), '---\ntitle: Changed\n---\nDifferent content\n', 'utf-8');

    await delay(RENAME_GRACE_MS + 300);
    await mutex.onIdle();

    const after = nodeAt(db, 'changed.md');
    expect(after).toBeDefined();
    expect(after!.id).not.toBe(before.id);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(before.id)).toBeUndefined();
  });

  it('pairs ambiguous identical-content renames by basename (folder move)', async () => {
    const content = '---\ntitle: Template\n---\nTemplated body\n';
    writeFileSync(join(vaultPath, 'dup1.md'), content, 'utf-8');
    writeFileSync(join(vaultPath, 'dup2.md'), content, 'utf-8');
    await delay(DEBOUNCE_MS + 300);
    await mutex.onIdle();
    const dup1Id = nodeAt(db, 'dup1.md')!.id;
    const dup2Id = nodeAt(db, 'dup2.md')!.id;

    mkdirSync(join(vaultPath, 'sub'));
    renameSync(join(vaultPath, 'dup1.md'), join(vaultPath, 'sub', 'dup1.md'));
    renameSync(join(vaultPath, 'dup2.md'), join(vaultPath, 'sub', 'dup2.md'));

    await delay(RENAME_GRACE_MS + 300);
    await mutex.onIdle();

    expect(nodeAt(db, join('sub', 'dup1.md'))?.id).toBe(dup1Id);
    expect(nodeAt(db, join('sub', 'dup2.md'))?.id).toBe(dup2Id);
  });

  it('refuses ambiguous identical-content matches with no basename tiebreak', async () => {
    const content = '---\ntitle: Template\n---\nTemplated body\n';
    writeFileSync(join(vaultPath, 'twin1.md'), content, 'utf-8');
    writeFileSync(join(vaultPath, 'twin2.md'), content, 'utf-8');
    await delay(DEBOUNCE_MS + 300);
    await mutex.onIdle();
    const twin1Id = nodeAt(db, 'twin1.md')!.id;
    const twin2Id = nodeAt(db, 'twin2.md')!.id;

    // One twin deleted, the other renamed to an unrelated name: two pending
    // unlinks share the hash and the new basename matches neither — identity
    // must not be guessed.
    unlinkSync(join(vaultPath, 'twin1.md'));
    renameSync(join(vaultPath, 'twin2.md'), join(vaultPath, 'renamed-twin.md'));

    await delay(RENAME_GRACE_MS + 300);
    await mutex.onIdle();

    const renamed = nodeAt(db, 'renamed-twin.md');
    expect(renamed).toBeDefined();
    expect(renamed!.id).not.toBe(twin1Id);
    expect(renamed!.id).not.toBe(twin2Id);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(twin1Id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(twin2Id)).toBeUndefined();
  });

  // Guard: blank files (e.g. Obsidian's freshly created empty notes) all share
  // one hash — deleting one empty note and creating another must not transfer
  // identity between them.
  it('does not treat two different blank notes as a rename', async () => {
    writeFileSync(join(vaultPath, 'empty-a.md'), '', 'utf-8');
    await delay(DEBOUNCE_MS + 300);
    await mutex.onIdle();
    const emptyA = nodeAt(db, 'empty-a.md');
    expect(emptyA).toBeDefined();

    unlinkSync(join(vaultPath, 'empty-a.md'));
    await delay(50);
    writeFileSync(join(vaultPath, 'empty-b.md'), '', 'utf-8');

    await delay(RENAME_GRACE_MS + 300);
    await mutex.onIdle();

    const emptyB = nodeAt(db, 'empty-b.md');
    expect(emptyB).toBeDefined();
    expect(emptyB!.id).not.toBe(emptyA!.id);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(emptyA!.id)).toBeUndefined();
  });
});

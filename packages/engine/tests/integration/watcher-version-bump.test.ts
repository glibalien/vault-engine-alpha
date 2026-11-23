import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { settingsNotePath } from '@vault/settings-registry';
import type { SettingsNote } from '@vault/settings-registry';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { getMeta, setMeta } from '../../src/db/meta.js';
import { EXPLICIT_NULL_BACKFILL_META_KEY } from '../../src/sync/explicit-null-backfill.js';
import { startWatcher, type VaultWatcher } from '../../src/sync/watcher.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { writeSettingsNote } from '../../src/settings/note.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import { ContentHashMismatchError, executeMutation } from '../../src/pipeline/execute.js';
import { noteFor, notePathFor } from '../helpers/settings-notes.js';

const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 200;
const RENAME_GRACE_MS = 500;
// For a test whose second file event must arrive inside the grace. A slow Mac
// can take longer than RENAME_GRACE_MS to report it.
const LONG_RENAME_GRACE_MS = 2_000;
// How long to wait for a file event, or for a live edit to reach the database.
// macOS can report a file change well after the fixed sleeps these tests used.
const WAIT = { timeout: 5_000, interval: 20 };

// Chokidar drops a change to a file within 50 ms of its last change event
// (chokidar's own throttle), so a test edits the same file again only after this.
const CHANGE_THROTTLE_GAP_MS = 100;

type FileEvent = 'add' | 'change' | 'unlink';
const WRITTEN: readonly FileEvent[] = ['add', 'change'];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('watcher path version bump', () => {
  let vaultPath: string;
  let db: Database.Database;
  let mutex: IndexMutex;
  let writeLock: WriteLockManager;
  let watcher: VaultWatcher;

  beforeEach(async () => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-version-watch-'));
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    writeFileSync(join(vaultPath, 'watched.md'), '---\ntitle: Watched\n---\nInitial body\n', 'utf-8');

    db = new Database(join(vaultPath, '.vault-engine', 'test.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    fullIndex(vaultPath, db);

    mutex = new IndexMutex();
    writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    await startTestWatcher(RENAME_GRACE_MS);
  });

  afterEach(async () => {
    setSettingsChangeHook(null);
    await watcher.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  async function startTestWatcher(renameGraceMs: number): Promise<void> {
    watcher = startWatcher(vaultPath, db, mutex, writeLock, undefined, undefined, undefined, {
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
      renameGraceMs,
    });
    await watcher.waitUntilReady();
  }

  async function restartWatcher(renameGraceMs: number): Promise<void> {
    await watcher.close();
    await startTestWatcher(renameGraceMs);
  }

  /**
   * Resolves when the watcher reports one of `events` for `relPath`. Start it
   * before the file operation. The watcher's own listener was added first, so
   * while delivery is suspended the event is already queued when this resolves.
   */
  function watcherReports(events: FileEvent | readonly FileEvent[], relPath: string): Promise<void> {
    const target = watcher;
    const names = typeof events === 'string' ? [events] : events;
    return new Promise(resolve => {
      const listener = (filePath: string) => {
        if (relative(vaultPath, filePath) !== relPath) return;
        for (const name of names) target.off(name, listener);
        resolve();
      };
      for (const name of names) target.on(name, listener);
    });
  }

  function settingsHarness(): {
    service: SettingsService;
    /** Store `values` as `note`'s file snapshot and write the note (#746: one note of a domain). */
    writeNote(note: SettingsNote, values: Record<string, unknown>): Promise<void>;
  } {
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const deps = { db, writeLock, vaultPath, service };
    const ingest = new SettingsIngest(deps);
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));

    return {
      service,
      async writeNote(note, values) {
        service.replaceFromFile(note, values);
        const echo = watcherReports(WRITTEN, settingsNotePath('Settings', note));
        writeSettingsNote(deps, note);
        writeLock.clearRecentWrites();
        // Let chokidar observe the engine-created note before the test starts
        // a suspended unlink. Its echo hash-matches the committed DB row.
        await echo;
        await delay(DEBOUNCE_MS + 100);
        await mutex.onIdle();
      },
    };
  }

  it('bumps node version when a file is edited on disk', async () => {
    const before = db.prepare("SELECT id, version FROM nodes WHERE file_path = 'watched.md'")
      .get() as { id: string; version: number };
    expect(before.version).toBe(1);

    writeFileSync(join(vaultPath, 'watched.md'), '---\ntitle: Watched\n---\nEdited body\n', 'utf-8');

    await vi.waitFor(() => {
      const after = db.prepare('SELECT version, body FROM nodes WHERE id = ?')
        .get(before.id) as { version: number; body: string };
      expect(after.version).toBeGreaterThan(1);
      expect(after.body).toContain('Edited body');
    }, WAIT);
  });

  it('drains suspended events before marking complete and then delivers live events', async () => {
    const before = db.prepare("SELECT id, version FROM nodes WHERE file_path = 'watched.md'")
      .get() as { id: string; version: number };
    watcher.suspendDelivery();

    const queued = watcherReports(WRITTEN, 'watched.md');
    writeFileSync(join(vaultPath, 'watched.md'), '---\ntitle: Watched\n---\nQueued body\n', 'utf-8');
    await queued;
    await delay(DEBOUNCE_MS + 100);

    expect(db.prepare('SELECT version, body FROM nodes WHERE id = ?').get(before.id)).toMatchObject({
      version: before.version,
      body: 'Initial body\n',
    });

    await watcher.completeSuspendedHandoff(() => {
      const atCompletion = db.prepare('SELECT version, body FROM nodes WHERE id = ?')
        .get(before.id) as { version: number; body: string };
      expect(atCompletion.version).toBeGreaterThan(before.version);
      expect(atCompletion.body).toContain('Queued body');
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');

    writeFileSync(join(vaultPath, 'watched.md'), '---\ntitle: Watched\n---\nLive body\n', 'utf-8');

    await vi.waitFor(() => {
      expect(db.prepare('SELECT body FROM nodes WHERE id = ?').get(before.id)).toEqual({ body: 'Live body\n' });
    }, WAIT);
  });

  it('refuses completion when a queued edit does not reconcile', async () => {
    watcher.suspendDelivery();
    const queued = watcherReports(WRITTEN, 'watched.md');
    writeFileSync(join(vaultPath, 'watched.md'), '---\ntypes: [\n---\nMalformed body\n', 'utf-8');
    await queued;

    await expect(watcher.completeSuspendedHandoff(() => {
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    })).rejects.toThrow('watched.md');

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();
    await expect(watcher.abortSuspendedDelivery()).rejects.toThrow('watched.md');
  });

  it('abort preserves and processes valid events queued after a failed event', async () => {
    watcher.suspendDelivery();
    const failed = watcherReports(WRITTEN, 'watched.md');
    writeFileSync(join(vaultPath, 'watched.md'), '---\ntypes: [\n---\nMalformed body\n', 'utf-8');
    await failed;
    const valid = watcherReports(WRITTEN, 'queued-valid.md');
    writeFileSync(join(vaultPath, 'queued-valid.md'), '---\ntypes:\n---\nQueued valid body\n', 'utf-8');
    await valid;

    await expect(watcher.completeSuspendedHandoff(() => {
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    })).rejects.toThrow('watched.md');
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();

    await expect(watcher.abortSuspendedDelivery()).rejects.toThrow('watched.md');
    expect(db.prepare("SELECT body FROM nodes WHERE file_path = 'queued-valid.md'").get())
      .toEqual({ body: 'Queued valid body\n' });

    await delay(CHANGE_THROTTLE_GAP_MS);
    writeFileSync(join(vaultPath, 'watched.md'), '---\ntypes:\n---\nRecovered live body\n', 'utf-8');
    await vi.waitFor(() => {
      expect(db.prepare("SELECT body FROM nodes WHERE file_path = 'watched.md'").get())
        .toEqual({ body: 'Recovered live body\n' });
    }, WAIT);
  });

  it('queued rollout settings ingest applies DB state without writing Markdown', async () => {
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const ingest = new SettingsIngest({
      db,
      writeLock: new WriteLockManager(),
      vaultPath,
      service,
    });
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    const original = '---\nbackupKeep: 3\n---\nHuman-authored body\n';
    const note = notePathFor('engine', 'backupKeep');
    mkdirSync(join(vaultPath, dirname(note)), { recursive: true });

    watcher.suspendDelivery();
    const queued = watcherReports(WRITTEN, note);
    writeFileSync(join(vaultPath, note), original, 'utf-8');
    await queued;
    await watcher.completeSuspendedHandoff(() => {
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });

    expect(service.engine().backupKeep).toBe(3);
    expect(readFileSync(join(vaultPath, note), 'utf-8')).toBe(original);
  });

  it('regenerates a settings note only after a suspended unlink handoff is live', async () => {
    const { service, writeNote } = settingsHarness();
    const note = notePathFor('engine', 'backupKeep');
    await writeNote(noteFor('engine', 'backupKeep'), { backupKeep: 3 });
    const replayMutexStates: boolean[] = [];
    const ingest = new SettingsIngest({ db, writeLock, vaultPath, service });
    setSettingsChangeHook((relPath, kind, context) => {
      if (relPath === note && kind === 'unlink' && context.allowWriteBack) {
        replayMutexStates.push(mutex.isRunning());
      }
      ingest.onFileEvent(relPath, kind, context);
    });

    watcher.suspendDelivery();
    const unlinked = watcherReports('unlink', note);
    unlinkSync(join(vaultPath, note));
    await unlinked;

    let existedAtCompletion = true;
    await watcher.completeSuspendedHandoff(() => {
      existedAtCompletion = existsSync(join(vaultPath, note));
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });

    expect(existedAtCompletion).toBe(false);
    expect(existsSync(join(vaultPath, note))).toBe(true);
    expect(readFileSync(join(vaultPath, note), 'utf-8')).toContain('backupKeep: 3');
    expect(service.engine().backupKeep).toBe(3);
    expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(note)).toBeDefined();
    expect(replayMutexStates).toEqual([false]);
  });

  it('replays only still-missing settings notes after a suspended handoff', async () => {
    const { service, writeNote } = settingsHarness();
    const engineNote = notePathFor('engine', 'backupKeep');
    const wikiNote = notePathFor('wiki');
    await writeNote(noteFor('engine', 'backupKeep'), { backupKeep: 3 });
    await writeNote(noteFor('wiki'), { subpageCap: 9 });

    watcher.suspendDelivery();
    const unlinked = Promise.all([
      watcherReports('unlink', engineNote),
      watcherReports('unlink', wikiNote),
    ]);
    unlinkSync(join(vaultPath, engineNote));
    unlinkSync(join(vaultPath, wikiNote));
    await unlinked;

    const replacement = '---\nbackupKeep: 5\n---\nReplacement during handoff\n';
    await watcher.completeSuspendedHandoff(() => {
      writeFileSync(join(vaultPath, engineNote), replacement, 'utf-8');
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });

    expect(readFileSync(join(vaultPath, engineNote), 'utf-8')).toBe(replacement);
    expect(existsSync(join(vaultPath, wikiNote))).toBe(true);
    expect(readFileSync(join(vaultPath, wikiNote), 'utf-8')).toContain('subpageCap: 9');

    await vi.waitFor(() => expect(service.engine().backupKeep).toBe(5), WAIT);
  });

  it('does not overwrite a settings note recreated inside the replay hook', async () => {
    const { service, writeNote } = settingsHarness();
    const note = notePathFor('engine', 'backupKeep');
    await writeNote(noteFor('engine', 'backupKeep'), { backupKeep: 3 });
    const replacement = '---\nbackupKeep: 5\n---\nReplacement at replay\n';
    const ingest = new SettingsIngest({ db, writeLock, vaultPath, service });
    let injectedReplacement = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSettingsChangeHook((relPath, kind, context) => {
      if (relPath === note && kind === 'unlink' && context.allowWriteBack && !injectedReplacement) {
        injectedReplacement = true;
        writeFileSync(join(vaultPath, note), replacement, 'utf-8');
      }
      ingest.onFileEvent(relPath, kind, context);
    });

    try {
      watcher.suspendDelivery();
      const unlinked = watcherReports('unlink', note);
      unlinkSync(join(vaultPath, note));
      await unlinked;
      await watcher.completeSuspendedHandoff(() => {
        setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
      });

      expect(injectedReplacement).toBe(true);
      expect(readFileSync(join(vaultPath, note), 'utf-8')).toBe(replacement);
      expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(note)).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toEqual([
        '[settings] change hook failed:',
        expect.stringContaining('content changed since you read it'),
      ]);

      await vi.waitFor(() => {
        expect(service.engine().backupKeep).toBe(5);
        expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(note)).toBeDefined();
        expect(readFileSync(join(vaultPath, note), 'utf-8')).toContain('backupKeep: 5');
      }, WAIT);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('regenerates the canonical settings path after a suspended rename preserves identity', async () => {
    const { service, writeNote } = settingsHarness();
    const canonicalPath = notePathFor('engine', 'backupKeep');
    const renamedPath = canonicalPath.replace(/\.md$/, ' Renamed.md');
    await writeNote(noteFor('engine', 'backupKeep'), { backupKeep: 3 });
    const original = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(canonicalPath) as { id: string };

    watcher.suspendDelivery();
    // Both sides must be queued: an add drained alone would make a new node.
    const renamed = Promise.all([
      watcherReports('unlink', canonicalPath),
      watcherReports(WRITTEN, renamedPath),
    ]);
    renameSync(join(vaultPath, canonicalPath), join(vaultPath, renamedPath));
    await renamed;

    let canonicalExistedAtCompletion = true;
    await watcher.completeSuspendedHandoff(() => {
      canonicalExistedAtCompletion = existsSync(join(vaultPath, canonicalPath));
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });

    expect(canonicalExistedAtCompletion).toBe(false);
    expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(renamedPath)).toEqual({ id: original.id });
    expect(readFileSync(join(vaultPath, renamedPath), 'utf-8')).toContain('backupKeep: 3');
    expect(existsSync(join(vaultPath, canonicalPath))).toBe(true);
    expect(readFileSync(join(vaultPath, canonicalPath), 'utf-8')).toContain('backupKeep: 3');
    const regenerated = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(canonicalPath) as { id: string };
    expect(regenerated.id).not.toBe(original.id);
    expect(service.engine().backupKeep).toBe(3);
  });

  it('cancels suspended unlink replay when the same settings path is recreated in grace', async () => {
    await restartWatcher(LONG_RENAME_GRACE_MS);
    const { service, writeNote } = settingsHarness();
    const note = notePathFor('engine', 'backupKeep');
    await writeNote(noteFor('engine', 'backupKeep'), { backupKeep: 3 });
    const original = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(note) as { id: string };
    const replacement = '---\nbackupKeep: 5\n---\nSame-path replacement\n';
    const ingest = new SettingsIngest({ db, writeLock, vaultPath, service });
    let replayedUnlink = false;
    setSettingsChangeHook((relPath, kind, context) => {
      if (relPath === note && kind === 'unlink' && context.allowWriteBack) replayedUnlink = true;
      ingest.onFileEvent(relPath, kind, context);
    });

    watcher.suspendDelivery();
    const unlinked = watcherReports('unlink', note);
    unlinkSync(join(vaultPath, note));
    await unlinked;
    const handoff = watcher.completeSuspendedHandoff(() => {
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });
    await delay(50);
    writeFileSync(join(vaultPath, note), replacement, 'utf-8');
    await handoff;

    expect(replayedUnlink).toBe(false);
    expect(readFileSync(join(vaultPath, note), 'utf-8')).toBe(replacement);
    expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(note)).toEqual({ id: original.id });
    expect(service.engine().backupKeep).toBe(5);
  });

  it('regenerates a suppressed settings unlink when a failed handoff aborts', async () => {
    const { service, writeNote } = settingsHarness();
    const note = notePathFor('engine', 'backupKeep');
    await writeNote(noteFor('engine', 'backupKeep'), { backupKeep: 3 });

    watcher.suspendDelivery();
    const unlinked = watcherReports('unlink', note);
    unlinkSync(join(vaultPath, note));
    await unlinked;

    await expect(watcher.completeSuspendedHandoff(() => {
      throw new Error('injected completion failure');
    })).rejects.toThrow('injected completion failure');
    expect(existsSync(join(vaultPath, note))).toBe(false);

    await watcher.abortSuspendedDelivery();

    expect(existsSync(join(vaultPath, note))).toBe(true);
    expect(readFileSync(join(vaultPath, note), 'utf-8')).toContain('backupKeep: 3');
    expect(service.engine().backupKeep).toBe(3);
    expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(note)).toBeDefined();
  });

  it('retries abort when the index mutex is acquired after the idle check', async () => {
    watcher.suspendDelivery();

    const abort = watcher.abortSuspendedDelivery();
    let releaseBlocker!: () => void;
    const blocker = mutex.run(async () => {
      await new Promise<void>(resolve => { releaseBlocker = resolve; });
    });
    releaseBlocker();

    await Promise.all([abort, blocker]);

    await expect(watcher.completeSuspendedHandoff(() => {}))
      .rejects.toThrow('Watcher delivery is not suspended');
  });

  it('keeps completion closed until a suspended unlink is deleted and later arrivals drain', async () => {
    const before = db.prepare(
      "SELECT id FROM nodes WHERE file_path = 'watched.md'",
    ).get() as { id: string };
    // The arrival below must be reported inside the grace.
    await restartWatcher(LONG_RENAME_GRACE_MS);
    watcher.suspendDelivery();

    // Chokidar holds unlink briefly to distinguish atomic saves. Let the real
    // event enter the suspended queue before asking for the handoff.
    const unlinked = watcherReports('unlink', 'watched.md');
    unlinkSync(join(vaultPath, 'watched.md'));
    await unlinked;

    let markerPublished = false;
    let completionSnapshot: {
      deletedRow: unknown;
      arrivedRow: unknown;
    } | null = null;
    const handoff = watcher.completeSuspendedHandoff(() => {
      completionSnapshot = {
        deletedRow: db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(before.id),
        arrivedRow: db.prepare(
          "SELECT body FROM nodes WHERE file_path = 'arrived-while-waiting.md'",
        ).get(),
      };
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
      markerPublished = true;
    });

    await delay(50);
    expect(markerPublished).toBe(false);
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(before.id)).toBeDefined();

    writeFileSync(
      join(vaultPath, 'arrived-while-waiting.md'),
      '---\ntypes:\n---\nArrived during grace\n',
      'utf-8',
    );

    await handoff;

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
    expect(completionSnapshot).toEqual({
      deletedRow: undefined,
      arrivedRow: { body: 'Arrived during grace\n' },
    });
  });

  it('does not let a stale compare-and-swap recreate a node deleted by handoff', async () => {
    const before = db.prepare(`
      SELECT id, file_path, title, body, content_hash, version
      FROM nodes
      WHERE file_path = 'watched.md'
    `).get() as {
      id: string;
      file_path: string;
      title: string;
      body: string;
      content_hash: string;
      version: number;
    };
    watcher.suspendDelivery();
    const unlinked = watcherReports('unlink', before.file_path);
    unlinkSync(join(vaultPath, before.file_path));
    await unlinked;

    await watcher.completeSuspendedHandoff(() => {
      setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
    });

    expect(() => executeMutation(db, new WriteLockManager(), vaultPath, {
      source: 'tool',
      node_id: before.id,
      file_path: before.file_path,
      title: before.title,
      types: [],
      fields: {},
      body: before.body,
      expectedVersion: before.version,
      expectedContentHash: before.content_hash,
    })).toThrow(ContentHashMismatchError);
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(before.id)).toBeUndefined();
    expect(existsSync(join(vaultPath, before.file_path))).toBe(false);
  });
});

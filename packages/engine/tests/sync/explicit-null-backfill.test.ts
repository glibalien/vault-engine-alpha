import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { getMeta, setMeta } from '../../src/db/meta.js';
import { replaceExplicitNullFields } from '../../src/fields/explicit-null.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { sha256 } from '../../src/indexer/hash.js';
import {
  backfillExplicitNullFields,
  EXPLICIT_NULL_BACKFILL_META_KEY,
  type ExplicitNullBackfillDeps,
} from '../../src/sync/explicit-null-backfill.js';
import { startWatcher, type VaultWatcher } from '../../src/sync/watcher.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { migrateVisionSettingsOnBoot, seedModelsOnBoot } from '../../src/settings/seed.js';
import { setSettingsChangeHook } from '../../src/settings/hook.js';
import { notePathFor } from '../helpers/settings-notes.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface FakeWatcher {
  suspendDelivery(): void;
  enqueueScanDetectedUnlink(relPath: string): void;
  completeSuspendedHandoff(markComplete: () => void): Promise<void>;
  abortSuspendedDelivery(): Promise<void>;
}

function createFakeWatcher(options?: {
  onComplete?: () => Promise<void> | void;
  calls?: string[];
}): FakeWatcher {
  return {
    suspendDelivery() {
      options?.calls?.push('suspend');
    },
    enqueueScanDetectedUnlink(relPath) {
      options?.calls?.push(`scan-unlink:${relPath}`);
    },
    async completeSuspendedHandoff(markComplete) {
      options?.calls?.push('drain');
      await options?.onComplete?.();
      markComplete();
      options?.calls?.push('complete');
    },
    async abortSuspendedDelivery() {
      options?.calls?.push('abort');
    },
  };
}

describe('explicit-null startup backfill', () => {
  let db: Database.Database;
  let vaultPath: string;
  let liveWatcher: VaultWatcher | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-explicit-null-backfill-'));
  });

  afterEach(async () => {
    setSettingsChangeHook(null);
    await liveWatcher?.close();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function seedIndexedNode(filePath: string, content: string, indexedHash = sha256(content)): void {
    writeFileSync(join(vaultPath, filePath), content, 'utf-8');
    db.prepare(`
      INSERT INTO nodes (
        id, file_path, title, body, content_hash, file_mtime,
        content_changed_at, indexed_at, created_at, version
      ) VALUES (?, ?, ?, '', ?, 0, 0, 0, 0, 1)
    `).run(`node-${filePath}`, filePath, filePath.slice(0, -3), indexedHash);
  }

  function deps(
    watcher: FakeWatcher,
    ingestThroughWatcher: ExplicitNullBackfillDeps['ingestThroughWatcher'] = () => {
      throw new Error('unexpected watcher ingest');
    },
    readFileOverride?: ExplicitNullBackfillDeps['readFile'],
  ): ExplicitNullBackfillDeps {
    return {
      db,
      vaultPath,
      watcher,
      ingestThroughWatcher,
      ...(readFileOverride ? { readFile: readFileOverride } : {}),
    };
  }

  it('records exact null markers before committing completion', async () => {
    const calls: string[] = [];
    seedIndexedNode(
      'matched.md',
      '---\ntypes:\ncontext:\nstatus: open\nbackground:\n---\nBody\n',
    );

    const stats = await backfillExplicitNullFields(deps(createFakeWatcher({ calls })));

    expect(stats).toEqual({ scanned: 1, reingested: 0, markers: 2 });
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all('node-matched.md')).toEqual([
      { field_name: 'background' },
      { field_name: 'context' },
    ]);
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
    expect(calls).toEqual(['suspend', 'drain', 'complete']);
  });

  it('routes changed files and queued watcher events through normal ingest before completion', async () => {
    const events: string[] = [];
    const oldContent = '---\ntypes:\n---\nOld body\n';
    const changedContent = '---\ntypes:\ncontext:\n---\nChanged body\n';
    seedIndexedNode('changed-during-upgrade.md', changedContent, sha256(oldContent));
    const ingestThroughWatcher = async (filePath: string): Promise<void> => {
      events.push(filePath);
    };
    const watcher = createFakeWatcher({
      onComplete: () => ingestThroughWatcher('queued-during-scan.md'),
    });

    const stats = await backfillExplicitNullFields(deps(watcher, ingestThroughWatcher));

    expect(stats).toEqual({ scanned: 1, reingested: 1, markers: 0 });
    expect(events).toEqual(['changed-during-upgrade.md', 'queued-during-scan.md']);
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
  });

  it('does no work after the completion marker exists', async () => {
    const calls: string[] = [];
    seedIndexedNode('already-complete.md', '---\ntypes:\ncontext:\n---\nBody\n');
    setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');

    const stats = await backfillExplicitNullFields(deps(createFakeWatcher({ calls })));

    expect(stats).toEqual({ scanned: 0, reingested: 0, markers: 0 });
    expect(calls).toEqual([]);
    expect(db.prepare('SELECT * FROM node_explicit_null_fields').all()).toEqual([]);
  });

  it('populates existing settings-note markers before boot projections can canonicalize them', async () => {
    // Each null is written in the group note that shows its key (#746). The retired
    // qwenVisionModel key is shown by no note, so the Engine's first note owns its line.
    const wikisPath = notePathFor('curator', 'bodyCharCap');
    const curatorModelsPath = notePathFor('curator', 'memorySweepModel');
    const backupsPath = notePathFor('engine', 'backupKeep');
    const engineGeneralPath = notePathFor('engine');
    const engineModelsPath = notePathFor('engine', 'visionModel');
    const write = (relPath: string, content: string): void => {
      mkdirSync(join(vaultPath, dirname(relPath)), { recursive: true });
      writeFileSync(join(vaultPath, relPath), content, 'utf-8');
    };
    write(wikisPath, '---\nbodyCharCap:\n---\nHuman-authored body\n');
    write(curatorModelsPath, '---\nmemorySweepModel:\n---\nHuman-authored body\n');
    write(backupsPath, '---\nbackupKeep:\n---\nOld engine settings body\n');
    write(engineGeneralPath, '---\nqwenVisionModel: "[[Qwen 3.7 Plus]]"\n---\nOld engine settings body\n');
    fullIndex(vaultPath, db);
    const nodeId = (relPath: string): string =>
      (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string }).id;
    const wikisNode = nodeId(wikisPath);
    const curatorModelsNode = nodeId(curatorModelsPath);
    const backupsNode = nodeId(backupsPath);
    const markersOf = (id: string): unknown => db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(id);

    // Existing databases gain the additive marker table empty. Their unchanged
    // notes hash-skip the ordinary startup index, so only the one-time scan can
    // recover authored null presence.
    db.prepare('DELETE FROM node_explicit_null_fields').run();
    expect(fullIndex(vaultPath, db).indexed).toBe(0);
    expect(markersOf(wikisNode)).toEqual([]);
    expect(markersOf(curatorModelsNode)).toEqual([]);

    const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    const service = new SettingsService(db, { settingsDir: 'Settings' });
    const noteDeps = { db, writeLock, vaultPath, service };
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings', env: {} });
    const ingest = new SettingsIngest(noteDeps, catalog);
    setSettingsChangeHook((path, kind, context) => ingest.onFileEvent(path, kind, context));

    const mutex = new IndexMutex();
    liveWatcher = startWatcher(
      vaultPath,
      db,
      mutex,
      writeLock,
      undefined,
      undefined,
      undefined,
      { debounceMs: 20, maxWaitMs: 50, renameGraceMs: 150 },
    );
    await liveWatcher.waitUntilReady();

    await backfillExplicitNullFields({
      db,
      vaultPath,
      watcher: liveWatcher,
      ingestThroughWatcher: () => { throw new Error('unexpected watcher ingest'); },
    });
    const markersBeforeProjection = [markersOf(wikisNode), markersOf(curatorModelsNode)];
    seedModelsOnBoot(db, service, noteDeps, catalog);
    migrateVisionSettingsOnBoot(db, service, noteDeps);
    service.setModelRefResolver((ref) => catalog.resolve(ref));
    ingest.reconcile();
    await delay(100);
    await mutex.onIdle();

    const renderedWikis = readFileSync(join(vaultPath, wikisPath), 'utf-8');
    const renderedCuratorModels = readFileSync(join(vaultPath, curatorModelsPath), 'utf-8');
    const renderedBackups = readFileSync(join(vaultPath, backupsPath), 'utf-8');
    const renderedEngineGeneral = readFileSync(join(vaultPath, engineGeneralPath), 'utf-8');
    const renderedEngineModels = readFileSync(join(vaultPath, engineModelsPath), 'utf-8');
    expect(markersBeforeProjection).toEqual([
      [{ field_name: 'bodyCharCap' }],
      [{ field_name: 'memorySweepModel' }],
    ]);
    expect(markersOf(backupsNode)).toEqual([{ field_name: 'backupKeep' }]);
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
    expect(markersOf(wikisNode)).toEqual([{ field_name: 'bodyCharCap' }]);
    expect(markersOf(curatorModelsNode)).toEqual([{ field_name: 'memorySweepModel' }]);
    expect(renderedWikis).toMatch(/\nbodyCharCap:\n/);
    expect(renderedCuratorModels).toMatch(/\nmemorySweepModel:\n/);
    expect(renderedBackups).toMatch(/\nbackupKeep:\n/);
    expect(renderedEngineModels).toContain('visionModel: "[[Qwen 3.7 Plus]]"');
    expect(renderedEngineGeneral).not.toContain('qwenVisionModel');
    expect(renderedEngineModels).not.toContain('qwenVisionModel');
    expect(service.issues('curator')).toEqual([]);
    expect(service.issues('engine')).toEqual([
      expect.objectContaining({ key: 'backupKeep', code: 'SETTINGS_INVALID_VALUE' }),
    ]);
  });

  it('keeps exact marker presence when completed-marker startup indexes an offline edit', async () => {
    const filePath = 'offline-edit.md';
    writeFileSync(
      join(vaultPath, filePath),
      '---\ntypes:\ncontext:\nstatus: active\n---\nBefore\n',
      'utf-8',
    );
    fullIndex(vaultPath, db);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string };
    replaceExplicitNullFields(db, node.id, ['context']);
    setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');

    writeFileSync(
      join(vaultPath, filePath),
      '---\ntypes:\ncontext: project scope\nstatus:\n---\nAfter\n',
      'utf-8',
    );
    db.prepare('UPDATE nodes SET file_mtime = -1 WHERE id = ?').run(node.id);

    expect(fullIndex(vaultPath, db).indexed).toBe(1);
    expect(await backfillExplicitNullFields(deps(createFakeWatcher())))
      .toEqual({ scanned: 0, reingested: 0, markers: 0 });
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(node.id)).toEqual([{ field_name: 'status' }]);
    expect(db.prepare(
      'SELECT field_name, value_text, value_json FROM node_fields WHERE node_id = ? ORDER BY field_name',
    ).all(node.id)).toEqual([
      { field_name: 'context', value_text: 'project scope', value_json: null },
    ]);
  });

  it('waits for suspended watcher readiness before scanning', async () => {
    seedIndexedNode('ready.md', '---\ntypes:\ncontext:\n---\nBody\n');
    let releaseReady!: () => void;
    const ready = new Promise<void>(resolve => { releaseReady = resolve; });
    const calls: string[] = [];
    const watcher = {
      suspendDelivery() { calls.push('suspend'); },
      enqueueScanDetectedUnlink() { throw new Error('unexpected scan unlink'); },
      async waitUntilReady() {
        calls.push('ready');
        await ready;
      },
      async completeSuspendedHandoff(markComplete: () => void) {
        calls.push('drain');
        markComplete();
      },
      async abortSuspendedDelivery() { calls.push('abort'); },
    };

    const backfill = backfillExplicitNullFields(deps(watcher));
    await new Promise(resolve => setImmediate(resolve));
    const beforeRelease = {
      calls: [...calls],
      marker: getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY),
    };
    releaseReady();
    await backfill;

    expect(beforeRelease).toEqual({ calls: ['suspend', 'ready'], marker: null });
    expect(calls).toEqual(['suspend', 'ready', 'drain']);
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
  });

  it('leaves completion absent and aborts suspended delivery after ingest failure', async () => {
    const calls: string[] = [];
    seedIndexedNode(
      'changed.md',
      '---\ntypes:\ncontext:\n---\nChanged\n',
      sha256('---\ntypes:\n---\nOld\n'),
    );

    await expect(backfillExplicitNullFields(deps(
      createFakeWatcher({ calls }),
      async () => { throw new Error('injected ingest failure'); },
    ))).rejects.toThrow('injected ingest failure');

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();
    expect(calls).toEqual(['suspend', 'abort']);
  });

  it('skips a note whose frontmatter does not parse and completes', async () => {
    const calls: string[] = [];
    const malformed = '---\ntypes: [\ncontext:\n---\nBroken\n';
    seedIndexedNode('malformed.md', malformed);
    seedIndexedNode('matched.md', '---\ntypes:\ncontext:\n---\nBody\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const stats = await backfillExplicitNullFields(deps(createFakeWatcher({ calls })));

      expect(stats).toEqual({ scanned: 2, reingested: 0, markers: 1 });
      expect(db.prepare(
        'SELECT node_id, field_name FROM node_explicit_null_fields ORDER BY node_id',
      ).all()).toEqual([{ node_id: 'node-matched.md', field_name: 'context' }]);
      expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
      expect(calls).toEqual(['suspend', 'drain', 'complete']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed.md'));
    } finally {
      warn.mockRestore();
    }
  });

  it('starts on a fresh index of a vault with a broken note', async () => {
    writeFileSync(join(vaultPath, 'broken.md'), '---\nkind: [\n  - a\n---\nBroken\n', 'utf-8');
    writeFileSync(join(vaultPath, 'fine.md'), '---\nstatus:\n---\nFine\n', 'utf-8');
    fullIndex(vaultPath, db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const stats = await backfillExplicitNullFields(deps(createFakeWatcher()));

      expect(stats.scanned).toBe(2);
      expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
    } finally {
      warn.mockRestore();
    }
  });

  it('routes a scan-time ENOENT through the suspended watcher and completes after deletion', async () => {
    const filePath = 'removed-during-scan.md';
    seedIndexedNode(filePath, '---\ntypes:\ncontext:\n---\nRemoved\n');
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath) as { id: string };
    liveWatcher = startWatcher(
      vaultPath,
      db,
      new IndexMutex(),
      new WriteLockManager(),
      undefined,
      undefined,
      undefined,
      { debounceMs: 20, maxWaitMs: 50, renameGraceMs: 150 },
    );
    await liveWatcher.waitUntilReady();
    unlinkSync(join(vaultPath, filePath));

    const stats = await backfillExplicitNullFields(deps(liveWatcher));

    expect(stats).toEqual({ scanned: 1, reingested: 1, markers: 0 });
    expect(db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(node.id)).toBeUndefined();
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
  });

  it('lets a scan-time ENOENT pair with the add side of a rename', async () => {
    const oldPath = 'renamed-during-scan.md';
    const newPath = 'renamed-during-scan-new.md';
    seedIndexedNode(oldPath, '---\ntypes:\ncontext:\n---\nStable rename body\n');
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(oldPath) as { id: string };
    // The add side must be reported inside the grace, which a slow Mac took
    // over 300 ms to do. The pairing ends the wait, so a long grace costs nothing.
    liveWatcher = startWatcher(
      vaultPath,
      db,
      new IndexMutex(),
      new WriteLockManager(),
      undefined,
      undefined,
      undefined,
      { debounceMs: 20, maxWaitMs: 50, renameGraceMs: 2_000 },
    );
    await liveWatcher.waitUntilReady();
    renameSync(join(vaultPath, oldPath), join(vaultPath, newPath));

    await backfillExplicitNullFields(deps(liveWatcher));

    expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(newPath)).toEqual({ id: node.id });
    expect(db.prepare('SELECT 1 FROM nodes WHERE file_path = ?').get(oldPath)).toBeUndefined();
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
  });

  it('fails closed on scan-time EACCES and leaves completion absent', async () => {
    const calls: string[] = [];
    const filePath = 'unreadable.md';
    seedIndexedNode(filePath, '---\ntypes:\ncontext:\n---\nUnreadable\n');
    chmodSync(join(vaultPath, filePath), 0o000);

    await expect(backfillExplicitNullFields(deps(createFakeWatcher({ calls }))))
      .rejects.toMatchObject({ code: 'EACCES' });

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();
    expect(calls).toEqual(['suspend', 'abort']);
    chmodSync(join(vaultPath, filePath), 0o600);
  });

  it('fails closed on scan-time EIO and leaves completion absent', async () => {
    const calls: string[] = [];
    const filePath = 'io-error.md';
    seedIndexedNode(filePath, '---\ntypes:\ncontext:\n---\nI/O error\n');

    const readFileOverride = async (target: string): Promise<string> => {
      if (target.endsWith(filePath)) {
        throw Object.assign(new Error('EIO: input/output error'), { code: 'EIO' });
      }
      return readFile(target, 'utf-8');
    };

    await expect(
      backfillExplicitNullFields(deps(createFakeWatcher({ calls }), undefined, readFileOverride)),
    ).rejects.toMatchObject({ code: 'EIO' });

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();
    expect(calls).toEqual(['suspend', 'abort']);
  });

  it('retries successfully after a scan-time EIO clears', async () => {
    const filePath = 'io-error-retry.md';
    seedIndexedNode(filePath, '---\ntypes:\ncontext:\nbackground:\n---\nRetry\n');

    let failing = true;
    const readFileOverride = async (target: string): Promise<string> => {
      if (failing && target.endsWith(filePath)) {
        throw Object.assign(new Error('EIO: input/output error'), { code: 'EIO' });
      }
      return readFile(target, 'utf-8');
    };

    // First attempt fails closed and never records completion.
    await expect(
      backfillExplicitNullFields(deps(createFakeWatcher(), undefined, readFileOverride)),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();

    // The failure clears; the restart-safe backfill re-runs and completes.
    failing = false;
    const calls: string[] = [];
    const stats = await backfillExplicitNullFields(
      deps(createFakeWatcher({ calls }), undefined, readFileOverride),
    );

    expect(stats).toEqual({ scanned: 1, reingested: 0, markers: 2 });
    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBe('complete');
    expect(calls).toEqual(['suspend', 'drain', 'complete']);
  });

  it('fails closed on an unsafe snapshotted path and leaves completion absent', async () => {
    const calls: string[] = [];
    db.prepare(`
      INSERT INTO nodes (
        id, file_path, title, body, content_hash, file_mtime,
        content_changed_at, indexed_at, created_at, version
      ) VALUES ('unsafe-node', '../outside.md', 'unsafe', '', 'hash', 0, 0, 0, 0, 1)
    `).run();

    await expect(backfillExplicitNullFields(deps(createFakeWatcher({ calls }))))
      .rejects.toThrow('Path traversal blocked');

    expect(getMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY)).toBeNull();
    expect(calls).toEqual(['suspend', 'abort']);
  });
});

describe('meta helpers', () => {
  it('reads, inserts, and replaces a meta value', () => {
    const db = new Database(':memory:');
    createSchema(db);
    try {
      expect(getMeta(db, 'test.key')).toBeNull();
      setMeta(db, 'test.key', 'first');
      expect(getMeta(db, 'test.key')).toBe('first');
      setMeta(db, 'test.key', 'second');
      expect(getMeta(db, 'test.key')).toBe('second');
    } finally {
      db.close();
    }
  });
});

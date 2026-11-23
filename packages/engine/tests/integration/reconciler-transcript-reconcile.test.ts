import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { startReconciler } from '../../src/sync/reconciler.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  createSchema(db);
  upgradeForAttachmentTranscripts(db);
  return db;
}

// Minimal valid markdown so the reconciler's changed-file pass treats present
// files as empty-typed nodes without throwing; the transcript pass is what we assert.
const FILE_BODY = '---\ntypes:\n---\n';

function seedDeleted(store: TranscriptStore, embedRef: string, vaultPath: string): void {
  store.capture({
    embedRef, vaultPath, contentHash: `h-${embedRef}`,
    extractedText: 't', mediaType: 'audio', extractorId: 'whisper',
  });
  store.markDeleted(vaultPath);
}

describe('reconciler transcript source_deleted reconciliation', () => {
  let vaultPath: string;
  let db: Database.Database;
  let store: TranscriptStore;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-transcript-reconcile-'));
    db = openDb();
    store = new TranscriptStore(db);
    mkdirSync(join(vaultPath, 'Attachments'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('clears flags for present files; leaves absent and live ones', async () => {
    // (a) deleted + present -> clear
    seedDeleted(store, 'Attachments/present.m4a', 'Attachments/present.m4a');
    writeFileSync(join(vaultPath, 'Attachments/present.m4a'), FILE_BODY, 'utf-8');
    // (b) deleted + absent (archived analogue) -> stays deleted
    seedDeleted(store, 'Attachments/archived.m4a', 'Attachments/archived.m4a');
    // (c) deleted + present under different folder case -> clear (case-insensitive)
    seedDeleted(store, 'Attachments/Cased.m4a', 'Attachments/Cased.m4a');
    writeFileSync(join(vaultPath, 'Attachments/cased.m4a'), FILE_BODY, 'utf-8');
    // (d) live + present -> untouched
    store.capture({
      embedRef: 'Attachments/live.m4a', vaultPath: 'Attachments/live.m4a',
      contentHash: 'h-live', extractedText: 't', mediaType: 'audio', extractorId: 'whisper',
    });
    writeFileSync(join(vaultPath, 'Attachments/live.m4a'), FILE_BODY, 'utf-8');

    const mutex = new IndexMutex();
    const writeLock = new WriteLockManager();
    const reconciler = startReconciler(
      vaultPath, db, mutex, writeLock, undefined, undefined,
      { initialDelayMs: 10, intervalMs: 60_000 },
      store,
    );
    await new Promise((r) => setTimeout(r, 200));
    reconciler.stop();

    expect(store.getByRef('Attachments/present.m4a')?.source_deleted).toBe(0);
    expect(store.getByRef('Attachments/present.m4a')?.deleted_at).toBeNull();
    expect(store.getByRef('Attachments/archived.m4a')?.source_deleted).toBe(1);
    expect(store.getByRef('Attachments/Cased.m4a')?.source_deleted).toBe(0);
    expect(store.getByRef('Attachments/live.m4a')?.source_deleted).toBe(0);

    const rows = db.prepare(
      "SELECT details FROM edits_log WHERE event_type = 'reconciler-sweep'",
    ).all() as Array<{ details: string }>;
    expect(rows.some((r) => JSON.parse(r.details).transcripts_undeleted >= 2)).toBe(true);
  });

  it('leaves a transcript flagged when its binary lives only under .vault-engine/archive', async () => {
    // archive-source records the ORIGINAL embed path as vault_path and moves the
    // binary into the .vault-engine/archive dotfolder. The dotfolder is excluded
    // from the walk, so the original path is "absent" -> the row must stay flagged.
    seedDeleted(store, 'Attachments/archived-only.m4a', 'Attachments/archived-only.m4a');
    mkdirSync(join(vaultPath, '.vault-engine', 'archive', 'Attachments'), { recursive: true });
    writeFileSync(
      join(vaultPath, '.vault-engine', 'archive', 'Attachments', 'archived-only.m4a'),
      'bytes',
      'utf-8',
    );

    const mutex = new IndexMutex();
    const writeLock = new WriteLockManager();
    const reconciler = startReconciler(
      vaultPath, db, mutex, writeLock, undefined, undefined,
      { initialDelayMs: 10, intervalMs: 60_000 },
      store,
    );
    await new Promise((r) => setTimeout(r, 200));
    reconciler.stop();

    expect(store.getByRef('Attachments/archived-only.m4a')?.source_deleted).toBe(1);
  });
});

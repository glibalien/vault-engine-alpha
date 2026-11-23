// tests/sync/watcher-transcript-deletion.test.ts
//
// Tests the contract that the watcher's unlink else-branch relies on:
// TranscriptStore.markDeleted(vaultPath) flips source_deleted to 1 and returns
// the number of rows changed. A path with no transcript row returns 0.
//
// This is a direct-logic test of the markDeleted contract rather than a
// chokidar-driven integration test. Chokidar timing is non-deterministic at
// unit-test timescales; the existing watcher.test.ts already exercises the
// full unlink path for markdown nodes. Testing the else-branch directly
// documents the behavior the watcher depends on without introducing flakiness.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  upgradeForAttachmentTranscripts(db);
  return db;
}

describe('TranscriptStore.markDeleted — watcher else-branch contract', () => {
  let db: Database.Database;
  let store: TranscriptStore;

  beforeEach(() => {
    db = makeDb();
    store = new TranscriptStore(db);
  });

  it('marks a captured transcript as deleted and returns 1', () => {
    store.capture({
      embedRef: 'Attachments/rec.veaudio',
      vaultPath: 'Attachments/rec.veaudio',
      contentHash: 'abc123',
      extractedText: 'hello world transcript',
      mediaType: 'audio/x-veaudio',
      extractorId: 'veaudio-v1',
    });

    const changes = store.markDeleted('Attachments/rec.veaudio');
    expect(changes).toBe(1);

    const row = store.getByRef('Attachments/rec.veaudio');
    expect(row).not.toBeNull();
    expect(row!.source_deleted).toBe(1);
    expect(row!.deleted_at).not.toBeNull();
  });

  it('returns 0 for a path with no transcript row', () => {
    const changes = store.markDeleted('Attachments/nonexistent.mp3');
    expect(changes).toBe(0);
  });

  it('is idempotent: calling markDeleted again returns 0 (already deleted)', () => {
    store.capture({
      embedRef: 'Attachments/rec.veaudio',
      vaultPath: 'Attachments/rec.veaudio',
      contentHash: 'abc123',
      extractedText: 'hello world',
      mediaType: 'audio/x-veaudio',
      extractorId: 'veaudio-v1',
    });

    const first = store.markDeleted('Attachments/rec.veaudio');
    expect(first).toBe(1);

    const second = store.markDeleted('Attachments/rec.veaudio');
    expect(second).toBe(0);
  });

  it('marks all rows for a vault_path when multiple embed refs share the same path', () => {
    store.capture({
      embedRef: 'Attachments/rec.veaudio',
      vaultPath: 'Attachments/rec.veaudio',
      contentHash: 'abc123',
      extractedText: 'transcript A',
      mediaType: 'audio/x-veaudio',
      extractorId: 'veaudio-v1',
    });
    store.capture({
      embedRef: 'Attachments/rec|alias',
      vaultPath: 'Attachments/rec.veaudio',
      contentHash: 'abc123',
      extractedText: 'transcript A (alias)',
      mediaType: 'audio/x-veaudio',
      extractorId: 'veaudio-v1',
    });

    const changes = store.markDeleted('Attachments/rec.veaudio');
    expect(changes).toBe(2);

    const deleted = store.list({ sourceDeleted: true });
    expect(deleted).toHaveLength(2);
  });
});

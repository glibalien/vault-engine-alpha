import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { SEED_MODELS, normalizeModelRef } from '@vault/settings-registry';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { noteFor, notePathFor, notePathsOf } from '../helpers/settings-notes.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SettingsService } from '../../src/settings/service.js';
import { SettingsIngest } from '../../src/settings/ingest.js';
import { ModelCatalog } from '../../src/settings/models.js';
import { writeModelNoteIfAbsent } from '../../src/settings/note.js';
import { setSettingsChangeHook, notifySettingsChange } from '../../src/settings/hook.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { parseFrontmatter } from '../../src/parser/frontmatter.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';

let db: Database.Database; let vaultPath: string; let cleanup: () => void;
let service: SettingsService; let ingest: SettingsIngest;
/** Settings/Engine/Backups and retention.md, the note that shows backupKeep (#746). */
const NOTE = notePathFor('engine', 'backupKeep');
/** Settings/Engine/Models.md, the note that shows the Engine's model refs. */
const MODELS_NOTE = notePathFor('engine', 'memoryConsolidationModel');
/** Settings/Curator/Wikis.md, the note that shows bodyCharCap and staleProjectStatus. */
const CURATOR_WIKIS = notePathFor('curator', 'bodyCharCap');

function writeNote(content: string, relPath = NOTE): void {
  const p = join(vaultPath, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new SettingsService(db, { settingsDir: 'Settings' });
  ingest = new SettingsIngest({ db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service });
});
afterEach(() => { cleanup(); setSettingsChangeHook(null); });

describe('SettingsIngest', () => {
  it('maps settings paths to domains and ignores others', () => {
    expect(ingest.handles('Settings/Engine/Backups and retention.md')).toBe('engine');
    expect(ingest.handles('Settings/Curator/Models.md')).toBe('curator');
    expect(ingest.noteAt('Settings/Curator/Models.md')).toBe(noteFor('curator', 'model'));
    expect(ingest.handles('Settings/Wiki.md')).toBe('wiki');
    for (const domain of ['engine', 'wiki', 'chat', 'curator', 'vault'] as const) {
      for (const path of notePathsOf(domain)) expect(ingest.handles(path)).toBe(domain);
    }
    // The domains shown in a folder of notes no longer have a single note (#746).
    expect(ingest.handles('Settings/Engine.md')).toBeNull();
    expect(ingest.handles('Settings/Curator.md')).toBeNull();
    expect(ingest.noteAt('Settings/Engine.md')).toBeNull();
    expect(ingest.handles('Settings/Engine/Other.md')).toBeNull();
    expect(ingest.handles('Settings/Other.md')).toBeNull();
    expect(ingest.handles('Notes/Engine.md')).toBeNull();
  });

  it("applies a valid file edit and canonicalizes (materializes the note's keys)", () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    expect(service.engine().backupKeep).toBe(3);
    const raw = readFileSync(join(vaultPath, NOTE), 'utf8');
    expect(raw).toContain('backupIntervalHours: 24');   // materialized default
    expect(raw).toContain('## Keys');                   // doc body added
    const fields = parseFrontmatter(raw).fields;
    expect([...fields.keys()].sort()).toEqual([...noteFor('engine', 'backupKeep').keys].sort());
    expect(fields.has('excludeDirs')).toBe(false);      // shown in Settings/Engine/General.md
  });

  it('rejects an invalid value: last-good live, raw text preserved, issues callout written', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    writeNote('---\nbackupKeep: bogus\nbackupIntervalHours: 12\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    expect(service.engine().backupKeep).toBe(3);                    // last-good
    expect(service.engine().backupIntervalHours).toBe(12);          // valid key applied
    const raw = readFileSync(join(vaultPath, NOTE), 'utf8');
    expect(raw).toContain('> [!warning] Settings issues');
    expect(raw).toContain('backupKeep: bogus');                     // user raw text preserved
  });

  it('unparseable frontmatter: everything last-good, file frontmatter untouched', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    writeNote('---\nbackupKeep: [unclosed\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    expect(service.engine().backupKeep).toBe(3);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toContain('backupKeep: [unclosed');
  });

  it('deleting a key line resets it to default and write-back restores the line', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    writeNote('---\nbackupIntervalHours: 12\n---\n');   // backupKeep line gone
    ingest.onFileEvent(NOTE, 'change');
    expect(service.engine().backupKeep).toBe(7);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toContain('backupKeep: 7');
  });

  it('unlink regenerates the note from current effective values (not a reset)', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    writeNote('---\nbackupKeep:\n---\n');
    processFileChange(
      join(vaultPath, NOTE), NOTE, db,
      new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath,
    );
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);
    unlinkSync(join(vaultPath, NOTE));
    ingest.onFileEvent(NOTE, 'unlink');
    expect(existsSync(join(vaultPath, NOTE))).toBe(true);
    expect(service.engine().backupKeep).toBe(3);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toContain('backupKeep: 3');
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('preserves and reports a schema-invalid explicit null during canonical write-back', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    writeNote('---\nbackupKeep:\n---\n');

    processFileChange(
      join(vaultPath, NOTE), NOTE, db,
      new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath,
    );

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toMatch(/\nbackupKeep:\n/);
    expect(service.issues('engine')).toEqual([
      expect.objectContaining({ key: 'backupKeep', code: 'SETTINGS_INVALID_VALUE' }),
    ]);
  });

  it.each(['before event', 'at write lock'])('preserves a settings note recreated %s after unlink', timing => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    const before = db.prepare('SELECT * FROM nodes WHERE file_path = ?').get(NOTE);
    unlinkSync(join(vaultPath, NOTE));
    const replacement = '---\nbackupKeep: 5\n---\nNew human note\n';
    class RecreateOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        writeFileSync(path, replacement, 'utf8');
        return super.withLockSync(path, fn);
      }
    }
    if (timing === 'before event') writeNote(replacement);
    else ingest = new SettingsIngest({ db, vaultPath, service, writeLock: new RecreateOnLock() });

    expect(() => ingest.onFileEvent(NOTE, 'unlink')).toThrow(/content changed since/i);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(replacement);
    expect(db.prepare('SELECT * FROM nodes WHERE file_path = ?').get(NOTE)).toEqual(before);
    expect(service.engine().backupKeep).toBe(3);
  });

  it('preserves a settings note recreated at the startup write lock and reconciles other domains', () => {
    const replacement = '---\nbackupKeep: 5\n---\nNew startup note\n';
    class RecreateOnLock extends WriteLockManager {
      override withLockSync<T>(path: string, fn: () => T): T {
        if (path === join(vaultPath, NOTE)) writeNote(replacement);
        return super.withLockSync(path, fn);
      }
    }
    ingest = new SettingsIngest({ db, vaultPath, service, writeLock: new RecreateOnLock() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => ingest.reconcile()).not.toThrow();
      expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(replacement);
      expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE)).toBeUndefined();
      expect(existsSync(join(vaultPath, 'Settings/Wiki.md'))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferring write-back'));
    } finally {
      warn.mockRestore();
    }
  });

  it('clears a nullable marker when the key is removed from the file snapshot', () => {
    const relPath = CURATOR_WIKIS;
    const absPath = join(vaultPath, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, '---\nbodyCharCap:\n---\n', 'utf8');
    processFileChange(
      absPath, relPath, db,
      new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath,
    );
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };

    writeFileSync(absPath, '---\nmeetingReads: 25\n---\n', 'utf8');
    ingest.onFileEvent(relPath, 'change');

    expect(parseFrontmatter(readFileSync(absPath, 'utf8')).fields.has('bodyCharCap')).toBe(false);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('clears a marker when the file snapshot supplies a non-null replacement', () => {
    writeNote('---\nbackupKeep:\n---\n');
    processFileChange(
      join(vaultPath, NOTE), NOTE, db,
      new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath,
    );
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };

    writeNote('---\nbackupKeep: 4\n---\n');
    ingest.onFileEvent(NOTE, 'change');

    expect(parseFrontmatter(readFileSync(join(vaultPath, NOTE), 'utf8')).fields.get('backupKeep')).toBe(4);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('does not replay stale file-snapshot ownership after a write-back CAS conflict', () => {
    writeNote('---\nbackupKeep: 4\n---\n');

    expect(() => ingest.onFileEvent(NOTE, 'change', {
      allowWriteBack: true,
      expectedDiskContentHash: 'stale-watcher-snapshot',
    })).toThrow(/content changed since/i);

    // A newer human save is authoritative because the failed projection came
    // from a file snapshot, not a committed programmatic settings patch.
    writeNote('---\nbackupKeep: 5\n---\n');
    ingest.onFileEvent(NOTE, 'change');

    expect(service.engine().backupKeep).toBe(5);
    expect(parseFrontmatter(readFileSync(join(vaultPath, NOTE), 'utf8')).fields.get('backupKeep')).toBe(5);
  });

  it('uses the exact read snapshot as the default write-back CAS', () => {
    const newer = '---\nbackupKeep: 5\n---\nNewer human save\n';
    let injected = false;
    class ExternalEditOnLock extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        if (!injected) {
          injected = true;
          writeFileSync(filePath, newer, 'utf8');
        }
        return super.withLockSync(filePath, fn);
      }
    }
    ingest = new SettingsIngest({
      db,
      writeLock: new ExternalEditOnLock({ recentWriteTtlMs: 1 }),
      vaultPath,
      service,
    });
    writeNote('---\nbackupKeep: 4\n---\nOlder watcher snapshot\n');

    expect(() => ingest.onFileEvent(NOTE, 'change')).toThrow(/content changed since/i);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(newer);
    expect(service.engine().backupKeep).toBe(4); // stale snapshot is live only until B is ingested

    ingest.onFileEvent(NOTE, 'change');
    expect(service.engine().backupKeep).toBe(5);
  });

  it('reconcile creates missing notes and ingests existing ones', () => {
    writeNote('---\nbackupKeep: 4\n---\n');
    ingest.reconcile();
    expect(service.engine().backupKeep).toBe(4);
    expect(existsSync(join(vaultPath, 'Settings/Wiki.md'))).toBe(true);
  });

  it('reconcile materializes notes for all four domains', () => {
    ingest.reconcile();
    for (const domain of ['engine', 'wiki', 'chat', 'curator'] as const) {
      for (const path of notePathsOf(domain)) expect(existsSync(join(vaultPath, path))).toBe(true);
    }
    // The Engine and the Curator are shown in a folder of notes, never a single one (#746).
    expect(existsSync(join(vaultPath, 'Settings/Engine.md'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Settings/Curator.md'))).toBe(false);
  });

  it('reconcile clears stale markers when recreating a missing settings note', () => {
    ingest.reconcile();
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };
    writeNote('---\nbackupKeep:\n---\n');
    processFileChange(
      join(vaultPath, NOTE), NOTE, db,
      new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath,
    );
    unlinkSync(join(vaultPath, NOTE));

    ingest.reconcile();

    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toContain('backupKeep: 7');
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([]);
  });

  it('reconcile preserves invalid raw text and its issues callout', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    writeNote('---\nbackupKeep: bogus\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    ingest.reconcile();
    const raw = readFileSync(join(vaultPath, NOTE), 'utf8');
    expect(raw).toContain('backupKeep: bogus');
    expect(raw).toContain('[!warning] Settings issues');
  });

  it('reconcile leaves an unparseable note untouched', () => {
    writeNote('---\nbackupKeep: [unclosed\n---\n');
    ingest.reconcile();
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toContain('backupKeep: [unclosed');
  });

  it('unknown keys are preserved in frontmatter and warned', () => {
    writeNote('---\nbackupKeep: 3\nmysteryKey: 42\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    const raw = readFileSync(join(vaultPath, NOTE), 'utf8');
    expect(raw).toContain('mysteryKey: 42');
    expect(raw).toContain('**mysteryKey**');
  });

  it.each(['__proto__', 'constructor'])('preserves unknown %s field values through canonical write-back and reconcile', (field) => {
    writeNote(`---\nbackupKeep: 3\n${field}: authored value\n---\n`);
    ingest.onFileEvent(NOTE, 'change');

    function expectPreserved() {
      const raw = readFileSync(join(vaultPath, NOTE), 'utf8');
      const parsed = parseFrontmatter(raw);
      expect(parsed.fields.has(field)).toBe(true);
      expect(parsed.fields.get(field)).toBe('authored value');
      expect(raw).toContain(`**${field}**`);
      expect(raw).toContain('[!warning] Settings issues');
      expect(db.prepare(`
        SELECT nf.value_text FROM node_fields nf
        JOIN nodes n ON n.id = nf.node_id
        WHERE n.file_path = ? AND nf.field_name = ?
      `).get(NOTE, field)).toEqual({ value_text: 'authored value' });
      expect(service.engine().backupKeep).toBe(3);
    }

    expectPreserved();
    ingest.reconcile();
    expectPreserved();
  });

  it('converges: ingest → write-back → re-ingest of own output is a no-op', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    const afterFirst = readFileSync(join(vaultPath, NOTE), 'utf8');
    const v = service.version('engine');
    ingest.onFileEvent(NOTE, 'change');   // simulate watcher echo that slipped past hash-skip
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(afterFirst);
    expect(service.version('engine')).toBe(v);
  });

  it('processFileChange notifies the settings hook after ingesting', () => {
    const calls: string[] = [];
    setSettingsChangeHook((relPath, kind) => calls.push(`${relPath}:${kind}`));
    writeNote('---\nbackupKeep: 5\n---\n');
    const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);
    expect(calls).toEqual([`${NOTE}:change`]);
  });

  it('keeps a newer explicit null that lands between a successful watcher commit and its settings hook', () => {
    const newer = '---\nbackupKeep:\n---\nNewer human save\n';
    const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let injectNewerSave = true;
    setSettingsChangeHook((relPath, kind, context) => {
      if (injectNewerSave) {
        injectNewerSave = false;
        writeNote(newer);
      }
      ingest.onFileEvent(relPath, kind, context);
    });

    try {
      writeNote('---\nbackupKeep: 4\n---\nWatcher snapshot A\n');
      processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);

      expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(newer);
      expect(service.issues('engine')).toEqual([
        expect.objectContaining({ key: 'backupKeep', code: 'SETTINGS_INVALID_VALUE' }),
      ]);

      // The queued event for B updates marker state before canonical write-back.
      processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);
      const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };
      expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toMatch(/\nbackupKeep:\n/);
      expect(db.prepare(
        'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
      ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps a newer explicit null that lands between a parse-error watcher read and its settings hook', () => {
    const newer = '---\nbackupKeep:\n---\nNewer human save\n';
    const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    writeNote('---\nbackupKeep: 4\n---\nIndexed baseline\n');
    processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let injectNewerSave = true;
    setSettingsChangeHook((relPath, kind, context) => {
      if (injectNewerSave) {
        injectNewerSave = false;
        writeNote(newer);
      }
      ingest.onFileEvent(relPath, kind, context);
    });

    try {
      writeNote('---\nbackupKeep: [unclosed\n---\nBroken watcher snapshot A\n');
      processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);

      expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(newer);
      expect(service.issues('engine')).toEqual([
        expect.objectContaining({ key: 'backupKeep', code: 'SETTINGS_INVALID_VALUE' }),
      ]);

      processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);
      const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };
      expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toMatch(/\nbackupKeep:\n/);
      expect(db.prepare(
        'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
      ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);
    } finally {
      error.mockRestore();
    }
  });

  it('records a committed new settings parse error after embedding enqueue fails', () => {
    const absPath = join(vaultPath, NOTE);
    const original = '---\nbackupKeep: [unclosed\n---\nBroken watcher snapshot\n';
    writeNote(original);

    let hookCalls = 0;
    setSettingsChangeHook((path, kind, context) => {
      hookCalls++;
      ingest.onFileEvent(path, kind, context);
    });
    let enqueueCalls = 0;
    const embeddingIndexer = {
      enqueue() {
        enqueueCalls++;
        throw new Error('injected parse-error enqueue failure');
      },
    } as unknown as EmbeddingIndexer;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let enqueueFailureLogged = false;
    try {
      expect(() => processFileChange(
        absPath,
        NOTE,
        db,
        new WriteLockManager({ recentWriteTtlMs: 1 }),
        vaultPath,
        undefined,
        embeddingIndexer,
        { allowSettingsWriteBack: false },
      )).not.toThrow();
      enqueueFailureLogged = error.mock.calls.some(args =>
        args.some(arg => String(arg).includes('injected parse-error enqueue failure')),
      );
    } finally {
      error.mockRestore();
    }

    expect(db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE)).toBeDefined();
    expect(enqueueCalls).toBe(1);
    expect(enqueueFailureLogged).toBe(true);
    expect(hookCalls).toBe(1);
    expect(service.issues('engine')).toEqual([
      expect.objectContaining({ key: 'frontmatter', code: 'SETTINGS_INVALID_VALUE' }),
    ]);
    expect(readFileSync(absPath, 'utf8')).toBe(original);
  });

  it('does not project a newer explicit null after the watcher pipeline fails', () => {
    const relPath = CURATOR_WIKIS;
    const absPath = join(vaultPath, relPath);
    const newer = '---\nbodyCharCap:\n---\nNewer human save\n';
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, '---\nbodyCharCap: 1200\n---\nWatcher snapshot A\n', 'utf8');
    service.applyPatch('curator', { bodyCharCap: 1200 });

    class FailPipelineOnLock extends WriteLockManager {
      override withLockSync<T>(filePath: string, _fn: () => T): T {
        writeFileSync(filePath, newer, 'utf8');
        throw new Error('injected watcher pipeline failure');
      }
    }
    let hookCalls = 0;
    setSettingsChangeHook((path, kind, context) => {
      hookCalls++;
      ingest.onFileEvent(path, kind, context);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      processFileChange(
        absPath,
        relPath,
        db,
        new FailPipelineOnLock({ recentWriteTtlMs: 1 }),
        vaultPath,
      );
    } finally {
      error.mockRestore();
    }

    expect(hookCalls).toBe(0);
    expect(service.effective('curator')['bodyCharCap']).toBe(1200);
    expect(readFileSync(absPath, 'utf8')).toBe(newer);
  });

  it('projects a committed settings change after embedding enqueue fails', () => {
    const relPath = CURATOR_WIKIS;
    const absPath = join(vaultPath, relPath);
    const original = '---\nbodyCharCap: 1600\n---\nWatcher snapshot\n';
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, original, 'utf8');

    let hookCalls = 0;
    setSettingsChangeHook((path, kind, context) => {
      hookCalls++;
      ingest.onFileEvent(path, kind, context);
    });
    let enqueueCalls = 0;
    const embeddingIndexer = {
      enqueue() {
        enqueueCalls++;
        throw new Error('injected embedding enqueue failure');
      },
    } as unknown as EmbeddingIndexer;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let enqueueFailureLogged = false;
    try {
      expect(() => processFileChange(
        absPath,
        relPath,
        db,
        new WriteLockManager({ recentWriteTtlMs: 1 }),
        vaultPath,
        undefined,
        embeddingIndexer,
        { allowSettingsWriteBack: false },
      )).not.toThrow();
      enqueueFailureLogged = error.mock.calls.some(args =>
        args.some(arg => String(arg).includes('injected embedding enqueue failure')),
      );
    } finally {
      error.mockRestore();
    }

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };
    expect(enqueueCalls).toBe(1);
    expect(db.prepare(
      'SELECT value_number FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(node.id, 'bodyCharCap')).toEqual({ value_number: 1600 });
    expect(enqueueFailureLogged).toBe(true);
    expect(hookCalls).toBe(1);
    expect(service.effective('curator')['bodyCharCap']).toBe(1600);
    expect(readFileSync(absPath, 'utf8')).toBe(original);
  });

  it('rollout processFileChange applies settings without canonical write-back', () => {
    setSettingsChangeHook((relPath, kind, context) => ingest.onFileEvent(relPath, kind, context));
    const original = '---\nbackupKeep: 5\n---\nHuman-authored body\n';
    writeNote(original);

    processFileChange(
      join(vaultPath, NOTE),
      NOTE,
      db,
      new WriteLockManager({ recentWriteTtlMs: 1 }),
      vaultPath,
      undefined,
      undefined,
      { allowSettingsWriteBack: false },
    );

    expect(service.engine().backupKeep).toBe(5);
    expect(readFileSync(join(vaultPath, NOTE), 'utf8')).toBe(original);
  });

  it('records a parse issue on unparseable frontmatter and clears it on a later valid edit', () => {
    writeNote('---\nbackupKeep: 3\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    expect(service.issues('engine')).toHaveLength(0);

    writeNote('---\nbackupKeep: [unclosed\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    const issues = service.issues('engine');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'frontmatter', code: 'SETTINGS_INVALID_VALUE' });

    writeNote('---\nbackupKeep: 5\n---\n');
    ingest.onFileEvent(NOTE, 'change');
    expect(service.issues('engine')).toHaveLength(0);   // cleared by a successful parse
    expect(service.engine().backupKeep).toBe(5);
  });

  it('processFileChange fires the settings hook even when the settings note has broken YAML', () => {
    const calls: string[] = [];
    const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    // Establish the node with a valid write first (creates the DB row so the
    // parse-error path takes its "existing node" branch on the next call).
    writeNote('---\nbackupKeep: 3\n---\n');
    processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);

    setSettingsChangeHook((relPath, kind) => calls.push(`${relPath}:${kind}`));
    writeNote('---\nbackupKeep: [unclosed\n---\n');
    processFileChange(join(vaultPath, NOTE), NOTE, db, writeLock, vaultPath);
    expect(calls).toEqual([`${NOTE}:change`]);
  });

  it('routes an unindexed pre-reconcile nullable null through normal ingest before projection', () => {
    const relPath = CURATOR_WIKIS;
    const absPath = join(vaultPath, relPath);
    const writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, '---\nbodyCharCap: 1200\n---\nIndexed snapshot A\n', 'utf8');
    processFileChange(absPath, relPath, db, writeLock, vaultPath);
    writeFileSync(absPath, '---\nbodyCharCap:\n---\nUnindexed snapshot B\n', 'utf8');
    setSettingsChangeHook((path, kind, context) => ingest.onFileEvent(path, kind, context));

    ingest.reconcile({
      ingestChangedFile: path => processFileChange(
        join(vaultPath, path), path, db, writeLock, vaultPath,
      ),
    });

    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string };
    expect(service.effective('curator')['bodyCharCap']).toBeNull();
    expect(readFileSync(absPath, 'utf8')).toMatch(/\nbodyCharCap:\n/);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'bodyCharCap' }]);
  });

  it('keeps an empty staleProjectStatus (the nudge turned off) through the note and back (#447)', () => {
    const relPath = CURATOR_WIKIS;
    mkdirSync(dirname(join(vaultPath, relPath)), { recursive: true });
    writeFileSync(join(vaultPath, relPath), '---\nstaleProjectStatus: ""\n---\n', 'utf8');

    ingest.onFileEvent(relPath, 'change');
    expect(service.effective('curator')['staleProjectStatus']).toBe('');
    const written = readFileSync(join(vaultPath, relPath), 'utf8');
    expect(written).toMatch(/\nstaleProjectStatus: ""\n/);

    ingest.onFileEvent(relPath, 'change');
    expect(service.effective('curator')['staleProjectStatus']).toBe('');
    expect(readFileSync(join(vaultPath, relPath), 'utf8')).toBe(written);
  });

  it('keeps a concurrent save and continues reconcile after its write-back CAS rejects', () => {
    const older = '---\nbackupKeep: 4\n---\nStable snapshot A\n';
    const newer = '---\nbackupKeep:\n---\nConcurrent snapshot B\n';
    const absPath = join(vaultPath, NOTE);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, older, 'utf8');
    processFileChange(
      absPath, NOTE, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath,
    );

    let injected = false;
    class ExternalEditOnLock extends WriteLockManager {
      override withLockSync<T>(filePath: string, fn: () => T): T {
        if (!injected && filePath === absPath) {
          injected = true;
          writeFileSync(filePath, newer, 'utf8');
        }
        return super.withLockSync(filePath, fn);
      }
    }
    const reconcileLock = new ExternalEditOnLock({ recentWriteTtlMs: 1 });
    ingest = new SettingsIngest({ db, writeLock: reconcileLock, vaultPath, service });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => ingest.reconcile()).not.toThrow();
      expect(readFileSync(absPath, 'utf8')).toBe(newer);
    } finally {
      warn.mockRestore();
    }

    setSettingsChangeHook((path, kind, context) => ingest.onFileEvent(path, kind, context));
    processFileChange(absPath, NOTE, db, reconcileLock, vaultPath);
    const node = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(NOTE) as { id: string };
    expect(readFileSync(absPath, 'utf8')).toMatch(/\nbackupKeep:\n/);
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ?',
    ).all(node.id)).toEqual([{ field_name: 'backupKeep' }]);
  });

  it('preserves wikilinks inside text prompt settings instead of stripping them', () => {
    const chatNote = 'Settings/Chat.md';
    const p = join(vaultPath, chatNote);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '---\nchatSystemPrompt: |\n  Use [[Project Home]] exactly.\n---\n', 'utf-8');
    ingest.onFileEvent(chatNote, 'change');
    expect(service.effective('chat')['chatSystemPrompt']).toBe('Use [[Project Home]] exactly.\n');
  });
});

describe('SettingsIngest onCatalogChange callback (Fix 2: Models/ edits re-arm vision)', () => {
  it('fires on a Models/ note event (change AND unlink), never on a domain-note event', () => {
    const deps = { db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service };
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
    let catalogChanges = 0;
    const ing = new SettingsIngest(deps, catalog, () => { catalogChanges++; });

    // Models/ events route to the catalog branch → invalidate + bump + callback.
    ing.onFileEvent('Settings/Models/Some Model.md', 'change');
    expect(catalogChanges).toBe(1);
    ing.onFileEvent('Settings/Models/Some Model.md', 'unlink');
    expect(catalogChanges).toBe(2);

    // A domain-note edit flows through the settings onChange listeners instead —
    // it must NOT fire the catalog callback.
    writeNote('---\nbackupKeep: 3\n---\n');
    ing.onFileEvent(NOTE, 'change');
    expect(catalogChanges).toBe(2);
  });
});

describe('settings change hook singleton', () => {
  it('notify is a safe no-op when unset, and dispatches when set', () => {
    notifySettingsChange(NOTE, 'change');   // must not throw
    const calls: string[] = [];
    setSettingsChangeHook((relPath, kind) => calls.push(`${relPath}:${kind}`));
    notifySettingsChange(NOTE, 'change');
    expect(calls).toEqual([`${NOTE}:change`]);
  });
});

describe('model-ref settings through the file ingest path', () => {
  // End-to-end over the SAME wiring index.ts builds after seedModelsOnBoot:
  // real catalog notes in the DB, resolver = catalog.resolve(ref) !== null.
  const QWEN = SEED_MODELS[0]!;   // 'Qwen 3.7 Plus' — the registry default's target
  const KIMI = SEED_MODELS[2]!;   // 'Kimi K2.6' — a second, NON-default catalog entry

  function modelRefIngest(): SettingsIngest {
    const deps = { db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service };
    writeModelNoteIfAbsent(deps, QWEN);
    writeModelNoteIfAbsent(deps, KIMI);
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
    service.setModelRefResolver((ref) => catalog.resolve(ref));
    return new SettingsIngest(deps, catalog);
  }

  it('a resolvable non-default ref round-trips: deviation stored, write-back output converges', () => {
    const ing = modelRefIngest();
    writeNote('---\nmemoryConsolidationModel: "[[Kimi K2.6]]"\n---\n', MODELS_NOTE);   // quoted-bracketed form
    ing.onFileEvent(MODELS_NOTE, 'change');
    expect(normalizeModelRef(service.stored('engine')['memoryConsolidationModel'])).toBe('Kimi K2.6');   // deviation stored
    expect(normalizeModelRef(service.engine().memoryConsolidationModel)).toBe('Kimi K2.6');              // effective follows
    expect(service.issues('engine')).toEqual([]);
    // The write-back materializes the ref bracketed (Task 9), but the frontmatter
    // parser strips [[...]] from every field it reads back off disk, so
    // re-ingesting the engine's own output exercises the bare form on the way
    // in. It must converge: byte-identical file, no version bump.
    const afterFirst = readFileSync(join(vaultPath, MODELS_NOTE), 'utf8');
    const v = service.version('engine');
    ing.onFileEvent(MODELS_NOTE, 'change');
    expect(readFileSync(join(vaultPath, MODELS_NOTE), 'utf8')).toBe(afterFirst);
    expect(service.version('engine')).toBe(v);
  });

  it('write-back renders the ref bracketed, and reconciling the note is a no-op (no stored change, no version bump)', () => {
    const ing = modelRefIngest();
    writeNote('---\nmemoryConsolidationModel: "[[Kimi K2.6]]"\n---\n', MODELS_NOTE);
    ing.onFileEvent(MODELS_NOTE, 'change');
    const raw = readFileSync(join(vaultPath, MODELS_NOTE), 'utf8');
    expect(raw).toContain('memoryConsolidationModel: "[[Kimi K2.6]]"');   // Task 9: render-time bracket wrap

    const storedBefore = service.stored('engine');
    const versionBefore = service.version('engine');
    ing.reconcile();
    expect(service.stored('engine')).toEqual(storedBefore);
    expect(service.version('engine')).toBe(versionBefore);
    expect(readFileSync(join(vaultPath, MODELS_NOTE), 'utf8')).toBe(raw);
  });

  it('an unresolvable typo ref keeps the prior NON-DEFAULT value and preserves the raw typo', () => {
    const ing = modelRefIngest();
    writeNote('---\nmemoryConsolidationModel: "[[Kimi K2.6]]"\n---\n', MODELS_NOTE);
    ing.onFileEvent(MODELS_NOTE, 'change');
    // User typos the ref in the (now materialized) note.
    const materialized = readFileSync(join(vaultPath, MODELS_NOTE), 'utf8');
    writeNote(materialized.replace(/^memoryConsolidationModel: .*$/m, 'memoryConsolidationModel: "[[Kimee K2.6]]"'), MODELS_NOTE);
    ing.onFileEvent(MODELS_NOTE, 'change');
    const issues = service.issues('engine');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'memoryConsolidationModel', code: 'SETTINGS_MODEL_REF_UNRESOLVED' });
    // Regression (Task 4 review, Issue 1): last-good must be the prior stored
    // deviation ('Kimi K2.6'), NOT a silent revert to the registry default.
    expect(normalizeModelRef(service.engine().memoryConsolidationModel)).toBe('Kimi K2.6');
    const raw = readFileSync(join(vaultPath, MODELS_NOTE), 'utf8');
    expect(raw).toContain('Kimee K2.6');                       // raw typo preserved for in-place fixing
    expect(raw).toContain('> [!warning] Settings issues');
    // Fix 1b: the callout names the last-good value actually in effect (the
    // suffix now covers SETTINGS_MODEL_REF_UNRESOLVED, not just SETTINGS_INVALID_VALUE).
    expect(raw).toContain('(value in effect: `"Kimi K2.6"`)');
  });
});

describe('upgrade: Phase-2 raw model ids migrate to refs on reconcile', () => {
  // The upgrade wart (Fix 1): a pre-Phase-3 Settings/Engine.md materializes its
  // model-ref keys as RAW provider ids. Before the ingest-side translation, the
  // contextual resolver rejected those raw ids, preserveRaw pinned them, and a
  // warning callout rendered on every reconcile — a stable "failed migration"
  // read on every upgraded install. This exercises the SAME wiring index.ts uses
  // after seedModelsOnBoot: real catalog notes + resolver = catalog.resolve.
  // Since #746 such an install's single Settings/Engine.md is read once at reconcile
  // (with the same translation) and removed, and the keys are shown in
  // Settings/Engine/Models.md; a raw id typed there is translated by the live ingest.
  const QWEN = SEED_MODELS[0]!;      // 'Qwen 3.7 Plus' — the registry default's target
  const DEEPSEEK = SEED_MODELS[1]!;  // 'DeepSeek v4 Pro' — a NON-default catalog entry
  const FLAT_NOTE = 'Settings/Engine.md';

  it.each([FLAT_NOTE, MODELS_NOTE])('rewrites raw ids in %s to refs, ZERO issues, stored deviations correct, second reconcile byte-identical', (relPath) => {
    const deps = { db, writeLock: new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath, service };
    writeModelNoteIfAbsent(deps, QWEN);
    writeModelNoteIfAbsent(deps, DEEPSEEK);
    const catalog = new ModelCatalog(db, { settingsDir: 'Settings' });
    service.setModelRefResolver((ref) => catalog.resolve(ref));
    const ing = new SettingsIngest(deps, catalog);

    // Phase-2-shaped note: both model keys are RAW provider ids. visionModel's
    // raw id is the registry default's target (converges to default → not a
    // deviation); memoryConsolidationModel's is a genuine deviation.
    writeNote(
      '---\n' +
      'visionModel: accounts/fireworks/models/qwen3p7-plus\n' +
      'memoryConsolidationModel: accounts/fireworks/models/deepseek-v4-pro\n' +
      '---\n',
      relPath,
    );
    // An upgraded install's old note is indexed, which is what lets the retirement remove it.
    if (relPath === FLAT_NOTE) {
      processFileChange(join(vaultPath, relPath), relPath, db, new WriteLockManager({ recentWriteTtlMs: 1 }), vaultPath);
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      ing.reconcile();
    } finally {
      log.mockRestore();
    }

    // Migration succeeded: no rejection, no callout, raw ids gone from the note.
    expect(service.issues('engine')).toEqual([]);
    expect(existsSync(join(vaultPath, FLAT_NOTE))).toBe(false);   // retired, or never there
    const afterFirst = readFileSync(join(vaultPath, MODELS_NOTE), 'utf8');
    expect(afterFirst).not.toContain('[!warning] Settings issues');
    expect(afterFirst).not.toContain('accounts/fireworks/models/');
    expect(afterFirst).toContain('DeepSeek v4 Pro');   // deviation now a ref

    // Deviation resolves to DeepSeek; default-valued key converges to the default.
    expect(normalizeModelRef(service.engine().memoryConsolidationModel)).toBe('DeepSeek v4 Pro');
    expect(normalizeModelRef(service.stored('engine')['memoryConsolidationModel'])).toBe('DeepSeek v4 Pro');
    expect('visionModel' in service.stored('engine')).toBe(false);   // == default → not stored
    expect(normalizeModelRef(service.engine().visionModel)).toBe('Qwen 3.7 Plus');

    // Stable migrated state: a second reconcile touches no bytes.
    ing.reconcile();
    expect(readFileSync(join(vaultPath, MODELS_NOTE), 'utf8')).toBe(afterFirst);
  });
});

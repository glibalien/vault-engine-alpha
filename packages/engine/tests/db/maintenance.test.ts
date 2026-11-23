import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/db/connection.js';
import { createSchema } from '../../src/db/schema.js';
import { upgradeToMemories } from '../../src/db/migrate.js';
import { runBackup, startMaintenance, readLastBackup, resolveBackupDir, listBackups } from '../../src/db/maintenance.js';
import type Database from 'better-sqlite3';

// Maintenance needs a real file DB (WAL checkpoint, VACUUM INTO, mtime checks)
// — the shared :memory: helper won't do.
function createFileDb(): { db: Database.Database; dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vault-maint-'));
  const dbPath = join(dir, 'vault.db');
  const db = openDatabase(dbPath);
  createSchema(db);
  // src/index.ts runs this unconditionally right after schema setup, before
  // startMaintenance is ever constructed — the retention sweep now assumes
  // memory_embedding_vec/memories exist (Durable Memories v1), so this
  // fixture must mirror that production ordering.
  upgradeToMemories(db);
  return { db, dbPath, dir };
}

function seed(db: Database.Database): void {
  db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('n1', 'a.md', 'A'), ('n2', 'b.md', 'B'), ('n3', 'c.md', 'C')").run();
  const res = db.prepare(
    "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n1', 'node', 'h1', 0, NULL, '2026-01-01')"
  ).run();
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
    .run(BigInt(res.lastInsertRowid), new Uint8Array(1024)); // 256 × float32
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function track(db: Database.Database, dir: string): void {
  cleanups.push(() => { try { db.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
}

describe('runBackup', () => {
  it('creates a dated, openable, row-complete backup (virtual table survives)', () => {
    const { db, dir } = createFileDb();
    track(db, dir);
    seed(db);
    const backupDir = join(dir, 'backups');

    const result = runBackup(db, { backupDir, backupKeep: 7 });

    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/vault-\d{4}-\d{2}-\d{2}\.db$/);
    expect(existsSync(result.path!)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    // The copy opens through the normal path (sqlite-vec loaded) and matches.
    const copy = openDatabase(result.path!);
    try {
      expect((copy.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c).toBe(3);
      expect((copy.prepare('SELECT COUNT(*) AS c FROM embedding_meta').get() as { c: number }).c).toBe(1);
      expect((copy.prepare('SELECT COUNT(*) AS c FROM embedding_vec').get() as { c: number }).c).toBe(1);
    } finally {
      copy.close();
    }
  });

  it('overwrites the same-day file instead of failing', () => {
    const { db, dir } = createFileDb();
    track(db, dir);
    const backupDir = join(dir, 'backups');
    const first = runBackup(db, { backupDir, backupKeep: 7 });
    const second = runBackup(db, { backupDir, backupKeep: 7 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.path).toBe(first.path);
    expect(readdirSync(backupDir).filter(f => f.endsWith('.db'))).toHaveLength(1);
  });

  it('rotates: keeps only backupKeep newest files', () => {
    const { db, dir } = createFileDb();
    track(db, dir);
    const backupDir = join(dir, 'backups');
    runBackup(db, { backupDir, backupKeep: 2 }); // creates dir + today's file
    writeFileSync(join(backupDir, 'vault-2020-01-01.db'), 'junk');
    writeFileSync(join(backupDir, 'vault-2020-01-02.db'), 'junk');

    const result = runBackup(db, { backupDir, backupKeep: 2 });

    expect(result.ok).toBe(true);
    expect(result.deletedBackups).toEqual(['vault-2020-01-01.db']);
    const files = readdirSync(backupDir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('vault-2020-01-02.db');
  });

  it('records the outcome in meta maintenance_last_backup', () => {
    const { db, dir } = createFileDb();
    track(db, dir);
    const result = runBackup(db, { backupDir: join(dir, 'backups'), backupKeep: 7 });
    const last = readLastBackup(db);
    expect(last).not.toBeNull();
    expect(last!.ok).toBe(true);
    expect(last!.path).toBe(result.path);
    expect(last!.bytes).toBe(result.bytes);
    expect(Date.parse(last!.at)).not.toBeNaN();
  });

  it('logs and returns ok:false on failure instead of throwing', () => {
    const { db, dir } = createFileDb();
    track(db, dir);
    // A FILE where the backup dir should be → mkdirSync ENOTDIR inside runBackup.
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');

    const result = runBackup(db, { backupDir: join(blocker, 'backups'), backupKeep: 7 });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    const last = readLastBackup(db);
    expect(last!.ok).toBe(false);
  });
});

describe('resolveBackupDir', () => {
  it('defaults to <db dir>/backups and honors VAULT_BACKUP_DIR', () => {
    expect(resolveBackupDir('/data/.vault-engine/vault.db')).toBe('/data/.vault-engine/backups');
    process.env.VAULT_BACKUP_DIR = '/elsewhere/bk';
    try {
      expect(resolveBackupDir('/data/.vault-engine/vault.db')).toBe('/elsewhere/bk');
    } finally {
      delete process.env.VAULT_BACKUP_DIR;
    }
  });
});

describe('startMaintenance', () => {
  it('boots a backup when none exists', () => {
    const { db, dbPath, dir } = createFileDb();
    track(db, dir);
    const handle = startMaintenance(db, dbPath, { backupDir: join(dir, 'backups'), backupIntervalHours: 1 });
    handle.stop();
    expect(readLastBackup(db)?.ok).toBe(true);
  });

  it('boots a backup when the newest backup is stale (mtime)', () => {
    const { db, dbPath, dir } = createFileDb();
    track(db, dir);
    const backupDir = join(dir, 'backups');
    runBackup(db, { backupDir, backupKeep: 7 });
    const file = join(backupDir, listBackups(backupDir).at(-1)!);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago > 1h interval
    utimesSync(file, old, old);
    const before = statSync(file).mtimeMs;

    const handle = startMaintenance(db, dbPath, { backupDir, backupIntervalHours: 1 });
    handle.stop();

    expect(statSync(file).mtimeMs).toBeGreaterThan(before); // same-day file rewritten
  });

  it('skips the boot backup when the newest backup is fresh', () => {
    const { db, dbPath, dir } = createFileDb();
    track(db, dir);
    const backupDir = join(dir, 'backups');
    runBackup(db, { backupDir, backupKeep: 7 });
    db.prepare("DELETE FROM meta WHERE key = 'maintenance_last_backup'").run();

    const handle = startMaintenance(db, dbPath, { backupDir, backupIntervalHours: 1 });
    handle.stop();

    expect(readLastBackup(db)).toBeNull(); // no new backup ran
  });

  it('skips backups entirely when enabled:false but still runs without throwing', () => {
    const { db, dbPath, dir } = createFileDb();
    track(db, dir);
    const handle = startMaintenance(db, dbPath, { backupDir: join(dir, 'backups'), enabled: false });
    handle.stop();
    expect(readLastBackup(db)).toBeNull();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('does not throw out of startMaintenance when the backup dir is unwritable', () => {
    const { db, dbPath, dir } = createFileDb();
    track(db, dir);
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    expect(() => {
      const handle = startMaintenance(db, dbPath, { backupDir: join(blocker, 'backups') });
      handle.stop();
    }).not.toThrow();
    expect(readLastBackup(db)?.ok).toBe(false);
  });
});

describe('startMaintenance — retention integration', () => {
  it('runs retention sweeps on boot', () => {
    const { db, dbPath, dir } = createFileDb();
    track(db, dir);
    db.prepare("INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES ('n1', ?, 'value-coerced', '{}')")
      .run(Date.now() - 91 * 86_400_000);

    const handle = startMaintenance(db, dbPath, {
      backupDir: join(dir, 'backups'),
      editsLogRetentionDays: 90,
    });
    handle.stop();

    expect((db.prepare('SELECT COUNT(*) AS c FROM edits_log').get() as { c: number }).c).toBe(0);
  });

  it('ticks run backup + optimize + sweep on the interval and survive sweep errors', () => {
    vi.useFakeTimers();
    try {
      const { db, dbPath, dir } = createFileDb();
      track(db, dir);
      const backupDir = join(dir, 'backups');
      const handle = startMaintenance(db, dbPath, { backupDir, backupIntervalHours: 1 });
      // Erase the boot meta row so the post-tick assertion is unambiguous.
      db.prepare("DELETE FROM meta WHERE key = 'maintenance_last_backup'").run();

      // Seed an over-retention row AFTER boot, then break the next sweep's
      // edits_log DELETE by dropping the table — the tick must survive.
      db.prepare("INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES ('n1', ?, 'value-coerced', '{}')")
        .run(Date.now() - 91 * 86_400_000);
      db.prepare('DROP TABLE edits_log').run();

      expect(() => vi.advanceTimersByTime(3_600_000 + 1)).not.toThrow(); // tick fires, sweep error contained
      expect(readLastBackup(db)?.ok).toBe(true); // backup still ran on the tick

      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

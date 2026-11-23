import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { initializeReferencePolicyVersion, preflightReferencePolicyVersion, readReferencePolicyVersion } from '../../src/db/reference-policy-version.js';

describe('reference policy version marker', () => {
  it('defaults existing empty databases to v1 and new databases to v2', () => {
    const oldDb = createTestDb();
    initializeReferencePolicyVersion(oldDb, false);
    expect(readReferencePolicyVersion(oldDb)).toBe(1);
    const newDb = createTestDb();
    initializeReferencePolicyVersion(newDb, true);
    expect(readReferencePolicyVersion(newDb)).toBe(2);
    initializeReferencePolicyVersion(newDb, false);
    expect(readReferencePolicyVersion(newDb)).toBe(2);
    oldDb.close(); newDb.close();
  });

  it('rejects malformed marker without modifying it', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('reference_resolution_policy_version', '3');
    expect(() => initializeReferencePolicyVersion(db, true)).toThrow();
    expect(db.prepare('SELECT value FROM meta WHERE key = ?').get('reference_resolution_policy_version')).toEqual({ value: '3' });
    db.close();
  });

  it('rolls back failed marker initialization', () => {
    const db = createTestDb();
    db.exec("CREATE TRIGGER deny_reference_marker BEFORE INSERT ON meta WHEN NEW.key = 'reference_resolution_policy_version' BEGIN SELECT RAISE(ABORT, 'denied'); END");
    expect(() => initializeReferencePolicyVersion(db, true)).toThrow();
    expect(readReferencePolicyVersion(db)).toBe(1);
    db.close();
  });

  it('rejects an invalid marker before opening the mutating startup connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reference-policy-preflight-'));
    const path = join(dir, 'vault.db');
    try {
      const seed = new Database(path);
      seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE witness (value TEXT)");
      seed.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('reference_resolution_policy_version', '3');
      seed.prepare('INSERT INTO witness (value) VALUES (?)').run('unchanged');
      expect(seed.pragma('journal_mode', { simple: true })).toBe('delete');
      seed.close();
      const before = readFileSync(path);

      expect(() => preflightReferencePolicyVersion(path)).toThrow('Unsupported reference resolution policy version: 3');

      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
      const verify = new Database(path, { readonly: true, fileMustExist: true });
      expect(verify.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(verify.prepare('SELECT value FROM witness').get()).toEqual({ value: 'unchanged' });
      verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('does not initialize v2 when a purported new database already contains nodes', () => {
  const db = createTestDb();
  db.exec("INSERT INTO nodes(id,file_path) VALUES ('existing','existing.md')");
  initializeReferencePolicyVersion(db, true);
  expect(readReferencePolicyVersion(db)).toBe(1);
  db.close();
});

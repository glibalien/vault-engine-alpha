import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCuratorDb } from '../src/db/connection.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'curator-db-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openCuratorDb', () => {
  it('creates the parent directory if missing', () => {
    const dbPath = join(tmp(), 'nested', 'curator.db');
    const db = openCuratorDb(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('enables WAL journal mode and foreign keys', () => {
    const db = openCuratorDb(join(tmp(), 'curator.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

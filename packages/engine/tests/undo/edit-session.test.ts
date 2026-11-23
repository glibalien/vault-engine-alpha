import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables } from '../../src/db/migrate.js';
import { EditSessionRegistry } from '../../src/undo/edit-session.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); createSchema(db); addUndoTables(db); });
afterEach(() => db.close());

const desc = () => 'edit session: Note';

describe('EditSessionRegistry', () => {
  it('reuses one operation_id for the same session within the TTL', () => {
    const reg = new EditSessionRegistry(300_000);
    const a = reg.resolve(db, 'sess-1', desc, 1_000);
    const b = reg.resolve(db, 'sess-1', desc, 2_000);
    expect(b).toBe(a);
    expect(db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get()).toEqual({ c: 1 });
  });

  it('mints a fresh operation_id for a different session', () => {
    const reg = new EditSessionRegistry(300_000);
    const a = reg.resolve(db, 'sess-1', desc, 1_000);
    const b = reg.resolve(db, 'sess-2', desc, 1_000);
    expect(b).not.toBe(a);
    expect(db.prepare('SELECT COUNT(*) AS c FROM undo_operations').get()).toEqual({ c: 2 });
  });

  it('mints a fresh operation_id when the session has been idle past the TTL', () => {
    const reg = new EditSessionRegistry(300_000);
    const a = reg.resolve(db, 'sess-1', desc, 1_000);
    const b = reg.resolve(db, 'sess-1', desc, 1_000 + 300_001);
    expect(b).not.toBe(a);
  });

  it('sweepExpired drops idle sessions to bound memory', () => {
    const reg = new EditSessionRegistry(300_000);
    reg.resolve(db, 'sess-1', desc, 1_000);
    reg.sweepExpired(1_000 + 300_001);
    expect(reg.size()).toBe(0);
  });

  it('re-mints when the cached operation was swept from undo_operations', () => {
    const reg = new EditSessionRegistry(300_000);
    const a = reg.resolve(db, 'sess-1', desc, 1_000);
    db.prepare('DELETE FROM undo_operations WHERE operation_id = ?').run(a); // simulate orphan sweep
    const b = reg.resolve(db, 'sess-1', desc, 2_000);                        // still within TTL
    expect(b).not.toBe(a);
    expect(db.prepare('SELECT 1 FROM undo_operations WHERE operation_id = ?').get(b)).toBeDefined();
  });
});

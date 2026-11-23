import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let vaultPath: string; let cleanup: () => void;
let db: Database.Database; let writeLock: WriteLockManager;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = new Database(':memory:'); createSchema(db); addUndoTables(db); addUiHints(db);
  writeLock = new WriteLockManager();
});
afterEach(() => { db.close(); cleanup(); });

// #261: a note saved on Windows (CRLF) by a tool that writes a byte-order mark.
const WINDOWS_NOTE = '﻿---\r\nstatus: open\r\npeople: ["[[Ann]]", "[[Bo]]"]\r\n---\r\nNotes from the call.\r\n';

describe('a CRLF note with a byte-order mark (#261)', () => {
  it('indexes its fields and body, and a rewrite keeps one frontmatter block', () => {
    mkdirSync(join(vaultPath, 'Meetings'), { recursive: true });
    const abs = join(vaultPath, 'Meetings', 'Sync.md');
    writeFileSync(abs, WINDOWS_NOTE);
    const id = indexFile(abs, vaultPath, db);

    const fields = Object.fromEntries((db.prepare('SELECT field_name, value_text, value_json FROM node_fields WHERE node_id = ?').all(id) as
      Array<{ field_name: string; value_text: string | null; value_json: string | null }>)
      .map((f) => [f.field_name, f.value_json !== null ? JSON.parse(f.value_json) : f.value_text]));
    expect(fields).toEqual({ status: 'open', people: ['Ann', 'Bo'] });
    const { body } = db.prepare('SELECT body FROM nodes WHERE id = ?').get(id) as { body: string };
    expect(body.trim()).toBe('Notes from the call.');

    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: id, file_path: 'Meetings/Sync.md', title: 'Sync', types: [],
      fields: { status: 'done', people: ['[[Ann]]', '[[Bo]]'] }, body,
    });
    const written = readFileSync(abs, 'utf8');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written.match(/^---\r?$/gm)).toHaveLength(2); // one frontmatter block: its opening and closing lines
    expect(written).toContain('status: done');
    expect(written.split('Notes from the call.')).toHaveLength(2);
    expect(written).not.toContain('﻿');
  });
});

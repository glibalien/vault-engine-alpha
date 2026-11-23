// Undo puts back text typed into a field that only the note's file held (#656). A value the
// watcher refuses for its field ("TBD" in a date field) is not stored, and the file keeps the
// text (#501). A write that replaces it, and its undo, used to leave the field empty.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { sha256 } from '../../src/indexer/hash.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange } from '../../src/sync/watcher.js';

let vaultPath: string;
let cleanup: () => void;
let db: Database.Database;
let writeLock: WriteLockManager;
let server: McpServer;

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
  writeLock = new WriteLockManager();
  server = new McpServer({ name: 'test', version: '0' });
  registerAllTools(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) });
  createGlobalField(db, { name: 'date', field_type: 'date' });
  createGlobalField(db, { name: 'size', field_type: 'number' });
  createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'date', sort_order: 1 }, { field: 'size', sort_order: 2 }] });
});

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; error?: { message: string } }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
  return JSON.parse(result.content[0].text);
}

/** Save a note's file as an editor would, and let the watcher read it. Returns the note's id. */
function typed(path: string, content: string): string {
  writeFileSync(join(vaultPath, path), content, 'utf-8');
  processFileChange(join(vaultPath, path), path, db, writeLock, vaultPath);
  return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(path) as { id: string }).id;
}

const file = (path: string): string => readFileSync(join(vaultPath, path), 'utf-8');
const storedDate = (id: string): string | null => {
  const row = db.prepare("SELECT value_text, value_date FROM node_fields WHERE node_id = ? AND field_name = 'date'").get(id) as { value_text: string | null; value_date: string | null } | undefined;
  return row === undefined ? null : row.value_date ?? row.value_text;
};
const indexedHash = (id: string): string | null =>
  (db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(id) as { content_hash: string | null }).content_hash;

async function undo(operationId: string): Promise<void> {
  const result = await call('undo-operations', { operation_ids: [operationId], dry_run: false });
  expect(result.ok).toBe(true);
  expect(result.data.total_conflicts).toBe(0);
}

const KICKOFF = 'Kickoff.md';
const WITH_TBD = '---\ntypes:\n  - meeting\ndate: TBD # ask Dana\nsize: 3\n---\nAgenda.\n';

describe('undo of a write that replaced typed text', () => {
  it('puts the typed text back, with no value stored', async () => {
    const id = typed(KICKOFF, WITH_TBD);
    expect(storedDate(id)).toBeNull();

    const written = await call('update-node', { node_id: id, set_fields: { date: '2021-03-04' } });
    expect(written.ok).toBe(true);
    expect(file(KICKOFF)).toContain('date: 2021-03-04\n');
    expect(storedDate(id)).toBe('2021-03-04');

    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toBe(WITH_TBD);
    expect(storedDate(id)).toBeNull();
    // The database's hash is the file's, so the watcher sees nothing new and the next write is not refused.
    expect(indexedHash(id)).toBe(sha256(file(KICKOFF)));
    const later = await call('update-node', { node_id: id, set_fields: { size: 4 } });
    expect(later.ok).toBe(true);
    expect(file(KICKOFF)).toContain('date: TBD # ask Dana\n');
  });

  it('puts it back beside the value the database kept from before', async () => {
    // A date was stored, then "TBD" typed over it: the database keeps the date, the file the text (#501).
    const id = typed(KICKOFF, '---\ntypes:\n  - meeting\ndate: 2021-01-01\nsize: 3\n---\nAgenda.\n');
    typed(KICKOFF, WITH_TBD);
    expect(storedDate(id)).toBe('2021-01-01');

    const written = await call('update-node', { node_id: id, set_fields: { date: '2021-03-04' } });
    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toBe(WITH_TBD);
    expect(storedDate(id)).toBe('2021-01-01');
    expect(indexedHash(id)).toBe(sha256(file(KICKOFF)));
  });

  it('puts it back when the write was a bulk update', async () => {
    const id = typed(KICKOFF, WITH_TBD);
    const other = typed('Review.md', '---\ntypes:\n  - meeting\ndate: soon\n---\nNotes.\n');
    const written = await call('update-node', { query: { types: ['meeting'] }, set_fields: { date: '2021-03-04' }, dry_run: false });
    expect(written.data.updated).toBe(2);
    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toBe(WITH_TBD);
    expect(file('Review.md')).toContain('date: soon\n');
    expect(storedDate(id)).toBeNull();
    expect(storedDate(other)).toBeNull();
  });

  it('leaves a field the write did not change as it was, as before', async () => {
    const id = typed(KICKOFF, WITH_TBD);
    const written = await call('update-node', { node_id: id, set_fields: { size: 4 } });
    expect(file(KICKOFF)).toContain('date: TBD # ask Dana\n');
    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toBe(WITH_TBD);
  });

  it('does not bring back text the database never read', async () => {
    const id = typed(KICKOFF, '---\ntypes:\n  - meeting\nsize: 3\n---\nAgenda.\n');
    // Typed in the editor, not yet read by the watcher: the write is refused as a stale edit, or
    // it overwrites. Either way, no snapshot keeps text the database has not seen.
    writeFileSync(join(vaultPath, KICKOFF), WITH_TBD, 'utf-8');
    const written = await call('update-node', { node_id: id, set_fields: { size: 4 } });
    if (written.ok) {
      const row = db.prepare('SELECT file_only_fields FROM undo_snapshots WHERE operation_id = ?').get(written.data.operation_id) as { file_only_fields: string | null };
      expect(row.file_only_fields).toBeNull();
    }
  });
});

describe('typed text in forms that do not stand alone as lines', () => {
  it('puts back a value from flow-style frontmatter', async () => {
    const id = typed(KICKOFF, '---\n{types: [meeting], date: TBD, size: 3}\n---\nAgenda.\n');
    expect(storedDate(id)).toBeNull();
    const written = await call('update-node', { node_id: id, set_fields: { date: '2021-03-04' } });
    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toContain('date: TBD\n');
    expect(storedDate(id)).toBeNull();
    expect(indexedHash(id)).toBe(sha256(file(KICKOFF)));
  });

  it('puts back a value written as an alias of another line', async () => {
    const id = typed(KICKOFF, '---\ntypes:\n  - meeting\nlabel: &pending TBD\ndate: *pending\n---\nAgenda.\n');
    expect(storedDate(id)).toBeNull();
    const written = await call('update-node', { node_id: id, set_fields: { date: '2021-03-04' } });
    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toMatch(/\ndate: TBD\n/);
    expect(storedDate(id)).toBeNull();
  });
});

describe('an edit the watcher has not read', () => {
  it('is not overwritten by text the snapshot kept', async () => {
    const id = typed(KICKOFF, WITH_TBD);
    const written = await call('update-node', { node_id: id, set_fields: { size: 4 } });
    // Typed in the editor after the operation, not yet read.
    const edited = file(KICKOFF).replace('date: TBD # ask Dana', 'date: when legal agrees');
    writeFileSync(join(vaultPath, KICKOFF), edited, 'utf-8');
    await undo(written.data.operation_id);
    expect(file(KICKOFF)).toContain('date: when legal agrees\n');
    expect(file(KICKOFF)).not.toContain('TBD');
  });

  it('keeps the restore from putting old text back over a field it changes', async () => {
    const id = typed(KICKOFF, WITH_TBD);
    const written = await call('update-node', { node_id: id, set_fields: { date: '2021-03-04' } });
    writeFileSync(join(vaultPath, KICKOFF), file(KICKOFF).replace('Agenda.', 'Agenda, edited.'), 'utf-8');
    await undo(written.data.operation_id);
    // Rendered from the restored state, as before #656: no stored date, and no old text over an unread edit.
    expect(file(KICKOFF)).not.toContain('TBD');
    expect(storedDate(id)).toBeNull();
  });
});

describe('undo of a deleted note', () => {
  it('puts the typed text back in the restored file', async () => {
    const id = typed(KICKOFF, WITH_TBD);
    const deleted = await call('delete-node', { node_id: id, confirm: true, referencing_nodes_limit: 20 });
    expect(deleted.ok).toBe(true);
    expect(existsSync(join(vaultPath, KICKOFF))).toBe(false);
    // delete-node does not return its operation: it is the newest one.
    const operation = db.prepare("SELECT operation_id FROM undo_operations WHERE status = 'active' ORDER BY timestamp DESC LIMIT 1").get() as { operation_id: string };
    await undo(operation.operation_id);
    expect(file(KICKOFF)).toBe(WITH_TBD);
    expect(storedDate(id)).toBeNull();
    expect(indexedHash(id)).toBe(sha256(file(KICKOFF)));
  });
});

describe('the snapshot', () => {
  it('keeps nothing extra for a note whose file holds only what is stored', async () => {
    const id = typed(KICKOFF, '---\ntypes:\n  - meeting\ndate: 2021-01-01\nsize: 3\nlead: Dana\n---\nAgenda.\n');
    const written = await call('update-node', { node_id: id, set_fields: { size: 4 } });
    const row = db.prepare('SELECT file_only_fields FROM undo_snapshots WHERE operation_id = ?').get(written.data.operation_id) as { file_only_fields: string | null };
    expect(row.file_only_fields).toBeNull();
  });
});

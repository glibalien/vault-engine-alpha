// Undo of a rename or move leaves one file for the note, at the restored path (#509).
// The file at the path the operation had moved the note to goes, unless it changed after
// Engine wrote it; the notes whose links the rename rewrote get their links back; and
// no new note appears when the vault is indexed again.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { sha256 } from '../../src/indexer/hash.js';
import { IndexMutex } from '../../src/sync/mutex.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange, startWatcher, type VaultWatcher } from '../../src/sync/watcher.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

// Notes as Engine renders them, so a restore gives back the same bytes.
const NOTE_A = '---\ntypes:\n  - task\nstatus: open\n---\nBody A\n';
const NOTE_B = '---\ntypes:\n  - task\nstatus: closed\n---\nBody B\n';
const REF = '---\ntypes:\n  - task\n---\nSee [[a]] and [[b]].\n';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('undo of a rename or move (#509)', () => {
  let vaultPath: string;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-undo-rename-'));
    mkdirSync(join(vaultPath, '.vault-engine'), { recursive: true });
    db = createTestDb();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerAllTools(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) });
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status', sort_order: 1 }] });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
    writeNote('a.md', NOTE_A);
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function writeNote(relPath: string, content: string): void {
    mkdirSync(join(vaultPath, relPath, '..'), { recursive: true });
    writeFileSync(join(vaultPath, relPath), content, 'utf-8');
    processFileChange(join(vaultPath, relPath), relPath, db, writeLock, vaultPath);
  }

  function read(relPath: string): string {
    return readFileSync(join(vaultPath, relPath), 'utf-8');
  }

  /** Every note file in the vault, by vault path. */
  function noteFiles(dir = vaultPath): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (entry.name.startsWith('.')) return [];
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) return noteFiles(abs);
      return entry.name.endsWith('.md') ? [relative(vaultPath, abs)] : [];
    }).sort();
  }

  function nodes(): Array<{ id: string; file_path: string }> {
    return db.prepare('SELECT id, file_path FROM nodes ORDER BY file_path').all() as Array<{ id: string; file_path: string }>;
  }

  function idAt(relPath: string): string | undefined {
    return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string } | undefined)?.id;
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = JSON.parse((await callTool(server, name, args)).content[0].text);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result;
  }

  function latestOperation(): string {
    return (db.prepare(
      'SELECT operation_id FROM undo_operations ORDER BY timestamp DESC, rowid DESC LIMIT 1',
    ).get() as { operation_id: string }).operation_id;
  }

  async function undo(operationIds: string[], extra: Record<string, unknown> = {}) {
    return ok('undo-operations', { operation_ids: operationIds, dry_run: false, ...extra });
  }

  /** A full index of the vault finds the notes the database holds, and no other. */
  function expectIndexUnchanged(): void {
    const before = nodes();
    fullIndex(vaultPath, db);
    expect(nodes()).toEqual(before);
  }

  it('a rename undone leaves one file, at the old path, with no new note', async () => {
    const id = idAt('a.md');
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
    expect(noteFiles()).toEqual(['renamed.md']);

    const result = await undo([latestOperation()]);

    expect(result.warnings).toEqual([]);
    expect(noteFiles()).toEqual(['a.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expect(nodes()).toEqual([{ id, file_path: 'a.md' }]);
    expectIndexUnchanged();
  });

  it('a move undone leaves one file, at the old path', async () => {
    const id = idAt('a.md');
    await ok('update-node', { file_path: 'a.md', set_directory: 'Archive' });
    expect(noteFiles()).toEqual(['Archive/a.md']);

    await undo([latestOperation()]);

    expect(noteFiles()).toEqual(['a.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expect(nodes()).toEqual([{ id, file_path: 'a.md' }]);
    expectIndexUnchanged();
  });

  it('a rename with an edit undone restores the content at the old path', async () => {
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed', set_body: 'Edited', set_fields: { status: 'closed' } });

    await undo([latestOperation()]);

    expect(noteFiles()).toEqual(['a.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expectIndexUnchanged();
  });

  it('restores the links the rename rewrote in other notes', async () => {
    writeNote('b.md', NOTE_B);
    writeNote('ref.md', REF);
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
    expect(read('ref.md')).toBe('---\ntypes:\n  - task\n---\nSee [[renamed]] and [[b]].\n');

    await undo([latestOperation()]);

    expect(read('ref.md')).toBe(REF);
    expect(noteFiles()).toEqual(['a.md', 'b.md', 'ref.md']);
    const links = db.prepare(`SELECT target, resolved_target_id FROM relationships
      WHERE source_id = ? AND rel_type = 'wiki-link' ORDER BY target`).all(idAt('ref.md'));
    expect(links).toEqual([
      { target: 'a', resolved_target_id: idAt('a.md') },
      { target: 'b', resolved_target_id: idAt('b.md') },
    ]);
    expectIndexUnchanged();
  });

  it('keeps the moved file when it changed after the rename, and says so', async () => {
    const id = idAt('a.md');
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
    // Changed on disk; the watcher has not read it yet.
    const changed = NOTE_A.replace('Body A', 'Body A, changed by hand');
    writeFileSync(join(vaultPath, 'renamed.md'), changed, 'utf-8');

    const result = await undo([latestOperation()]);

    expect(read('a.md')).toBe(NOTE_A);
    expect(read('renamed.md')).toBe(changed);
    expect(nodes()).toEqual([{ id, file_path: 'a.md' }]);
    expect(result.warnings).toEqual([expect.objectContaining({
      code: 'UNDO_FILE_KEPT',
      severity: 'warning',
      details: { node_id: id, file_path: 'renamed.md', restored_file_path: 'a.md', reason: 'changed' },
    })]);
  });

  it('reports an edit indexed after a pure rename as a conflict and keeps the file', async () => {
    const id = idAt('a.md');
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
    const operationId = latestOperation();
    const changed = NOTE_A.replace('Body A', 'Body A, changed by hand');
    writeNote('renamed.md', changed);

    const result = await undo([operationId]);

    expect(result.data.conflicts).toEqual([expect.objectContaining({ node_id: id, reason: 'modified_after_operation' })]);
    expect(noteFiles()).toEqual(['renamed.md']);
    expect(read('renamed.md')).toBe(changed);
    expect(nodes()).toEqual([{ id, file_path: 'renamed.md' }]);
  });

  it('a reverted conflict moves the note back and removes the file the database records', async () => {
    const id = idAt('a.md');
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
    const operationId = latestOperation();
    writeNote('renamed.md', NOTE_A.replace('Body A', 'Body A, changed by hand'));

    const result = await undo([operationId], { resolve_conflicts: [{ node_id: id, action: 'revert' }] });

    expect(result.warnings).toEqual([]);
    expect(noteFiles()).toEqual(['a.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expectIndexUnchanged();
  });

  it('keeps a typed value the watcher rejected (#501) in the note moved back', async () => {
    const typed = '---\ntypes:\n  - task\nstatus: someday\n---\nBody A\n';
    writeNote('a.md', typed);
    expect(db.prepare(`SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = 'status'`).get(idAt('a.md')))
      .toEqual({ value_text: 'open' });
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed', set_body: 'Edited' });
    expect(read('renamed.md')).toBe('---\ntypes:\n  - task\nstatus: someday\n---\nEdited');

    await undo([latestOperation()]);

    expect(noteFiles()).toEqual(['a.md']);
    expect(read('a.md')).toBe(typed);
    // The file the undo wrote is the one the database records.
    expect(db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get('a.md')).toEqual({ content_hash: sha256(typed) });
    expectIndexUnchanged();
  });

  it('a rename undone together with a later edit leaves one file', async () => {
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
    const renameOp = latestOperation();
    await ok('update-node', { file_path: 'renamed.md', set_body: 'Edited later' });
    const editOp = latestOperation();

    const result = await undo([renameOp, editOp]);

    expect(result.data.total_conflicts).toBe(0);
    expect(noteFiles()).toEqual(['a.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expectIndexUnchanged();
  });

  it.each([1, 2])('a bulk move undone leaves one file per note (reference policy %i)', async policy => {
    if (policy === 2) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
    }
    writeNote('b.md', NOTE_B);
    const before = nodes();
    await ok('update-node', { query: { types: ['task'] }, set_directory: 'Archive', dry_run: false });
    expect(noteFiles()).toEqual(['Archive/a.md', 'Archive/b.md']);

    const result = await undo([latestOperation()]);

    expect(result.data.total_undone).toBe(2);
    expect(noteFiles()).toEqual(['a.md', 'b.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expect(read('b.md')).toBe(NOTE_B);
    expect(nodes()).toEqual(before);
    expectIndexUnchanged();
  });

  it('batch-mutate renames undone leave one file per note', async () => {
    writeNote('b.md', NOTE_B);
    writeNote('ref.md', REF);
    const before = nodes();
    await ok('batch-mutate', {
      operations: [
        { op: 'update', params: { file_path: 'a.md', set_title: 'a2' } },
        { op: 'update', params: { file_path: 'b.md', set_title: 'b2', set_body: 'Edited B' } },
      ],
    });
    expect(noteFiles()).toEqual(['a2.md', 'b2.md', 'ref.md']);
    expect(read('ref.md')).toContain('[[a2]] and [[b2]]');

    await undo([latestOperation()]);

    expect(noteFiles()).toEqual(['a.md', 'b.md', 'ref.md']);
    expect(read('a.md')).toBe(NOTE_A);
    expect(read('b.md')).toBe(NOTE_B);
    expect(read('ref.md')).toBe(REF);
    expect(nodes()).toEqual(before);
    expectIndexUnchanged();
  });

  it('a note created and renamed in one batch is removed by the undo', async () => {
    await ok('batch-mutate', {
      operations: [
        { op: 'create', params: { title: 'fresh', types: ['task'], fields: { status: 'open' }, body: 'New' } },
        { op: 'update', params: { file_path: 'fresh.md', set_title: 'fresher' } },
      ],
    });
    expect(noteFiles()).toEqual(['a.md', 'fresher.md']);

    await undo([latestOperation()]);

    expect(noteFiles()).toEqual(['a.md']);
    expect(nodes().map(n => n.file_path)).toEqual(['a.md']);
    expectIndexUnchanged();
  });

  it('a dry run leaves the files as they are', async () => {
    await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });

    await ok('undo-operations', { operation_ids: [latestOperation()], dry_run: true });

    expect(noteFiles()).toEqual(['renamed.md']);
  });

  it.skipIf(process.getuid?.() === 0)('keeps the moved file when it cannot be removed, and says so', async () => {
    const id = idAt('a.md');
    await ok('update-node', { file_path: 'a.md', set_directory: 'Locked' });
    chmodSync(join(vaultPath, 'Locked'), 0o555);
    try {
      const result = await undo([latestOperation()]);

      expect(read('a.md')).toBe(NOTE_A);
      expect(read('Locked/a.md')).toBe(NOTE_A);
      expect(nodes()).toEqual([{ id, file_path: 'a.md' }]);
      expect(result.warnings).toEqual([expect.objectContaining({
        code: 'UNDO_FILE_KEPT',
        details: expect.objectContaining({ file_path: 'Locked/a.md', restored_file_path: 'a.md', reason: 'remove_failed' }),
      })]);
    } finally {
      chmodSync(join(vaultPath, 'Locked'), 0o755);
    }
  });

  describe('with the watcher running', () => {
    const DEBOUNCE_MS = 200;
    const RENAME_GRACE_MS = 800;
    let watcher: VaultWatcher;
    let mutex: IndexMutex;

    beforeEach(async () => {
      mutex = new IndexMutex();
      watcher = startWatcher(vaultPath, db, mutex, writeLock, new SyncLogger(db), undefined, undefined, {
        debounceMs: DEBOUNCE_MS,
        maxWaitMs: 400,
        renameGraceMs: RENAME_GRACE_MS,
      });
      await watcher.waitUntilReady();
    });

    afterEach(async () => {
      await watcher.close();
    });

    async function settle(): Promise<void> {
      await delay(RENAME_GRACE_MS + 400);
      await mutex.onIdle();
    }

    it('does not take the removal for a delete of the note', async () => {
      const id = idAt('a.md')!;
      const memory = await ok('create-memory', {
        evidence: { kind: 'conversation', ref: 'test#0' }, source: 'chat', content: 'a fact about a', scope: 'node', node_id: id,
      });
      await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
      await settle();
      expect(nodes()).toEqual([{ id, file_path: 'renamed.md' }]);

      await undo([latestOperation()]);
      await settle();

      expect(noteFiles()).toEqual(['a.md']);
      expect(nodes()).toEqual([{ id, file_path: 'a.md' }]);
      expect(db.prepare(`SELECT 1 FROM edits_log WHERE event_type = 'file-deleted'`).all()).toEqual([]);
      expect(db.prepare('SELECT expired_at FROM memories WHERE id = ?').get(memory.data.id)).toEqual({ expired_at: null });
    });
  });
});

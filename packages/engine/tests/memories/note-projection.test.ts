import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { MemoryService } from '../../src/memories/service.js';
import { MemoryNoteReceipts } from '../../src/memories/note-receipts.js';
import { MemoryNoteIngest } from '../../src/memories/note-ingest.js';
import { MemoryNoteProjection } from '../../src/memories/note-projection.js';
import { memoryNotePath } from '../../src/memories/note-format.js';

const EV = { kind: 'conversation', ref: 'test#0' } as const;
const SETTINGS_DIR = 'Settings';
const NOTE_PATH = memoryNotePath(SETTINGS_DIR);

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let service: MemoryService;
let projection: MemoryNoteProjection;

beforeEach(() => {
  db = createTestDb();
  const v = createTempVault(); vaultPath = v.vaultPath; cleanup = v.cleanup;
  service = new MemoryService(db);
  const receipts = new MemoryNoteReceipts(db);
  const ingest = new MemoryNoteIngest({ db, vaultPath, settingsDir: SETTINGS_DIR, service, receipts });
  projection = new MemoryNoteProjection({
    db, writeLock: new WriteLockManager(), vaultPath, settingsDir: SETTINGS_DIR,
    service, ingest,
  });
});
afterEach(() => { cleanup(); db.close(); });

function ensureNoteDir(): void {
  mkdirSync(dirname(join(vaultPath, NOTE_PATH)), { recursive: true });
}

describe('MemoryNoteProjection', () => {
  it('preview is pure: no file, no DB mutation, no node creation', async () => {
    await service.create({ source: 'chat', content: 'test fact', scope: 'vault', evidence: EV });
    const preview = await projection.preview();
    expect(preview.live_count).toBe(1);
    expect(preview.historical_count).toBe(0);
    expect(preview.total).toBe(1);
    expect(preview.would_write).toBe(true); // no existing note → would write
    expect(preview.rendered_hash.startsWith('sha256:')).toBe(true);
    expect(preview.bytes).toBeGreaterThan(0);
    // No node was created
    const nodeCount = (db.prepare('SELECT COUNT(*) c FROM nodes WHERE file_path = ?').get(NOTE_PATH) as { c: number }).c;
    expect(nodeCount).toBe(0);
    // No file on disk
    expect(() => readFileSync(join(vaultPath, NOTE_PATH), 'utf8')).toThrow();
  });

  it('refresh creates the note file through executeMutation', async () => {
    await service.create({ source: 'chat', content: 'a durable fact', scope: 'vault', evidence: EV });
    const result = await projection.refresh();
    expect(result.file_written).toBe(true);
    expect(result.node_id).not.toBeNull();
    // File exists on disk
    const content = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    expect(content).toContain('a durable fact');
    expect(content).toContain('vault_engine_projection: memories');
    // The projection supplies body + fields to executeMutation. It must not
    // embed a second complete markdown file inside the pipeline-rendered one.
    expect(content.match(/^---\ntypes:/gm)).toHaveLength(1);
    // Node exists in DB
    const node = db.prepare('SELECT id, content_hash FROM nodes WHERE file_path = ?').get(NOTE_PATH) as { id: string; content_hash: string };
    expect(node).toBeDefined();
    // meta.last_refresh_at was set
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'memory_note.last_refresh_at'").get() as { value: string } | undefined;
    expect(meta).toBeDefined();
  });

  it('deterministic no-op: second refresh with unchanged data does not write', async () => {
    await service.create({ source: 'chat', content: 'stable fact', scope: 'vault', evidence: EV });
    await projection.refresh();
    const result = await projection.refresh();
    expect(result.file_written).toBe(false);
  });

  it('refresh after a memory update writes the new content', async () => {
    const { result: created } = await service.create({ source: 'chat', content: 'v1', scope: 'vault', evidence: EV });
    if (!created.ok) throw new Error('create failed');
    await projection.refresh();

    // Update the memory (category-only → same id, bumped updated_at)
    await service.update({ id: created.data.id, category: 'preference' });
    const result = await projection.refresh();
    expect(result.file_written).toBe(true);
    const content = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    expect(content).toContain('category: preference');
  });

  it('issues callout: edits_log events since last refresh appear in the note', async () => {
    await service.create({ source: 'chat', content: 'fact', scope: 'vault', evidence: EV });
    await projection.refresh(); // sets last_refresh_at

    // Simulate a rejection
    db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
      null, Date.now(), 'memory-note-rejected', JSON.stringify({ messages: ['bad YAML'] }),
    );

    const result = await projection.refresh();
    expect(result.issues_rendered).toBeGreaterThan(0);
    const content = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    expect(content).toContain('> [!warning] Memory note ingest issues');
  });

  it('issues callout includes duplicate receipts with their block key', async () => {
    await service.create({ source: 'chat', content: 'fact', scope: 'vault', evidence: EV });
    await projection.refresh();
    db.prepare(
      `INSERT INTO memory_note_receipts
         (block_key, edit_hash, source_memory_id, result_memory_id, outcome, details_json, applied_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
    ).run('mem:new:review-draft', 'sha256:review', 'duplicate', JSON.stringify({ message: 'already represented by memory 42' }), new Date().toISOString());

    await projection.refresh();
    const content = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    expect(content).toContain('`mem:new:review-draft` (duplicate) — already represented by memory 42');
  });

  it('pending ingest is drained before render', async () => {
    const { result: created } = await service.create({ source: 'chat', content: 'original', scope: 'vault', evidence: EV });
    if (!created.ok) throw new Error('create failed');

    // Render the note first
    await projection.refresh();
    const oldContent = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');

    // Edit the note content and update the indexed node's content_hash
    const edited = oldContent.replace('original', 'drained before render');
    writeFileSync(join(vaultPath, NOTE_PATH), edited, 'utf8');
    const node = db.prepare('SELECT id, content_hash FROM nodes WHERE file_path = ?').get(NOTE_PATH) as { id: string; content_hash: string };
    const newHash = createHash('sha256').update(edited).digest('hex');
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(newHash, node.id);

    // The projection shares the same ingest instance. But we need to trigger
    // the ingest manually — the watcher hook would normally do this.
    // The MemoryNoteIngest.onFileEvent reads the file, parses, validates,
    // and applies edits through MemoryService. We call it via the ingest
    // instance that the projection holds.
    // We need access to the ingest — let's construct a fresh one for this test.
    const receipts = new MemoryNoteReceipts(db);
    const ingest2 = new MemoryNoteIngest({ db, vaultPath, settingsDir: SETTINGS_DIR, service, receipts });
    ingest2.onFileEvent(NOTE_PATH, 'change');

    // Now create a projection that uses ingest2 and refresh — drain() should
    // complete the pending edit before rendering.
    const proj2 = new MemoryNoteProjection({
      db, writeLock: new WriteLockManager(), vaultPath, settingsDir: SETTINGS_DIR,
      service, ingest: ingest2,
    });
    const result = await proj2.refresh();
    expect(result.file_written).toBe(true);
    const content = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    expect(content).toContain('drained before render');
  });

  it('no raw filesystem write: all writes go through executeMutation', async () => {
    await service.create({ source: 'chat', content: 'test', scope: 'vault', evidence: EV });
    await projection.refresh();
    // The file exists and was written through the pipeline (not raw writeFileSync)
    const node = db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get(NOTE_PATH) as { content_hash: string };
    const fileContent = readFileSync(join(vaultPath, NOTE_PATH), 'utf8');
    const fileHash = createHash('sha256').update(fileContent).digest('hex');
    // The DB content_hash should match the file (executeMutation keeps them in sync).
    // DB stores raw hex (no sha256: prefix).
    expect(node.content_hash).toBe(fileHash);
  });

  it('does not recreate an indexed memory note whose file is temporarily missing', async () => {
    await service.create({ source: 'chat', content: 'phoenix', scope: 'vault', evidence: EV });
    await projection.refresh();
    // Delete the file on disk (the node still exists in DB)
    unlinkSync(join(vaultPath, NOTE_PATH));
    await expect(projection.refresh()).rejects.toThrow(/content changed since you read it/i);
    expect(existsSync(join(vaultPath, NOTE_PATH))).toBe(false);
  });

  it('refuses to overwrite an unindexed human disk edit', async () => {
    await service.create({ source: 'chat', content: 'canonical memory', scope: 'vault', evidence: EV });
    await projection.refresh();
    const path = join(vaultPath, NOTE_PATH);
    const humanEdit = readFileSync(path, 'utf8').replace('canonical memory', 'UNINDEXED HUMAN EDIT');
    writeFileSync(path, humanEdit, 'utf8');

    await expect(projection.refresh()).rejects.toThrow(/content_hash conflict/i);
    expect(readFileSync(path, 'utf8')).toBe(humanEdit);
  });

  it('preview agrees that a just-refreshed projection would not write', async () => {
    await service.create({ source: 'chat', content: 'stable preview', scope: 'vault', evidence: EV });
    await projection.refresh();
    expect((await projection.preview()).would_write).toBe(false);
  });

  it.each(['missing', 'unindexed-edit'] as const)('preview and refresh reject %s without changes', async state => {
    await service.create({ source: 'chat', content: 'canonical memory', scope: 'vault', evidence: EV });
    await projection.refresh();
    const path = join(vaultPath, NOTE_PATH);
    if (state === 'missing') unlinkSync(path);
    else writeFileSync(path, 'Unindexed human content');
    const beforeDb = db.serialize();
    const beforeFile = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const expected = state === 'missing' ? /content changed since you read it/i : /content_hash conflict/i;
    await expect(projection.preview()).rejects.toThrow(expected);
    expect(db.serialize()).toEqual(beforeDb);
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(beforeFile);
    await expect(projection.refresh()).rejects.toThrow(expected);
    expect(db.serialize()).toEqual(beforeDb);
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(beforeFile);
  });
});

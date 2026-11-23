import { describe, it, expect, beforeEach, onTestFinished } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync, unlinkSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForArchiveLog, upgradeForAttachmentTranscripts, upgradeForMaterializedTranscripts, addUndoTables, addSchemaUndoSnapshots, addUiHints } from '../../src/db/migrate.js';
import { ArchiveLog as ArchiveLogStore } from '../../src/extraction/archive-log.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { verifyEligibility, archiveSource, ARCHIVE_DIR, type ArchiveDeps } from '../../src/mcp/tools/archive-source.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Write an attachment file and capture a matching transcript row. */
function seedAttachment(
  dir: string,
  store: TranscriptStore,
  relPath: string,
  opts?: { embedRef?: string; text?: string; hash?: string; content?: string },
): void {
  const content = opts?.content ?? `binary-content-of-${relPath}`;
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  store.capture({
    embedRef: opts?.embedRef ?? relPath,
    vaultPath: relPath,
    contentHash: opts?.hash ?? sha256(content),
    extractedText: opts?.text ?? 'a transcript',
    mediaType: 'audio',
    extractorId: 'deepgram',
  });
}

describe('upgradeForArchiveLog', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('creates the archive_log table with indexes', () => {
    upgradeForArchiveLog(db);
    const cols = (db.prepare('PRAGMA table_info(archive_log)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'vault_path', 'content_hash', 'bytes', 'mode',
      'archive_path', 'materialized_node_id', 'operation_id', 'archived_at',
    ]));
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='archive_log'").all() as { name: string }[]).map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_archive_log_vault_path', 'idx_archive_log_archived_at']));
  });

  it('is idempotent', () => {
    upgradeForArchiveLog(db);
    expect(() => upgradeForArchiveLog(db)).not.toThrow();
  });
});

describe('ArchiveLog', () => {
  let db: Database.Database;
  let log: ArchiveLogStore;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForArchiveLog(db);
    log = new ArchiveLogStore(db);
  });

  it('records an archive entry and lists it by path', () => {
    log.record({
      vaultPath: 'Attachments/rec.m4a',
      contentHash: 'h1',
      bytes: 12345,
      mode: 'archive',
      archivePath: '.vault-engine/archive/Attachments/rec.m4a',
      materializedNodeId: 'node-1',
      operationId: 'op-1',
    });
    const rows = log.listByPath('Attachments/rec.m4a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vault_path: 'Attachments/rec.m4a',
      content_hash: 'h1',
      bytes: 12345,
      mode: 'archive',
      archive_path: '.vault-engine/archive/Attachments/rec.m4a',
      materialized_node_id: 'node-1',
      operation_id: 'op-1',
    });
    expect(rows[0].archived_at).toBeTypeOf('string');
  });

  it('is append-only: re-recording the same path adds a second row', () => {
    log.record({ vaultPath: 'a.m4a', contentHash: 'h1', bytes: 1, mode: 'archive', archivePath: 'x', materializedNodeId: null, operationId: null });
    log.record({ vaultPath: 'a.m4a', contentHash: 'h2', bytes: 2, mode: 'purge', archivePath: null, materializedNodeId: null, operationId: null });
    expect(log.listByPath('a.m4a')).toHaveLength(2);
  });

  it('totals() sums count and bytes', () => {
    log.record({ vaultPath: 'a.m4a', contentHash: 'h1', bytes: 100, mode: 'archive', archivePath: 'x', materializedNodeId: null, operationId: null });
    log.record({ vaultPath: 'b.m4a', contentHash: 'h2', bytes: 250, mode: 'purge', archivePath: null, materializedNodeId: null, operationId: null });
    expect(log.totals()).toEqual({ sources: 2, bytes: 350 });
  });
});

describe('TranscriptStore.listByPath', () => {
  let db: Database.Database;
  let store: TranscriptStore;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    store = new TranscriptStore(db);
  });

  it('returns ALL rows sharing a vault_path (multiple embed-ref spellings)', () => {
    store.capture({ embedRef: 'rec.m4a', vaultPath: 'Attachments/rec.m4a', contentHash: 'h1', extractedText: 'text', mediaType: 'audio', extractorId: 'deepgram' });
    store.capture({ embedRef: 'Attachments/rec.m4a', vaultPath: 'Attachments/rec.m4a', contentHash: 'h1', extractedText: 'text', mediaType: 'audio', extractorId: 'deepgram' });
    store.capture({ embedRef: 'other.m4a', vaultPath: 'Attachments/other.m4a', contentHash: 'h2', extractedText: 'x', mediaType: 'audio', extractorId: 'deepgram' });
    const rows = store.listByPath('Attachments/rec.m4a');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.embed_ref).sort()).toEqual(['Attachments/rec.m4a', 'rec.m4a']);
  });

  it('returns [] for an unknown path', () => {
    expect(store.listByPath('nope.m4a')).toEqual([]);
  });
});

describe('verifyEligibility', () => {
  let db: Database.Database;
  let dir: string;
  let store: TranscriptStore;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    upgradeForArchiveLog(db);
    dir = mkdtempSync(join(tmpdir(), 've-archive-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'Attachments'), { recursive: true });
    store = new TranscriptStore(db);
  });

  it('file_missing when the path does not exist', () => {
    const r = verifyEligibility(db, dir, store, 'Attachments/nope.m4a');
    expect(r).toEqual({ eligible: false, reasons: ['file_missing'] });
  });

  it('symlink refused', () => {
    writeFileSync(join(dir, 'real.m4a'), 'x');
    symlinkSync(join(dir, 'real.m4a'), join(dir, 'Attachments/link.m4a'));
    const r = verifyEligibility(db, dir, store, 'Attachments/link.m4a');
    expect(r).toEqual({ eligible: false, reasons: ['symlink'] });
  });

  it('not_a_file when the path is a directory', () => {
    mkdirSync(join(dir, 'Attachments/adir'), { recursive: true });
    const r = verifyEligibility(db, dir, store, 'Attachments/adir');
    expect(r).toEqual({ eligible: false, reasons: ['not_a_file'] });
  });

  it('no_transcript when no rows exist for the path', () => {
    writeFileSync(join(dir, 'Attachments/raw.m4a'), 'x');
    const r = verifyEligibility(db, dir, store, 'Attachments/raw.m4a');
    expect(r).toEqual({ eligible: false, reasons: ['no_transcript'] });
  });

  it('empty_transcript when any row has empty text', () => {
    seedAttachment(dir, store, 'Attachments/rec.m4a', { text: '' });
    const r = verifyEligibility(db, dir, store, 'Attachments/rec.m4a');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reasons).toContain('empty_transcript');
  });

  it('hash_mismatch when the live bytes differ from the captured hash', () => {
    seedAttachment(dir, store, 'Attachments/rec.m4a', { hash: 'stale-hash' });
    const r = verifyEligibility(db, dir, store, 'Attachments/rec.m4a');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reasons).toEqual(['hash_mismatch']);
  });

  it('requires EVERY ref row to match — one stale sibling ref fails the gate', () => {
    const content = 'same-bytes';
    seedAttachment(dir, store, 'Attachments/rec.m4a', { content, embedRef: 'rec.m4a' });
    store.capture({ embedRef: 'Attachments/rec.m4a', vaultPath: 'Attachments/rec.m4a', contentHash: 'stale', extractedText: 't', mediaType: 'audio', extractorId: 'deepgram' });
    const r = verifyEligibility(db, dir, store, 'Attachments/rec.m4a');
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reasons).toEqual(['hash_mismatch']);
  });

  it('eligible: returns bytes, rows, refs, and embeddingsVerified=false with no embedding rows', () => {
    seedAttachment(dir, store, 'Attachments/rec.m4a', { content: 'audio-bytes' });
    const r = verifyEligibility(db, dir, store, 'Attachments/rec.m4a');
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.source.bytes).toBe(Buffer.byteLength('audio-bytes'));
      expect(r.source.rows).toHaveLength(1);
      expect(r.source.refs).toContain('Attachments/rec.m4a');
      expect(r.source.refs).toContain('rec.m4a');
      expect(r.source.embeddingsVerified).toBe(false);
    }
  });

  it('embeddingsVerified=true when every ref has an extraction embedding row', () => {
    seedAttachment(dir, store, 'Attachments/rec.m4a');
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'note.md', 'note', '', 'h')").run();
    db.prepare(`INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
                VALUES ('n1', 'extraction', 'th', 0, 'Attachments/rec.m4a', '2026-01-01')`).run();
    const r = verifyEligibility(db, dir, store, 'Attachments/rec.m4a');
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.source.embeddingsVerified).toBe(true);
  });

  it('counts referencing notes via wiki-link relationships', () => {
    seedAttachment(dir, store, 'Attachments/rec.m4a');
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('n1', 'note.md', 'note', '![[rec.m4a]]', 'h')").run();
    db.prepare("INSERT INTO relationships (source_id, target, rel_type, context) VALUES ('n1', 'rec.m4a', 'wiki-link', 'c')").run();
    const r = verifyEligibility(db, dir, store, 'Attachments/rec.m4a');
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.source.referencingNotes).toBe(1);
  });
});

describe('archiveSource (single mode)', () => {
  let db: Database.Database;
  let dir: string;
  let store: TranscriptStore;
  let deps: ArchiveDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    upgradeForArchiveLog(db);
    addUndoTables(db);
    addSchemaUndoSnapshots(db);
    addUiHints(db);
    dir = mkdtempSync(join(tmpdir(), 've-archive-x-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'Attachments'), { recursive: true });
    store = new TranscriptStore(db);
    deps = { db, writeLock: new WriteLockManager(), vaultPath: dir, transcriptStore: store };
  });

  /** Seed attachment + a referencing note (node row + wiki-link relationship + file on disk). */
  function seedWithReferencingNote(relPath = 'Attachments/rec.m4a', embedRef = 'rec.m4a'): void {
    seedAttachment(dir, store, relPath, { embedRef, text: 'speaker transcript' });
    const body = `Intro\n\n![[${embedRef}]]\n\nOutro`;
    writeFileSync(join(dir, 'note.md'), `---\n---\n${body}`);
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('note1', 'note.md', 'note', body, 'h');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('note1', embedRef, 'wiki-link', 'ctx');
  }

  it('NOT_ELIGIBLE for a file with no transcript', async () => {
    writeFileSync(join(dir, 'Attachments/raw.m4a'), 'x');
    const r = await archiveSource(deps, { vault_path: 'Attachments/raw.m4a' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_ELIGIBLE');
      expect(r.details?.reasons).toEqual(['no_transcript']);
    }
  });

  it('dry_run previews without touching disk or DB', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a', dry_run: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dry_run).toBe(true);
      const wa = r.data.would_archive as Record<string, unknown>;
      expect(wa.vault_path).toBe('Attachments/rec.m4a');
      expect(wa.mode).toBe('archive');
      expect(wa.archive_path).toBe(`${ARCHIVE_DIR}/Attachments/rec.m4a`);
      expect(r.data.referencing_notes).toBe(1);
      expect(r.data.would_materialize).toBe(true);
    }
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
    expect(new ArchiveLogStore(db).totals().sources).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM undo_operations').get()).toEqual({ c: 0 });
  });

  it('dry_run rejects a missing note that materialization would repoint without side effects', async () => {
    seedWithReferencingNote();
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get('note1');
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM archive_log) AS archive_log,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(join(dir, 'note.md'));

    const withoutMaterialization = await archiveSource(deps, {
      vault_path: 'Attachments/rec.m4a',
      materialize: false,
      dry_run: true,
    });
    const result = await archiveSource(deps, {
      vault_path: 'Attachments/rec.m4a',
      dry_run: true,
    });

    expect(withoutMaterialization.ok).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CONTENT_HASH_MISMATCH');
      expect(result.details?.current_content_hash).toBeNull();
    }
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(false);
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
    expect(store.getByRef('rec.m4a')?.source_deleted).toBe(0);
    expect(store.getByRef('rec.m4a')?.materialized_node_id).toBeNull();
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get('note1')).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM archive_log) AS archive_log,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('dry_run skips repoint preflight when a live materialized node will be reused', async () => {
    seedWithReferencingNote();
    unlinkSync(join(dir, 'note.md'));
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('mat1', 'Transcripts/rec.md', 'rec', 'transcript', 'h')").run();
    store.markMaterialized('rec.m4a', 'mat1');

    const result = await archiveSource(deps, {
      vault_path: 'Attachments/rec.m4a',
      dry_run: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.would_materialize).toBe(false);
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM undo_operations').get()).toEqual({ c: 0 });
  });

  it('archives: materializes, repoints, moves the file, marks deleted, logs provenance', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a' });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(false);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(true);
    const node = db.prepare("SELECT id FROM nodes WHERE file_path = 'Transcripts/rec.md'").get() as { id: string } | undefined;
    expect(node).toBeTruthy();
    const noteBody = (db.prepare("SELECT body FROM nodes WHERE id = 'note1'").get() as { body: string }).body;
    expect(noteBody).toContain('![[rec]]');
    expect(noteBody).not.toContain('rec.m4a');
    expect(store.getByRef('rec.m4a')?.source_deleted).toBe(1);
    const logRows = new ArchiveLogStore(db).listByPath('Attachments/rec.m4a');
    expect(logRows).toHaveLength(1);
    expect(logRows[0].mode).toBe('archive');
    expect(logRows[0].bytes).toBeGreaterThan(0);
    expect(logRows[0].materialized_node_id).toBe(node!.id);
    const ops = db.prepare('SELECT source_tool FROM undo_operations').all() as Array<{ source_tool: string }>;
    expect(ops).toEqual([{ source_tool: 'archive-source' }]);
    if (r.ok) {
      const archived = r.data.archived as Record<string, unknown>;
      expect(archived.materialized_node_id).toBe(node!.id);
      expect(archived.repointed_notes).toBe(1);
    }
  });

  it('materialize:false leaves embeds and creates no node', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a', materialize: false });
    expect(r.ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM nodes WHERE file_path LIKE 'Transcripts/%'").get()).toEqual({ c: 0 });
    const noteBody = (db.prepare("SELECT body FROM nodes WHERE id = 'note1'").get() as { body: string }).body;
    expect(noteBody).toContain('![[rec.m4a]]');
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(true);
  });

  it('reuses an existing materialized node instead of creating a duplicate', async () => {
    seedWithReferencingNote();
    db.prepare("INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES ('mat1', 'Transcripts/rec.md', 'rec', 'b', 'h')").run();
    store.markMaterialized('rec.m4a', 'mat1');
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data.archived as Record<string, unknown>).materialized_node_id).toBe('mat1');
    expect(db.prepare("SELECT COUNT(*) c FROM nodes WHERE file_path LIKE 'Transcripts/%'").get()).toEqual({ c: 1 });
  });

  it('purge without confirm → CONFIRMATION_REQUIRED, file untouched', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a', purge: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONFIRMATION_REQUIRED');
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
  });

  it('purge with confirm unlinks the file and logs mode=purge with null archive_path', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a', purge: true, confirm: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(false);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(false);
    const logRows = new ArchiveLogStore(db).listByPath('Attachments/rec.m4a');
    expect(logRows[0].mode).toBe('purge');
    expect(logRows[0].archive_path).toBeNull();
  });

  it('collision in the archive dir gets a timestamp suffix', async () => {
    seedWithReferencingNote();
    mkdirSync(join(dir, ARCHIVE_DIR, 'Attachments'), { recursive: true });
    writeFileSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'), 'older archived copy');
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a', materialize: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const archived = r.data.archived as Record<string, unknown>;
      expect(archived.archive_path).toMatch(/^\.vault-engine\/archive\/Attachments\/rec-.+\.m4a$/);
      expect(existsSync(join(dir, archived.archive_path as string))).toBe(true);
    }
    expect(readFileSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'), 'utf-8')).toBe('older archived copy');
  });

  it('rolls the file move back when the transaction fails after the rename', async () => {
    seedWithReferencingNote();
    const failingStore = Object.create(store) as TranscriptStore;
    failingStore.markDeleted = () => { throw new Error('injected markDeleted failure'); };
    const r = await archiveSource({ ...deps, transcriptStore: failingStore }, { vault_path: 'Attachments/rec.m4a', materialize: false });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(false);
    expect(new ArchiveLogStore(db).totals().sources).toBe(0);
    expect(store.getByRef('rec.m4a')?.source_deleted).toBe(0);
  });

  it('embed_ref single mode resolves through the transcript row vault_path', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { embed_ref: 'rec.m4a', materialize: false });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(true);
  });

  it('rolls back materialize file writes too when a later step fails (shared fsUndos)', async () => {
    seedWithReferencingNote();
    const originalNoteOnDisk = readFileSync(join(dir, 'note.md'), 'utf-8');
    const failingStore = Object.create(store) as TranscriptStore;
    failingStore.markDeleted = () => { throw new Error('injected markDeleted failure'); };
    const r = await archiveSource({ ...deps, transcriptStore: failingStore }, { vault_path: 'Attachments/rec.m4a' });
    expect(r.ok).toBe(false);
    // archive rename undone
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/rec.m4a'))).toBe(false);
    // materialized node file removed from disk, node row rolled back
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) c FROM nodes WHERE file_path LIKE 'Transcripts/%'").get()).toEqual({ c: 0 });
    // repointed note restored on disk and in DB
    expect(readFileSync(join(dir, 'note.md'), 'utf-8')).toBe(originalNoteOnDisk);
    const noteBody = (db.prepare("SELECT body FROM nodes WHERE id = 'note1'").get() as { body: string }).body;
    expect(noteBody).toContain('![[rec.m4a]]');
    // no provenance, no deletion mark
    expect(new ArchiveLogStore(db).totals().sources).toBe(0);
    expect(store.getByRef('rec.m4a')?.source_deleted).toBe(0);
  });

  it('EMBEDDINGS_UNVERIFIED warning is attached when coverage is missing', async () => {
    seedWithReferencingNote();
    const r = await archiveSource(deps, { vault_path: 'Attachments/rec.m4a', dry_run: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.warnings ?? []).map(w => w.code)).toContain('EMBEDDINGS_UNVERIFIED');
    }
  });

  it('purge refuses to unlink bytes that changed after verification (TOCTOU guard)', async () => {
    seedWithReferencingNote();
    // markDeleted runs inside the txn, between verification and the post-commit
    // unlink — use it to mutate the file inside that window.
    const sneakyStore = Object.create(store) as TranscriptStore;
    sneakyStore.markDeleted = (p: string) => {
      writeFileSync(join(dir, 'Attachments/rec.m4a'), 'NEWER BYTES recorded after verification');
      return TranscriptStore.prototype.markDeleted.call(store, p);
    };
    const r = await archiveSource(
      { ...deps, transcriptStore: sneakyStore },
      { vault_path: 'Attachments/rec.m4a', purge: true, confirm: true, materialize: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('changed on disk after verification');
    // the newer bytes were preserved, not deleted
    expect(readFileSync(join(dir, 'Attachments/rec.m4a'), 'utf-8')).toBe('NEWER BYTES recorded after verification');
  });
});

describe('archiveSource (sweep mode)', () => {
  let db: Database.Database;
  let dir: string;
  let store: TranscriptStore;
  let deps: ArchiveDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    upgradeForArchiveLog(db);
    addUndoTables(db);
    addSchemaUndoSnapshots(db);
    addUiHints(db);
    dir = mkdtempSync(join(tmpdir(), 've-sweep-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'Attachments'), { recursive: true });
    store = new TranscriptStore(db);
    deps = { db, writeLock: new WriteLockManager(), vaultPath: dir, transcriptStore: store };
  });

  /** Make a file old enough for the default 30-day threshold. */
  function age(relPath: string, days = 60): void {
    const then = new Date(Date.now() - days * 86_400_000);
    utimesSync(join(dir, relPath), then, then);
  }

  it('defaults to dry_run and reports candidates with bytes', async () => {
    seedAttachment(dir, store, 'Attachments/a.m4a', { content: 'aaaa' });
    seedAttachment(dir, store, 'Attachments/b.m4a', { content: 'bbbbbbbb' });
    age('Attachments/a.m4a');
    age('Attachments/b.m4a');
    const r = await archiveSource(deps, { sweep: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dry_run).toBe(true);
      expect(r.data.matched).toBe(2);
      expect((r.data.would_archive as unknown[]).length).toBe(2);
      expect(r.data.would_reclaim_bytes).toBe(12);
    }
    expect(existsSync(join(dir, 'Attachments/a.m4a'))).toBe(true);
  });

  it('dry_run reports a per-item error when materialization would repoint a missing note', async () => {
    seedAttachment(dir, store, 'Attachments/a.m4a', { embedRef: 'a.m4a' });
    age('Attachments/a.m4a');
    const body = '![[a.m4a]]';
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('missing-sweep-ref', 'missing-sweep-ref.md', 'missing-sweep-ref', body, 'stale');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('missing-sweep-ref', 'a.m4a', 'wiki-link', 'ctx');

    const result = await archiveSource(deps, { sweep: {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.matched).toBe(1);
      expect(result.data.would_archive).toEqual([]);
      expect(result.data.would_reclaim_bytes).toBe(0);
      expect(result.data.errors).toEqual([{
        vault_path: 'Attachments/a.m4a',
        error: expect.stringContaining('changed on disk'),
      }]);
    }
    expect(existsSync(join(dir, 'Attachments/a.m4a'))).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/a.m4a'))).toBe(false);
    expect(existsSync(join(dir, 'Transcripts/a.md'))).toBe(false);
    expect(store.getByRef('a.m4a')?.source_deleted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM undo_operations').get()).toEqual({ c: 0 });
    expect(new ArchiveLogStore(db).totals().sources).toBe(0);
  });

  it('skips too-recent files and ineligible files with reasons', async () => {
    seedAttachment(dir, store, 'Attachments/old.m4a');
    age('Attachments/old.m4a');
    seedAttachment(dir, store, 'Attachments/fresh.m4a'); // mtime = now
    seedAttachment(dir, store, 'Attachments/stale.m4a', { hash: 'wrong' });
    age('Attachments/stale.m4a');
    const r = await archiveSource(deps, { sweep: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const skipped = r.data.skipped as Array<{ vault_path: string; reason: string }>;
      expect(skipped.find(s => s.vault_path === 'Attachments/fresh.m4a')?.reason).toBe('too_recent');
      expect(skipped.find(s => s.vault_path === 'Attachments/stale.m4a')?.reason).toBe('hash_mismatch');
      expect((r.data.would_archive as Array<{ vault_path: string }>).map(w => w.vault_path)).toEqual(['Attachments/old.m4a']);
    }
  });

  it('treats min_age_days: 0 as disabled instead of rejecting a future mtime as too_recent', async () => {
    const relPath = 'Attachments/future.m4a';
    seedAttachment(dir, store, relPath, {
      embedRef: 'future.m4a',
      text: 'future timestamp transcript',
      content: 'future timestamp audio bytes',
    });
    const slightlyFuture = new Date(Date.now() + 5_000);
    utimesSync(join(dir, relPath), slightlyFuture, slightlyFuture);

    const r = await archiveSource(deps, {
      sweep: { min_age_days: 0 },
      dry_run: false,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.skipped).toEqual([]);
      expect(r.data.archived).toEqual([
        expect.objectContaining({
          vault_path: relPath,
          materialized_node_id: expect.any(String),
        }),
      ]);
    }
    expect(existsSync(join(dir, relPath))).toBe(false);
    expect(existsSync(join(dir, ARCHIVE_DIR, relPath))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE file_path LIKE 'Transcripts/%'").get())
      .toEqual({ count: 1 });
  });

  it('filters by media_types and dir_prefix (segment-aware)', async () => {
    seedAttachment(dir, store, 'Attachments/a.m4a');
    age('Attachments/a.m4a');
    mkdirSync(join(dir, 'AttachmentsOld'), { recursive: true });
    seedAttachment(dir, store, 'AttachmentsOld/b.m4a');
    age('AttachmentsOld/b.m4a');
    writeFileSync(join(dir, 'Attachments/doc.pdf'), 'pdfbytes');
    store.capture({ embedRef: 'doc.pdf', vaultPath: 'Attachments/doc.pdf', contentHash: sha256('pdfbytes'), extractedText: 't', mediaType: 'pdf', extractorId: 'unpdf' });
    age('Attachments/doc.pdf');

    const r = await archiveSource(deps, { sweep: { media_types: ['audio'], dir_prefix: 'Attachments' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const paths = (r.data.would_archive as Array<{ vault_path: string }>).map(w => w.vault_path);
      expect(paths).toEqual(['Attachments/a.m4a']); // pdf filtered by media type, AttachmentsOld by segment prefix
    }
  });

  it('caps at limit with a RESULT_TRUNCATED warning', async () => {
    for (const n of ['a', 'b', 'c']) {
      seedAttachment(dir, store, `Attachments/${n}.m4a`);
      age(`Attachments/${n}.m4a`);
    }
    const r = await archiveSource(deps, { sweep: { limit: 2 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.matched).toBe(2);
      expect((r.warnings ?? []).map(w => w.code)).toContain('RESULT_TRUNCATED');
    }
  });

  it('executes best-effort: one bad item does not stop the run', async () => {
    seedAttachment(dir, store, 'Attachments/good.m4a', { content: 'good-bytes' });
    age('Attachments/good.m4a');
    seedAttachment(dir, store, 'Attachments/bad.m4a', { hash: 'wrong' });
    age('Attachments/bad.m4a');
    const r = await archiveSource(deps, { sweep: {}, dry_run: false, materialize: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data.archived as unknown[]).length).toBe(1);
      expect((r.data.skipped as Array<{ vault_path: string }>).map(s => s.vault_path)).toContain('Attachments/bad.m4a');
      expect(r.data.bytes_reclaimed).toBe(Buffer.byteLength('good-bytes'));
    }
    expect(existsSync(join(dir, ARCHIVE_DIR, 'Attachments/good.m4a'))).toBe(true);
    expect(existsSync(join(dir, 'Attachments/bad.m4a'))).toBe(true);
    const ops = db.prepare('SELECT source_tool FROM undo_operations').all() as Array<{ source_tool: string }>;
    expect(ops).toEqual([{ source_tool: 'archive-source' }]);
  });

  it('rejects unknown media types against the registry when provided', async () => {
    const fakeRegistry = {
      getStatus: () => ({
        active: [{ id: 'deepgram', mediaType: 'audio', extensions: ['.m4a'] }],
        unavailable: [],
        disabled: [],
      }),
    } as unknown as import('../../src/extraction/registry.js').ExtractorRegistry;
    const r = await archiveSource({ ...deps, extractorRegistry: fakeRegistry }, { sweep: { media_types: ['audoi'] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_PARAMS');
  });

  it('executes a multi-item sweep with materialize on under one operation', async () => {
    for (const n of ['x', 'y']) {
      const relPath = `Attachments/${n}.m4a`;
      seedAttachment(dir, store, relPath, { embedRef: `${n}.m4a`, text: `transcript ${n}` });
      age(relPath);
      const body = `![[${n}.m4a]]`;
      writeFileSync(join(dir, `note-${n}.md`), `---\n---\n${body}`);
      db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
        .run(`note-${n}`, `note-${n}.md`, `note-${n}`, body, 'h');
      db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
        .run(`note-${n}`, `${n}.m4a`, 'wiki-link', 'ctx');
    }
    const r = await archiveSource(deps, { sweep: {}, dry_run: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data.archived as unknown[]).length).toBe(2);
      expect((r.data.errors as unknown[]).length).toBe(0);
    }
    // both materialized into real transcript nodes, embeds repointed
    expect(db.prepare("SELECT COUNT(*) c FROM nodes WHERE file_path LIKE 'Transcripts/%'").get()).toEqual({ c: 2 });
    for (const n of ['x', 'y']) {
      const noteBody = (db.prepare(`SELECT body FROM nodes WHERE id = 'note-${n}'`).get() as { body: string }).body;
      expect(noteBody).toContain(`![[${n}]]`);
      expect(existsSync(join(dir, ARCHIVE_DIR, `Attachments/${n}.m4a`))).toBe(true);
    }
    // ONE undo operation for the whole sweep
    const ops = db.prepare('SELECT source_tool FROM undo_operations').all() as Array<{ source_tool: string }>;
    expect(ops).toEqual([{ source_tool: 'archive-source' }]);
  });
});

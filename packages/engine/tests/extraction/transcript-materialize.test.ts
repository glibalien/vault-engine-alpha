import { describe, it, expect, beforeEach, onTestFinished } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForAttachmentTranscripts, upgradeForMaterializedTranscripts, addUndoTables, addSchemaUndoSnapshots, addUiHints } from '../../src/db/migrate.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { repointEmbedRefs } from '../../src/mcp/tools/repoint-embeds.js';
import { createOperation } from '../../src/undo/operation.js';
import { getSchemaDefinition, createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { ensureTranscriptSchema, materializeTranscript, TRANSCRIPTS_OFF_MESSAGE } from '../../src/mcp/tools/materialize-transcript.js';
import { setStoredSettings } from '../../src/settings/store.js';

describe('upgradeForMaterializedTranscripts', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
  });

  it('adds materialized_node_id and materialized_at columns', () => {
    upgradeForMaterializedTranscripts(db);
    const cols = (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['materialized_node_id', 'materialized_at']));
  });

  it('is idempotent', () => {
    upgradeForMaterializedTranscripts(db);
    expect(() => upgradeForMaterializedTranscripts(db)).not.toThrow();
  });
});

describe('TranscriptStore.markMaterialized', () => {
  let db: Database.Database;
  let store: TranscriptStore;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    store = new TranscriptStore(db);
  });

  const sample = {
    embedRef: 'Attachments/rec.mp3',
    vaultPath: 'Attachments/rec.mp3',
    contentHash: 'hash-1',
    extractedText: 'hello transcript',
    mediaType: 'audio',
    extractorId: 'deepgram',
  };

  it('links a row to a node and stamps materialized_at', () => {
    store.capture(sample);
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBeNull();
    const changed = store.markMaterialized('Attachments/rec.mp3', 'node-123');
    expect(changed).toBe(1);
    const row = store.getByRef('Attachments/rec.mp3');
    expect(row?.materialized_node_id).toBe('node-123');
    expect(row?.materialized_at).toBeTruthy();
  });

  it('is a no-op for an unknown ref', () => {
    store.capture(sample);
    expect(store.markMaterialized('Attachments/other.mp3', 'n')).toBe(0);
  });

  it('re-capture preserves the materialization link', () => {
    store.capture(sample);
    store.markMaterialized('Attachments/rec.mp3', 'node-123');
    store.capture({ ...sample, extractedText: 'new text', contentHash: 'h2' });
    // A fresh extraction should NOT silently drop the materialization link.
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBe('node-123');
  });
});

describe('repointEmbedRefs', () => {
  let db: Database.Database;
  let dir: string;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    dir = mkdtempSync(join(tmpdir(), 've-repoint-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  });

  it('rewrites an embed of a deleted file to embed the new node, preserving the !', () => {
    // Referencing note with an embed of the (now materialized) attachment.
    const body = 'Intro\n\n![[Attachments/rec.mp3]]\n\nOutro';
    writeFileSync(join(dir, 'note.md'), `# note\n\n${body}`);
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('ref1', 'note.md', 'note', body, 'stale-hash');
    // The embed is indexed as a relationship (target = the ref string).
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('ref1', 'Attachments/rec.mp3', 'wiki-link', 'ctx');

    const { updated, changedNodeIds } = repointEmbedRefs(
      db, new WriteLockManager(), dir,
      ['Attachments/rec.mp3', 'Attachments/rec.mp3'], // ref + path (deduped inside)
      'rec', 'newnode',
    );

    expect(updated).toBe(1);
    expect(changedNodeIds).toEqual(['ref1']);
    const after = db.prepare('SELECT body FROM nodes WHERE id = ?').get('ref1') as { body: string };
    expect(after.body).toContain('![[rec]]');
    expect(after.body).not.toContain('rec.mp3');
  });

  it('returns 0 and writes nothing when no node references the refs', () => {
    const { updated, changedNodeIds } = repointEmbedRefs(db, new WriteLockManager(), dir, ['Attachments/none.mp3'], 'x', 'newnode');
    expect(updated).toBe(0);
    expect(changedNodeIds).toEqual([]);
  });
});

describe('ensureTranscriptSchema', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    addUndoTables(db);
    addSchemaUndoSnapshots(db);
  });

  it('creates a thin transcript schema with default_directory and no claims', () => {
    const op = createOperation(db, { source_tool: 'materialize-transcript', description: 'x' });
    const res = ensureTranscriptSchema(db, op, { type: 'transcript', dir: 'Transcripts' });
    expect(res.created).toBe(true);
    const def = getSchemaDefinition(db, 'transcript');
    expect(def?.default_directory).toBe('Transcripts');
    expect(def?.display_name).toBe('Transcript');
    const claims = db.prepare('SELECT COUNT(*) c FROM schema_field_claims WHERE schema_name = ?').get('transcript') as { c: number };
    expect(claims.c).toBe(0);
    expect((db.prepare('SELECT schema_count FROM undo_operations WHERE operation_id = ?').get(op) as { schema_count: number }).schema_count).toBe(1);
  });

  it('is a no-op when the schema already exists', () => {
    const op1 = createOperation(db, { source_tool: 'materialize-transcript', description: 'x' });
    ensureTranscriptSchema(db, op1, { type: 'transcript', dir: 'Transcripts' });
    const op2 = createOperation(db, { source_tool: 'materialize-transcript', description: 'y' });
    expect(ensureTranscriptSchema(db, op2, { type: 'transcript', dir: 'Transcripts' }).created).toBe(false);
    expect((db.prepare('SELECT schema_count FROM undo_operations WHERE operation_id = ?').get(op2) as { schema_count: number }).schema_count).toBe(0);
  });
});

function makeStore(db: Database.Database) { return new TranscriptStore(db); }

describe('materializeTranscript (core)', () => {
  let db: Database.Database;
  let dir: string;
  let store: TranscriptStore;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    addUndoTables(db);
    addSchemaUndoSnapshots(db);
    addUiHints(db);
    dir = mkdtempSync(join(tmpdir(), 've-mat-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    store = makeStore(db);
    store.capture({
      embedRef: 'Attachments/rec.mp3', vaultPath: 'Attachments/rec.mp3', contentHash: 'h1',
      extractedText: '[Speaker 1] 0:00\nquarterly budget review', mediaType: 'audio', extractorId: 'deepgram',
    });
    store.markDeleted('Attachments/rec.mp3');
  });

  const deps = () => ({ db, writeLock: new WriteLockManager(), vaultPath: dir, transcriptStore: store });

  it('errors on NOT_FOUND', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/missing.mp3' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('NOT_FOUND');
  });

  it('errors when neither/both of embed_ref/vault_path given', () => {
    expect((materializeTranscript(deps(), {}) as { code: string }).code).toBe('INVALID_PARAMS');
    expect((materializeTranscript(deps(), { embed_ref: 'a', vault_path: 'b' }) as { code: string }).code).toBe('INVALID_PARAMS');
  });

  it('dry_run previews without writing', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', dry_run: true });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.dry_run).toBe(true);
      expect((out.data.would_create as { file_path: string }).file_path).toBe('Transcripts/rec.md');
      expect((out.data.would_create as { would_ensure_schema: boolean }).would_ensure_schema).toBe(true);
    }
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
    expect(getSchemaDefinition(db, 'transcript')).toBeNull();
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBeNull();
  });

  it('dry_run returns retryable missing-file state for a note the repoint would mutate', () => {
    const body = 'Notes\n\n![[Attachments/rec.mp3]]';
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('missing-preview-ref', 'missing-preview-ref.md', 'missing-preview-ref', body, 'stale');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('missing-preview-ref', 'Attachments/rec.mp3', 'wiki-link', 'ctx');
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get('missing-preview-ref');
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();

    const disabled = materializeTranscript(deps(), {
      embed_ref: 'Attachments/rec.mp3',
      repoint: false,
      dry_run: true,
    });
    const out = materializeTranscript(deps(), {
      embed_ref: 'Attachments/rec.mp3',
      dry_run: true,
    });

    expect(disabled.ok).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('CONTENT_HASH_MISMATCH');
      expect(out.details?.current_content_hash).toBeNull();
    }
    expect(existsSync(join(dir, 'missing-preview-ref.md'))).toBe(false);
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBeNull();
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get('missing-preview-ref')).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('dry_run ignores a stale relationship when the repoint would not change the body', () => {
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('stale-preview-ref', 'stale-preview-ref.md', 'stale-preview-ref', 'No attachment link remains.', 'stale');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('stale-preview-ref', 'Attachments/rec.mp3', 'wiki-link', 'ctx');

    const out = materializeTranscript(deps(), {
      embed_ref: 'Attachments/rec.mp3',
      dry_run: true,
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data.would_create as { repoint_targets: number }).repoint_targets).toBe(0);
    }
    expect(existsSync(join(dir, 'stale-preview-ref.md'))).toBe(false);
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
  });

  it('dry_run preserves the create-path conflict before repoint preflight', () => {
    const body = '![[Attachments/rec.mp3]]';
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('missing-conflict-ref', 'missing-conflict-ref.md', 'missing-conflict-ref', body, 'stale');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('missing-conflict-ref', 'Attachments/rec.mp3', 'wiki-link', 'ctx');
    mkdirSync(join(dir, 'Transcripts'), { recursive: true });
    writeFileSync(join(dir, 'Transcripts/rec.md'), 'existing transcript note');

    const out = materializeTranscript(deps(), {
      embed_ref: 'Attachments/rec.mp3',
      dry_run: true,
    });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('INVALID_PARAMS');
    expect(readFileSync(join(dir, 'Transcripts/rec.md'), 'utf8')).toBe('existing transcript note');
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM undo_operations').get()).toEqual({ c: 0 });
  });

  it('materializes a node with orphan provenance + body, marks the store row', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    expect(out.ok).toBe(true);
    const nodeId = out.ok ? (out.data.node_id as string) : '';
    const node = db.prepare('SELECT file_path, body FROM nodes WHERE id = ?').get(nodeId) as { file_path: string; body: string };
    expect(node.file_path).toBe('Transcripts/rec.md');
    expect(node.body).toContain('quarterly budget review');
    const types = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(nodeId) as { schema_type: string }[];
    expect(types.map(t => t.schema_type)).toEqual(['transcript']);
    const fields = Object.fromEntries(
      (db.prepare('SELECT field_name, value_text, value_number, value_json FROM node_fields WHERE node_id = ?').all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_json: string | null }>)
        .map(r => [r.field_name, r.value_text ?? r.value_json ?? r.value_number]),
    );
    expect(fields.source).toBe('Attachments/rec.mp3');
    expect(fields.content_hash).toBe('h1');
    expect(fields.media_type).toBe('audio');
    const onDisk = readFileSync(join(dir, 'Transcripts/rec.md'), 'utf-8');
    expect(onDisk).toContain('types:');
    expect(onDisk).toContain('source: Attachments/rec.mp3');
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBe(nodeId);
    expect(getSchemaDefinition(db, 'transcript')?.default_directory).toBe('Transcripts');
  });

  it('makes the note in the vault map\'s transcript kind and folder', () => {
    setStoredSettings(db, 'vault', { transcriptType: 'recording', transcriptDir: 'Audio/Text' });
    const preview = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', dry_run: true });
    expect(preview.ok && preview.data.would_create).toMatchObject({ file_path: 'Audio/Text/rec.md', types: ['recording'] });

    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    expect(out.ok).toBe(true);
    const nodeId = out.ok ? (out.data.node_id as string) : '';
    expect(out.ok && out.data.types).toEqual(['recording']);
    expect(db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(nodeId)).toEqual({ file_path: 'Audio/Text/rec.md' });
    expect(db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(nodeId)).toEqual([{ schema_type: 'recording' }]);
    expect(getSchemaDefinition(db, 'recording')).toMatchObject({ display_name: 'Recording', default_directory: 'Audio/Text' });
    expect(getSchemaDefinition(db, 'transcript')).toBeNull();
  });

  it('refuses when the transcript kind is none, writing nothing', () => {
    setStoredSettings(db, 'vault', { transcriptType: null });
    for (const dry_run of [true, false]) {
      const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', dry_run });
      expect(out).toEqual({ ok: false, code: 'INVALID_PARAMS', message: TRANSCRIPTS_OFF_MESSAGE });
    }
    expect(existsSync(join(dir, 'Transcripts'))).toBe(false);
    expect(getSchemaDefinition(db, 'transcript')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM undo_operations').get()).toEqual({ c: 0 });
    expect(store.getByRef('Attachments/rec.mp3')?.materialized_node_id).toBeNull();
  });

  it('refuses a transcript kind with a path part or a reserved name, so no schema file is written outside .schemas/ or over Engine\'s own', () => {
    for (const transcriptType of ['../../outside', 'a/b', 'a\\b', '..', '_fields']) {
      setStoredSettings(db, 'vault', { transcriptType });
      const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out).toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining(`transcriptType "${transcriptType}"`) });
    }
    expect(db.prepare('SELECT COUNT(*) c FROM schemas').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM undo_operations').get()).toEqual({ c: 0 });
  });

  it('refuses a second materialize while the node exists', () => {
    const first = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    expect(first.ok).toBe(true);
    const second = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('ALREADY_MATERIALIZED');
      expect(second.details?.node_id).toBeTruthy();
    }
  });

  it('re-materializes when the linked node no longer exists (dangling link)', () => {
    const first = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    const nodeId = first.ok ? (first.data.node_id as string) : '';
    db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
    const again = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', title: 'rec-again' });
    expect(again.ok).toBe(true);
  });

  it('repoints a referencing note\'s embed to the new node by default', () => {
    const body = 'Notes\n\n![[Attachments/rec.mp3]]';
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('note9', 'note9.md', 'note9', body, 'stale');
    writeFileSync(join(dir, 'note9.md'), body);
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('note9', 'Attachments/rec.mp3', 'wiki-link', 'ctx');

    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.references_repointed).toBe(1);
    const after = db.prepare('SELECT body FROM nodes WHERE id = ?').get('note9') as { body: string };
    expect(after.body).toContain('![[rec]]');
    expect(after.body).not.toContain('rec.mp3');
  });

  it('returns retryable missing-file state without materialization or undo side effects', () => {
    const body = 'Notes\n\n![[Attachments/rec.mp3]]';
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('missing-ref', 'missing-ref.md', 'missing-ref', body, 'stale');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('missing-ref', 'Attachments/rec.mp3', 'wiki-link', 'ctx');
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get('missing-ref');
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();

    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('CONTENT_HASH_MISMATCH');
      expect(out.details?.current_content_hash).toBeNull();
    }
    expect(existsSync(join(dir, 'missing-ref.md'))).toBe(false);
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get('missing-ref')).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('repoint:false leaves referencing notes untouched', () => {
    const body = 'Notes\n\n![[Attachments/rec.mp3]]';
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('note10', 'note10.md', 'note10', body, 'stale');
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('note10', 'Attachments/rec.mp3', 'wiki-link', 'ctx');

    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', repoint: false });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.references_repointed).toBe(0);
    const after = db.prepare('SELECT body FROM nodes WHERE id = ?').get('note10') as { body: string };
    expect(after.body).toContain('![[Attachments/rec.mp3]]');
  });

  it('warns TITLE_WIKILINK_UNSAFE for an unsafe title override', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', title: 'a[b' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.warnings ?? []).map(w => w.code)).toContain('TITLE_WIKILINK_UNSAFE');
    }
  });

  it('warns BOTH wikilink-unsafe and filename-sanitized for a piped title override', () => {
    // A pipe is filename-reserved (sanitized to '-') AND the wiki-link alias
    // delimiter. repointEmbedRefs rewrites refs from the raw title, so a piped
    // title yields [[a|b]] refs that parse as target "a" + alias "b" and stop
    // resolving to this node. The wikilink warning is the caller's only signal.
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', title: 'a|b' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const codes = (out.warnings ?? []).map(w => w.code);
      expect(codes).toContain('TITLE_WIKILINK_UNSAFE');
      expect(codes).toContain('TITLE_FILENAME_SANITIZED');
    }
  });

  it('warns TITLE_FILENAME_SANITIZED and writes the sanitized filename', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', title: 'a/b' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data.file_path as string)).toBe('Transcripts/a-b.md');
      expect((out.warnings ?? []).map(w => w.code)).toContain('TITLE_FILENAME_SANITIZED');
    }
    expect(existsSync(join(dir, 'Transcripts/a-b.md'))).toBe(true);
  });

  it('emits no warnings for a clean derived title', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.warnings ?? []).toHaveLength(0);
  });

  it('carries title warnings on a dry_run and writes nothing', () => {
    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3', title: 'a[b', dry_run: true });
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.warnings ?? []).map(w => w.code)).toContain('TITLE_WIKILINK_UNSAFE');
    expect(existsSync(join(dir, 'Transcripts/a[b.md'))).toBe(false);
  });

  it('returns VALIDATION_FAILED naming the note when a repointed note fails re-validation', () => {
    // A 'task' type with a globally-required field and no default.
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // A task note that embeds the attachment but is MISSING the required field.
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run('bad1', 'BrokenTask.md', 'BrokenTask', '![[Attachments/rec.mp3]]', 'h');
    writeFileSync(join(dir, 'BrokenTask.md'), '![[Attachments/rec.mp3]]');
    db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)')
      .run('bad1', 'task', 0);
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context) VALUES (?, ?, ?, ?)')
      .run('bad1', 'Attachments/rec.mp3', 'wiki-link', 'ctx');

    const out = materializeTranscript(deps(), { embed_ref: 'Attachments/rec.mp3' });

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('VALIDATION_FAILED');
      expect(out.details?.node_file_path).toBe('BrokenTask.md');
      expect((out.details?.issues as Array<{ code: string }>).some(i => i.code === 'REQUIRED_MISSING')).toBe(true);
    }
    // Rollback intact: no transcript node, no file on disk.
    expect(db.prepare('SELECT 1 FROM nodes WHERE file_path = ?').get('Transcripts/rec.md')).toBeUndefined();
    expect(existsSync(join(dir, 'Transcripts/rec.md'))).toBe(false);
  });
});

describe('materializeTranscript with runCtx (composition)', () => {
  let db: Database.Database;
  let dir: string;
  let store: TranscriptStore;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    addUndoTables(db);
    addSchemaUndoSnapshots(db);
    addUiHints(db);
    dir = mkdtempSync(join(tmpdir(), 've-mat-ctx-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    store = new TranscriptStore(db);
    writeLock = new WriteLockManager();
    store.capture({
      embedRef: 'Attachments/rec.m4a',
      vaultPath: 'Attachments/rec.m4a',
      contentHash: 'h1',
      extractedText: 'transcript body',
      mediaType: 'audio',
      extractorId: 'deepgram',
    });
  });

  it('uses the caller operation_id and does not create or finalize its own', () => {
    const operation_id = createOperation(db, { source_tool: 'archive-source', description: 'test' });
    const fsUndos: Array<() => void> = [];
    const outcome = materializeTranscript(
      { db, writeLock, vaultPath: dir, transcriptStore: store },
      { embed_ref: 'Attachments/rec.m4a' },
      { operation_id, fsRollback: { push: (u) => fsUndos.push(u) } },
    );
    expect(outcome.ok).toBe(true);
    const ops = db.prepare('SELECT operation_id, source_tool FROM undo_operations').all() as Array<{ operation_id: string; source_tool: string }>;
    expect(ops).toHaveLength(1);
    expect(ops[0].operation_id).toBe(operation_id);
    // file undos were pushed to the CALLER's queue
    expect(fsUndos.length).toBeGreaterThan(0);
  });

  it('defers schema-file rendering to the caller when runCtx is provided', () => {
    const operation_id = createOperation(db, { source_tool: 'archive-source', description: 'test' });
    const outcome = materializeTranscript(
      { db, writeLock, vaultPath: dir, transcriptStore: store },
      { embed_ref: 'Attachments/rec.m4a' },
      { operation_id, fsRollback: { push: () => {} } },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.schema_created).toBe(true);
    // schema YAML file must NOT have been rendered (caller renders post-commit)
    // renderSchemaFile writes to .schemas/ (not Schemas/)
    expect(existsSync(join(dir, '.schemas'))).toBe(false);
  });

  it('rethrows errors instead of enveloping them when runCtx is provided', () => {
    const operation_id = createOperation(db, { source_tool: 'archive-source', description: 'test' });
    const failingStore = Object.create(store) as TranscriptStore;
    failingStore.markMaterialized = () => { throw new Error('injected markMaterialized failure'); };
    expect(() =>
      materializeTranscript(
        { db, writeLock, vaultPath: dir, transcriptStore: failingStore },
        { embed_ref: 'Attachments/rec.m4a' },
        { operation_id, fsRollback: { push: () => {} } },
      ),
    ).toThrow('injected markMaterialized failure');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';

describe('upgradeForAttachmentTranscripts', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('creates the attachment_transcripts table with expected columns', () => {
    upgradeForAttachmentTranscripts(db);
    const cols = (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'embed_ref', 'vault_path', 'content_hash', 'extracted_text',
        'media_type', 'extractor_id', 'source_deleted', 'captured_at', 'deleted_at',
      ]),
    );
  });

  it('creates the vault_path and source_deleted indexes', () => {
    upgradeForAttachmentTranscripts(db);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attachment_transcripts'").all() as { name: string }[])
      .map(r => r.name);
    expect(idx).toContain('idx_attachment_transcripts_vault_path');
    expect(idx).toContain('idx_attachment_transcripts_source_deleted');
  });

  it('is idempotent', () => {
    upgradeForAttachmentTranscripts(db);
    expect(() => upgradeForAttachmentTranscripts(db)).not.toThrow();
  });

  it('includes the metadata_json column', () => {
    upgradeForAttachmentTranscripts(db);
    const cols = (db.prepare('PRAGMA table_info(attachment_transcripts)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('metadata_json');
  });

  it('backfills metadata_json from extraction_cache by content_hash', () => {
    upgradeForAttachmentTranscripts(db);
    const meta = '{"segments":[{"speaker":0,"start":0,"end":1,"text":"hi"}]}';
    db.prepare(`
      INSERT INTO extraction_cache
        (content_hash, file_path, media_type, extractor_id, extracted_text, metadata_json, extracted_at)
      VALUES ('h1', 'x', 'audio', 'deepgram-nova-3', 't', ?, 'now')
    `).run(meta);
    db.prepare(`
      INSERT INTO attachment_transcripts
        (embed_ref, vault_path, content_hash, extracted_text, media_type, extractor_id,
         source_deleted, captured_at, deleted_at, metadata_json)
      VALUES ('ref', 'x', 'h1', 't', 'audio', 'deepgram-nova-3', 0, 'now', NULL, NULL)
    `).run();

    upgradeForAttachmentTranscripts(db);

    const row = db.prepare('SELECT metadata_json FROM attachment_transcripts WHERE embed_ref = ?')
      .get('ref') as { metadata_json: string | null };
    expect(row.metadata_json).toBe(meta);
  });

  it('backfill is idempotent and does not overwrite existing metadata', () => {
    upgradeForAttachmentTranscripts(db);
    db.prepare(`
      INSERT INTO extraction_cache
        (content_hash, file_path, media_type, extractor_id, extracted_text, metadata_json, extracted_at)
      VALUES ('h2', 'y', 'audio', 'deepgram-nova-3', 't', '{"from":"cache"}', 'now')
    `).run();
    db.prepare(`
      INSERT INTO attachment_transcripts
        (embed_ref, vault_path, content_hash, extracted_text, media_type, extractor_id,
         source_deleted, captured_at, deleted_at, metadata_json)
      VALUES ('ref2', 'y', 'h2', 't', 'audio', 'deepgram-nova-3', 0, 'now', NULL, '{"from":"row"}')
    `).run();

    upgradeForAttachmentTranscripts(db);
    upgradeForAttachmentTranscripts(db);

    const row = db.prepare('SELECT metadata_json FROM attachment_transcripts WHERE embed_ref = ?')
      .get('ref2') as { metadata_json: string | null };
    expect(row.metadata_json).toBe('{"from":"row"}');
  });
});

describe('TranscriptStore', () => {
  let db: Database.Database;
  let store: TranscriptStore;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    store = new TranscriptStore(db);
  });

  const sample = {
    embedRef: 'Attachments/rec.mp3',
    vaultPath: 'Attachments/rec.mp3',
    contentHash: 'hash-1',
    extractedText: 'hello world transcript',
    mediaType: 'audio',
    extractorId: 'whisper',
  };

  it('captures and reads back by ref', () => {
    store.capture(sample);
    const row = store.getByRef('Attachments/rec.mp3');
    expect(row?.extracted_text).toBe('hello world transcript');
    expect(row?.source_deleted).toBe(0);
    expect(row?.captured_at).toBeTruthy();
  });

  it('reads back by vault path', () => {
    store.capture(sample);
    expect(store.getByPath('Attachments/rec.mp3')?.extractor_id).toBe('whisper');
  });

  it('upserts latest text and clears deletion state', () => {
    store.capture(sample);
    store.markDeleted('Attachments/rec.mp3');
    expect(store.getByRef('Attachments/rec.mp3')?.source_deleted).toBe(1);
    store.capture({ ...sample, extractedText: 'new text', contentHash: 'hash-2' });
    const row = store.getByRef('Attachments/rec.mp3');
    expect(row?.extracted_text).toBe('new text');
    expect(row?.source_deleted).toBe(0);
    expect(row?.deleted_at).toBeNull();
  });

  it('marks deleted by path and sets deleted_at', () => {
    store.capture(sample);
    const affected = store.markDeleted('Attachments/rec.mp3');
    expect(affected).toBe(1);
    const row = store.getByRef('Attachments/rec.mp3');
    expect(row?.source_deleted).toBe(1);
    expect(row?.deleted_at).toBeTruthy();
  });

  it('lists only deleted when filtered', () => {
    store.capture(sample);
    store.capture({ ...sample, embedRef: 'b.pdf', vaultPath: 'b.pdf', contentHash: 'h3' });
    store.markDeleted('Attachments/rec.mp3');
    const deleted = store.list({ sourceDeleted: true });
    expect(deleted.map(r => r.embed_ref)).toEqual(['Attachments/rec.mp3']);
    expect(store.list({}).length).toBe(2);
  });

  it('markDeleted is a no-op for unknown paths', () => {
    store.capture(sample);
    expect(store.markDeleted('Attachments/other.mp3')).toBe(0);
    expect(store.getByRef('Attachments/rec.mp3')?.source_deleted).toBe(0);
  });

  it('list respects limit', () => {
    store.capture({ ...sample, embedRef: 'a', vaultPath: 'a' });
    store.capture({ ...sample, embedRef: 'b', vaultPath: 'b' });
    store.capture({ ...sample, embedRef: 'c', vaultPath: 'c' });
    const limited = store.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('returns null for unknown ref/path', () => {
    expect(store.getByRef('nope')).toBeNull();
    expect(store.getByPath('nope')).toBeNull();
  });

  it('listSourceDeletedPaths returns distinct, non-null, deleted paths only', () => {
    store.capture(sample); // Attachments/rec.mp3
    store.capture({ ...sample, embedRef: 'b.pdf', vaultPath: 'b.pdf', contentHash: 'h3' });
    store.capture({ ...sample, embedRef: 'rec.mp3#2', vaultPath: 'Attachments/rec.mp3', contentHash: 'h4' });
    store.capture({ ...sample, embedRef: 'c.mp3', vaultPath: 'c.mp3', contentHash: 'h6' }); // stays live
    store.markDeleted('Attachments/rec.mp3'); // both rows for that path -> deleted
    store.markDeleted('b.pdf');
    const paths = store.listSourceDeletedPaths().sort();
    expect(paths).toEqual(['Attachments/rec.mp3', 'b.pdf']); // distinct; live 'c.mp3' excluded
    expect(paths).not.toContain('c.mp3');
  });

  it('clearSourceDeleted flips only deleted rows for the path and nulls deleted_at', () => {
    store.capture(sample);
    store.markDeleted('Attachments/rec.mp3');
    expect(store.getByRef('Attachments/rec.mp3')?.source_deleted).toBe(1);
    expect(store.clearSourceDeleted('Attachments/rec.mp3')).toBe(1);
    const row = store.getByRef('Attachments/rec.mp3');
    expect(row?.source_deleted).toBe(0);
    expect(row?.deleted_at).toBeNull();
  });

  it('clearSourceDeleted is a no-op for unknown or already-live paths', () => {
    store.capture(sample); // live
    expect(store.clearSourceDeleted('Attachments/rec.mp3')).toBe(0);
    expect(store.clearSourceDeleted('Attachments/nope.mp3')).toBe(0);
  });

  it('clearSourceDeleted clears all rows sharing a vault path', () => {
    store.capture(sample);
    store.capture({ ...sample, embedRef: 'rec.mp3#alt', contentHash: 'h5' }); // same vaultPath, 2nd ref
    store.markDeleted('Attachments/rec.mp3');
    expect(store.clearSourceDeleted('Attachments/rec.mp3')).toBe(2);
    expect(store.list({ sourceDeleted: true })).toHaveLength(0);
  });

  it('round-trips metadata_json when provided', () => {
    const meta = '{"segments":[{"speaker":1,"start":2,"end":3,"text":"yo"}]}';
    store.capture({ ...sample, metadataJson: meta });
    expect(store.getByRef('Attachments/rec.mp3')?.metadata_json).toBe(meta);
  });

  it('stores metadata_json as NULL when omitted', () => {
    store.capture(sample);
    expect(store.getByRef('Attachments/rec.mp3')?.metadata_json).toBeNull();
  });
});

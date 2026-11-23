import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';

// read-embedded falls back to a retained transcript when the source file is
// gone (filename route → getByRef/getByPath; file_path ENOENT route →
// getByPath). Driving the live MCP server is heavy and flaky, so this pins the
// STORE contract the tool's ok(...) fallback depends on; the wiring + response
// shape are typechecked by `npm run build`.
describe('read-embedded retained-transcript fallback (store contract)', () => {
  let db: Database.Database;
  let store: TranscriptStore;

  const sample = {
    embedRef: 'Attachments/talk.mp3',
    vaultPath: 'Attachments/talk.mp3',
    contentHash: 'sha256-abc',
    extractedText: 'the retained transcript text',
    mediaType: 'audio',
    extractorId: 'whisper',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    upgradeForAttachmentTranscripts(db);
    store = new TranscriptStore(db);
    store.capture(sample);
    store.markDeleted(sample.vaultPath);
  });

  it('getByPath returns the retained row the file_path fallback serves', () => {
    const row = store.getByPath('Attachments/talk.mp3');
    expect(row).not.toBeNull();
    expect(row?.source_deleted).toBe(1);
    // exact fields the tool maps into ok({ ... source_deleted: true })
    expect(row?.extracted_text).toBe('the retained transcript text');
    expect(row?.media_type).toBe('audio');
    expect(row?.extractor_id).toBe('whisper');
    expect(row?.content_hash).toBe('sha256-abc');
  });

  it('getByRef returns the retained row the filename fallback serves', () => {
    const row = store.getByRef('Attachments/talk.mp3');
    expect(row).not.toBeNull();
    expect(row?.source_deleted).toBe(1);
    expect(row?.extracted_text).toBe('the retained transcript text');
    expect(row?.media_type).toBe('audio');
    expect(row?.extractor_id).toBe('whisper');
    expect(row?.content_hash).toBe('sha256-abc');
  });

  it('returns null for an unknown ref/path so the tool still falls through to NOT_FOUND', () => {
    expect(store.getByRef('Attachments/missing.mp3')).toBeNull();
    expect(store.getByPath('Attachments/missing.mp3')).toBeNull();
  });

  it('retains metadata_json so the tool can JSON.parse it back into the response object', () => {
    const segments = { segments: [{ speaker: 0, start: 0, end: 1.5, text: 'hi' }] };
    store.capture({
      embedRef: 'Attachments/diar.mp3',
      vaultPath: 'Attachments/diar.mp3',
      contentHash: 'sha256-diar',
      extractedText: 'diarized transcript',
      mediaType: 'audio',
      extractorId: 'deepgram-nova-3',
      metadataJson: JSON.stringify(segments),
    });
    store.markDeleted('Attachments/diar.mp3');

    const row = store.getByPath('Attachments/diar.mp3');
    expect(row?.source_deleted).toBe(1);
    // mirrors retainedResult: metadata = retained.metadata_json ? JSON.parse(...) : null
    expect(row?.metadata_json ? JSON.parse(row.metadata_json) : null).toEqual(segments);
  });
});

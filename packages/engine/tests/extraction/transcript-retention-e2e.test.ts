import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { assemble } from '../../src/extraction/assembler.js';
import { createEmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { Extractor } from '../../src/extraction/types.js';

// Deterministic fake embedder.
function fakeEmbedder(): Embedder {
  const vec = () => new Float32Array(256).fill(0.01);
  return {
    isReady: () => true,
    embedDocument: async () => [vec()],
    embedQuery: async () => vec(),
  } as unknown as Embedder;
}

let db: Database.Database;
let dir: string;

function seedNode(id: string, filePath: string, body: string) {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)')
    .run(id, filePath, id, body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 've-transcript-'));
  mkdirSync(join(dir, 'Attachments'), { recursive: true });
  db = new Database(':memory:');
  createSchema(db);
  upgradeForAttachmentTranscripts(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('transcript capture + rebuild fallback', () => {
  it('captures a transcript on extraction and re-embeds from it after the file is deleted', async () => {
    const registry = new ExtractorRegistry();
    const extractor: Extractor = {
      id: 'fake-audio',
      mediaType: 'audio',
      supportedExtensions: ['.veaudio'],
      extract: async (fp) => {
        const { readFileSync } = await import('node:fs');
        return { text: readFileSync(fp, 'utf-8') };
      },
    };
    registry.register(extractor);
    const cache = new ExtractionCache(db, registry);
    const store = new TranscriptStore(db);

    const audioRel = 'Attachments/rec.veaudio';
    writeFileSync(join(dir, audioRel), 'the quarterly budget transcript');
    seedNode('note1', 'note1.md', `See ![[${audioRel}]]`);

    const indexer = createEmbeddingIndexer(db, fakeEmbedder(), {
      extractionCache: cache,
      vaultPath: dir,
      transcriptStore: store,
    });

    indexer.enqueue({ node_id: 'note1', source_type: 'node' });
    await indexer.processAll();

    expect(store.getByRef(audioRel)?.extracted_text).toBe('the quarterly budget transcript');
    const before = db
      .prepare("SELECT COUNT(*) c FROM embedding_meta WHERE source_type='extraction'")
      .get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    // Delete the source file and simulate a full rebuild.
    unlinkSync(join(dir, audioRel));
    indexer.clearAll();
    indexer.enqueue({ node_id: 'note1', source_type: 'node' });
    await indexer.processAll();

    const after = db
      .prepare("SELECT COUNT(*) c FROM embedding_meta WHERE source_type='extraction'")
      .get() as { c: number };
    expect(after.c).toBeGreaterThan(0);
  });
});

describe('assembler fallback for deleted source', () => {
  it('renders the retained transcript with sourceDeleted when the file is gone', async () => {
    const registry = new ExtractorRegistry();
    registry.register({
      id: 'fake-audio', mediaType: 'audio', supportedExtensions: ['.veaudio'],
      extract: async (fp) => {
        const { readFileSync } = await import('node:fs');
        return { text: readFileSync(fp, 'utf-8') };
      },
    });
    const cache = new ExtractionCache(db, registry);
    const store = new TranscriptStore(db);
    const audioRel = 'Attachments/talk.veaudio';
    writeFileSync(join(dir, audioRel), 'keynote transcript body');
    seedNode('n2', 'n2.md', `Notes: ![[${audioRel}]]`);

    // Capture via a direct store write (simulating prior extraction).
    store.capture({
      embedRef: audioRel, vaultPath: audioRel, contentHash: 'h',
      extractedText: 'keynote transcript body', mediaType: 'audio', extractorId: 'fake-audio',
    });
    unlinkSync(join(dir, audioRel));

    const result = await assemble(db, 'n2', cache, dir, undefined, store);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].text).toBe('keynote transcript body');
    expect(result.embeds[0].sourceDeleted).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

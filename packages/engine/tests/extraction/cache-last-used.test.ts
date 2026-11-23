import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '../helpers/db.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import type Database from 'better-sqlite3';

// Note: Extractor interface requires supportedExtensions: string[] — included here.
const fakeExtractor = {
  id: 'fake',
  mediaType: 'text',
  supportedExtensions: ['.txt'],
  extract: async () => ({ text: 'hello world', metadata: undefined }),
};

describe('ExtractionCache last_used_at', () => {
  let db: Database.Database;
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'vault-cache-'));
    filePath = join(dir, 'note-audio.txt');
    writeFileSync(filePath, 'stable content');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets last_used_at on insert and refreshes it on every cache hit', async () => {
    const registry = new ExtractorRegistry();
    registry.register(fakeExtractor);
    const cache = new ExtractionCache(db, registry);

    await cache.getExtraction(filePath); // miss → insert
    const inserted = db.prepare('SELECT last_used_at FROM extraction_cache').get() as { last_used_at: string };
    expect(inserted.last_used_at).not.toBeNull();

    // Backdate, then hit — the hit must refresh the timestamp.
    db.prepare("UPDATE extraction_cache SET last_used_at = '2025-01-01T00:00:00.000Z'").run();
    await cache.getExtraction(filePath); // hit
    const touched = db.prepare('SELECT last_used_at FROM extraction_cache').get() as { last_used_at: string };
    expect(Date.parse(touched.last_used_at)).toBeGreaterThan(Date.parse('2026-01-01'));
  });
});

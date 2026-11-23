import { describe, it, expect, beforeEach, vi, onTestFinished } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { ExtractorRegistry } from '../../src/extraction/registry.js';
import { ExtractionCache } from '../../src/extraction/cache.js';
import { ExtractionDisabledError, UnsupportedExtensionError } from '../../src/extraction/types.js';
import type { Extractor, ExtractionResult } from '../../src/extraction/types.js';
import type Database from 'better-sqlite3';

function makeExtractor(
  id: string,
  mediaType: string,
  extensions: string[],
  extractFn?: (filePath: string) => Promise<ExtractionResult>,
): Extractor {
  return {
    id,
    mediaType,
    supportedExtensions: extensions,
    extract: extractFn ?? (async (_filePath: string) => ({ text: `result from ${id}` })),
  };
}

describe('ExtractionCache', () => {
  let db: Database.Database;
  let registry: ExtractorRegistry;
  let cache: ExtractionCache;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    registry = new ExtractorRegistry();
    cache = new ExtractionCache(db, registry);
    tmpDir = mkdtempSync(join(tmpdir(), 'cache-test-'));
    onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
  });

  it('extracts and caches on first call (DB row exists after)', async () => {
    let extractCount = 0;
    const extractor = makeExtractor('test-extractor', 'text', ['.txt'], async (_fp) => {
      extractCount++;
      return { text: 'hello world' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'file contents');

    const result = await cache.getExtraction(filePath);

    expect(result.text).toBe('hello world');
    expect(result.mediaType).toBe('text');
    expect(result.extractorId).toBe('test-extractor');
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extractCount).toBe(1);

    // Verify DB row exists
    const row = db.prepare('SELECT * FROM extraction_cache WHERE content_hash = ?').get(result.contentHash);
    expect(row).not.toBeNull();
  });

  it('returns cached result on second call (extractCount stays at 1)', async () => {
    let extractCount = 0;
    const extractor = makeExtractor('test-extractor', 'text', ['.txt'], async (_fp) => {
      extractCount++;
      return { text: 'cached text' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'same contents');

    const first = await cache.getExtraction(filePath);
    const second = await cache.getExtraction(filePath);

    expect(extractCount).toBe(1);
    expect(first.text).toBe(second.text);
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('coalesces concurrent cache misses for the same content into one extraction', async () => {
    let extractCount = 0;
    let finishExtraction!: (result: ExtractionResult) => void;
    const pendingExtraction = new Promise<ExtractionResult>((resolve) => {
      finishExtraction = resolve;
    });
    const extractor = makeExtractor('slow-extractor', 'text', ['.txt'], async () => {
      extractCount++;
      return pendingExtraction;
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'shared.txt');
    writeFileSync(filePath, 'shared file contents');

    const first = cache.getExtraction(filePath);
    const second = cache.getExtraction(filePath);
    finishExtraction({ text: 'one shared result' });

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(extractCount).toBe(1);
    if (outcomes[0].status === 'fulfilled' && outcomes[1].status === 'fulfilled') {
      expect(outcomes[0].value.text).toBe('one shared result');
      expect(outcomes[1].value.text).toBe('one shared result');
    }
  });

  it('clears a failed in-flight extraction so a later call can retry', async () => {
    let extractCount = 0;
    let failExtraction!: (error: Error) => void;
    const pendingFailure = new Promise<ExtractionResult>((_resolve, reject) => {
      failExtraction = reject;
    });
    const extractor = makeExtractor('flaky-slow-extractor', 'text', ['.txt'], async () => {
      extractCount++;
      if (extractCount === 1) return pendingFailure;
      return { text: 'success after retry' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'flaky-shared.txt');
    writeFileSync(filePath, 'shared file contents');

    const first = cache.getExtraction(filePath);
    const second = cache.getExtraction(filePath);
    failExtraction(new Error('provider stream failed'));

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);

    const retry = await cache.getExtraction(filePath);
    expect(retry.text).toBe('success after retry');
    expect(extractCount).toBe(2);
  });

  it('returns a cached result when its extractor is no longer registered', async () => {
    const extractor = makeExtractor('retired-extractor', 'image', ['.gif'], async () => ({
      text: 'retained GIF text',
    }));
    registry.register(extractor);

    const filePath = join(tmpDir, 'legacy.gif');
    writeFileSync(filePath, 'GIF89a legacy bytes');
    await cache.getExtraction(filePath);

    registry.clear();
    const retained = await cache.getExtraction(filePath);

    expect(retained.text).toBe('retained GIF text');
    expect(retained.extractorId).toBe('retired-extractor');
  });

  it('re-extracts when file content changes (different hash)', async () => {
    let extractCount = 0;
    const extractor = makeExtractor('test-extractor', 'text', ['.txt'], async (_fp) => {
      extractCount++;
      return { text: `extraction ${extractCount}` };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'original content');

    const first = await cache.getExtraction(filePath);
    expect(extractCount).toBe(1);

    writeFileSync(filePath, 'changed content');

    const second = await cache.getExtraction(filePath);
    expect(extractCount).toBe(2);
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('throws EXTRACTOR_UNAVAILABLE for extension with registered unavailable extractor', async () => {
    registry.registerUnavailable('deepgram-nova-3', 'audio', ['.m4a'], 'DEEPGRAM_API_KEY');

    const filePath = join(tmpDir, 'audio.m4a');
    writeFileSync(filePath, 'fake audio');

    await expect(cache.getExtraction(filePath)).rejects.toThrow('EXTRACTOR_UNAVAILABLE:');
    await expect(cache.getExtraction(filePath)).rejects.toThrow('DEEPGRAM_API_KEY');
  });

  it('throws ExtractionDisabledError for a turned-off extractor, but still serves cached text', async () => {
    registry.registerDisabled('gemini-vision-image', 'image', ['.png']);
    const filePath = join(tmpDir, 'photo.png');
    writeFileSync(filePath, 'fake png');

    await expect(cache.getExtraction(filePath)).rejects.toBeInstanceOf(ExtractionDisabledError);
    await expect(cache.getExtraction(filePath)).rejects.toThrow(
      "EXTRACTOR_UNAVAILABLE: Extractor 'gemini-vision-image' is off (engine setting extractionEnabled is false)",
    );

    const cachedPath = join(tmpDir, 'cached.png');
    writeFileSync(cachedPath, 'cached png');
    const hash = createHash('sha256').update('cached png').digest('hex');
    db.prepare(`INSERT INTO extraction_cache (content_hash, file_path, media_type, extractor_id, extracted_text, metadata_json, extracted_at)
      VALUES (?, ?, 'image', 'gemini-vision-image', 'a cat', NULL, ?)`).run(hash, cachedPath, new Date().toISOString());
    expect((await cache.getExtraction(cachedPath)).text).toBe('a cat');
  });

  it('throws UnsupportedExtensionError for completely unknown extension', async () => {
    const filePath = join(tmpDir, 'data.xyz');
    writeFileSync(filePath, 'some data');

    await expect(cache.getExtraction(filePath)).rejects.toThrow('No extractor registered for');
    await expect(cache.getExtraction(filePath)).rejects.toBeInstanceOf(UnsupportedExtensionError);
    await expect(cache.getExtraction(filePath)).rejects.toMatchObject({ ext: '.xyz' });
  });

  it('does not cache failures (first call throws, second call retries and succeeds)', async () => {
    let callCount = 0;
    const extractor = makeExtractor('flaky-extractor', 'text', ['.txt'], async (_fp) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Extraction failed');
      }
      return { text: 'success on retry' };
    });
    registry.register(extractor);

    const filePath = join(tmpDir, 'test.txt');
    writeFileSync(filePath, 'file data');

    await expect(cache.getExtraction(filePath)).rejects.toThrow('Extraction failed');

    // Second call should retry (not use cache)
    const result = await cache.getExtraction(filePath);
    expect(result.text).toBe('success on retry');
    expect(callCount).toBe(2);
  });

  it('logs extractor failures with file and provider context', async () => {
    const providerError = new Error('provider stream failed');
    registry.register(makeExtractor('broken-provider', 'text', ['.txt'], async () => {
      throw providerError;
    }));

    const filePath = join(tmpDir, 'broken.txt');
    writeFileSync(filePath, 'file data');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(cache.getExtraction(filePath)).rejects.toBe(providerError);
      expect(errorLog).toHaveBeenCalledTimes(1);
      const [message, error] = errorLog.mock.calls[0];
      expect(message).toContain('broken.txt');
      expect(message).toContain('broken-provider');
      expect(error).toBe(providerError);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('logs PDF fallback failures with file and fallback-provider context', async () => {
    const fallbackError = new Error('vision provider failed');
    registry.register(makeExtractor('pdf-text', 'document', ['.pdf'], async () => ({
      text: 'scan',
      metadata: { avgCharsPerPage: 10 },
    })));
    cache.setPdfFallback(makeExtractor('broken-vision', 'document', ['.pdf'], async () => {
      throw fallbackError;
    }));

    const filePath = join(tmpDir, 'broken-scan.pdf');
    writeFileSync(filePath, 'fake pdf bytes');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(cache.getExtraction(filePath)).rejects.toBe(fallbackError);
      expect(errorLog).toHaveBeenCalledTimes(1);
      const [message, error] = errorLog.mock.calls[0];
      expect(message).toContain('broken-scan.pdf');
      expect(message).toContain('broken-vision');
      expect(error).toBe(fallbackError);
    } finally {
      errorLog.mockRestore();
    }
  });

  it('stores metadata as JSON and round-trips through DB', async () => {
    const metadata = { duration: 123.45, language: 'en', confidence: 0.97 };
    const extractor = makeExtractor('meta-extractor', 'audio', ['.mp3'], async (_fp) => ({
      text: 'audio content',
      metadata,
    }));
    registry.register(extractor);

    const filePath = join(tmpDir, 'audio.mp3');
    writeFileSync(filePath, 'fake mp3 data');

    // First call — extracts and caches
    const first = await cache.getExtraction(filePath);
    expect(first.metadata).toEqual(metadata);

    // Second call — reads from cache
    const second = await cache.getExtraction(filePath);
    expect(second.metadata).toEqual(metadata);
  });

  it('PDF fallback: uses vision when text extraction yields avgCharsPerPage < 50', async () => {
    let textExtractCount = 0;
    let visionExtractCount = 0;

    const pdfExtractor = makeExtractor('pdf-text', 'document', ['.pdf'], async (_fp) => {
      textExtractCount++;
      return { text: 'scan', metadata: { avgCharsPerPage: 10 } };
    });
    const visionExtractor = makeExtractor('claude-vision', 'document', ['.pdf'], async (_fp) => {
      visionExtractCount++;
      return { text: 'full OCR text from vision', metadata: { avgCharsPerPage: 500 } };
    });

    registry.register(pdfExtractor);
    cache.setPdfFallback(visionExtractor);

    const filePath = join(tmpDir, 'scanned.pdf');
    writeFileSync(filePath, 'fake pdf bytes');

    const result = await cache.getExtraction(filePath);

    expect(result.text).toBe('full OCR text from vision');
    expect(result.extractorId).toBe('claude-vision');
    expect(textExtractCount).toBe(1);
    expect(visionExtractCount).toBe(1);
  });

  it('PDF fallback: uses text result when avgCharsPerPage >= 50', async () => {
    let textExtractCount = 0;
    let visionExtractCount = 0;

    const pdfExtractor = makeExtractor('pdf-text', 'document', ['.pdf'], async (_fp) => {
      textExtractCount++;
      return { text: 'plenty of text content here', metadata: { avgCharsPerPage: 100 } };
    });
    const visionExtractor = makeExtractor('claude-vision', 'document', ['.pdf'], async (_fp) => {
      visionExtractCount++;
      return { text: 'vision fallback', metadata: { avgCharsPerPage: 500 } };
    });

    registry.register(pdfExtractor);
    cache.setPdfFallback(visionExtractor);

    const filePath = join(tmpDir, 'text.pdf');
    writeFileSync(filePath, 'fake pdf bytes');

    const result = await cache.getExtraction(filePath);

    expect(result.text).toBe('plenty of text content here');
    expect(result.extractorId).toBe('pdf-text');
    expect(textExtractCount).toBe(1);
    expect(visionExtractCount).toBe(0);
  });

  it('setPdfFallback(null) clears a previously set fallback', async () => {
    const pdfExtractor = makeExtractor('pdf-text', 'document', ['.pdf'], async (_fp) => ({
      text: 'scan', metadata: { avgCharsPerPage: 10 },
    }));
    const visionExtractor = makeExtractor('claude-vision', 'document', ['.pdf'], async (_fp) => ({
      text: 'vision text', metadata: { avgCharsPerPage: 500 },
    }));

    registry.register(pdfExtractor);
    cache.setPdfFallback(visionExtractor);
    cache.setPdfFallback(null);

    const filePath = join(tmpDir, 'scanned-cleared.pdf');
    writeFileSync(filePath, 'fake pdf bytes');

    const result = await cache.getExtraction(filePath);

    // No fallback set — the sparse text result is returned as-is.
    expect(result.text).toBe('scan');
    expect(result.extractorId).toBe('pdf-text');
  });

  it('reads a sparse PDF cached before a fallback existed again once one does, then serves the fallback result', async () => {
    let textExtractCount = 0;
    let visionExtractCount = 0;
    registry.register(makeExtractor('pdf-text', 'document', ['.pdf'], async () => {
      textExtractCount++;
      return { text: 'scan', metadata: { avgCharsPerPage: 10 } };
    }));
    const filePath = join(tmpDir, 'scanned-before-keys.pdf');
    writeFileSync(filePath, 'fake pdf bytes');

    // Extraction was off: the text layer is all there is, and it is cached.
    expect((await cache.getExtraction(filePath)).text).toBe('scan');

    // Vision keys were added: the cached sparse result is read again, through the fallback.
    cache.setPdfFallback(makeExtractor('gemini-vision-pdf', 'document', ['.pdf'], async () => {
      visionExtractCount++;
      return { text: 'vision text' };
    }));
    const upgraded = await cache.getExtraction(filePath);
    const again = await cache.getExtraction(filePath);

    expect([upgraded.text, upgraded.extractorId]).toEqual(['vision text', 'gemini-vision-pdf']);
    expect(again.text).toBe('vision text');
    expect([textExtractCount, visionExtractCount]).toEqual([2, 1]);
    const rows = db.prepare('SELECT extractor_id, extracted_text FROM extraction_cache').all();
    expect(rows).toEqual([{ extractor_id: 'gemini-vision-pdf', extracted_text: 'vision text' }]);
  });

  it('keeps a cached PDF with a text layer when a fallback is added', async () => {
    let textExtractCount = 0;
    let visionExtractCount = 0;
    registry.register(makeExtractor('pdf-text', 'document', ['.pdf'], async () => {
      textExtractCount++;
      return { text: 'a real text layer', metadata: { avgCharsPerPage: 900 } };
    }));
    const filePath = join(tmpDir, 'text.pdf');
    writeFileSync(filePath, 'fake text pdf bytes');
    await cache.getExtraction(filePath);

    cache.setPdfFallback(makeExtractor('gemini-vision-pdf', 'document', ['.pdf'], async () => {
      visionExtractCount++;
      return { text: 'vision text' };
    }));

    expect((await cache.getExtraction(filePath)).text).toBe('a real text layer');
    expect([textExtractCount, visionExtractCount]).toEqual([1, 0]);
  });
});

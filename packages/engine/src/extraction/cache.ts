import { readFileSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ExtractorRegistry } from './registry.js';
import { ExtractionDisabledError, UnsupportedExtensionError } from './types.js';
import type { Extractor, CachedExtraction, ExtractionResult } from './types.js';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** A PDF whose text layer is this thin is scanned; the PDF fallback reads it instead. */
const SPARSE_PDF_CHARS_PER_PAGE = 50;

function isSparsePdf(metadata: unknown): boolean {
  return typeof metadata === 'object'
    && metadata !== null
    && 'avgCharsPerPage' in metadata
    && typeof (metadata as Record<string, unknown>).avgCharsPerPage === 'number'
    && ((metadata as Record<string, unknown>).avgCharsPerPage as number) < SPARSE_PDF_CHARS_PER_PAGE;
}

interface ExtractionCacheRow {
  content_hash: string;
  file_path: string;
  media_type: string;
  extractor_id: string;
  extracted_text: string;
  metadata_json: string | null;
  extracted_at: string;
}

export class ExtractionCache {
  private pdfFallback: Extractor | null = null;
  private readonly inFlight = new Map<string, Promise<CachedExtraction>>();

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ExtractorRegistry,
  ) {}

  /** `null` clears a previously set fallback (re-arm: the new provider may have no key configured). */
  setPdfFallback(extractor: Extractor | null): void {
    this.pdfFallback = extractor;
  }

  async getExtraction(filePath: string): Promise<CachedExtraction> {
    const ext = extname(filePath).toLowerCase();

    // Hash the file
    const fileBuffer = readFileSync(filePath);
    const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

    // Check cache
    const cached = this.db
      .prepare('SELECT * FROM extraction_cache WHERE content_hash = ?')
      .get(contentHash) as ExtractionCacheRow | undefined;

    const name = basename(filePath);
    const fileSize = formatSize(fileBuffer.length);

    if (cached !== undefined && this.predatesPdfFallback(ext, cached)) {
      console.log(`[extraction] cached sparse PDF ${name} predates the ${this.pdfFallback?.id} fallback → extracting again`);
    } else if (cached !== undefined) {
      console.log(`[extraction] cache hit: ${name} (${cached.extractor_id}, ${formatSize(cached.extracted_text.length)} text)`);
      this.db
        .prepare('UPDATE extraction_cache SET last_used_at = ? WHERE content_hash = ?')
        .run(new Date().toISOString(), contentHash);
      return {
        text: cached.extracted_text,
        metadata: cached.metadata_json !== null ? JSON.parse(cached.metadata_json) : null,
        mediaType: cached.media_type,
        extractorId: cached.extractor_id,
        contentHash: cached.content_hash,
      };
    }

    const inFlight = this.inFlight.get(contentHash);
    if (inFlight !== undefined) {
      console.log(`[extraction] in-flight join: ${name} (${fileSize}, hash ${contentHash.slice(0, 8)}…)`);
      return inFlight;
    }

    const pending = this.extractAndCache(filePath, ext, contentHash, name, fileSize);
    this.inFlight.set(contentHash, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(contentHash) === pending) {
        this.inFlight.delete(contentHash);
      }
    }
  }

  /**
   * A scanned PDF cached from its text layer while no PDF fallback was configured (for
   * example before vision keys were added) is read again once one is. The fallback's
   * result replaces it, so this happens once per file.
   */
  private predatesPdfFallback(ext: string, cached: ExtractionCacheRow): boolean {
    if (ext !== '.pdf' || this.pdfFallback === null) return false;
    if (cached.extractor_id !== this.registry.getForExtension(ext)?.id) return false;
    return isSparsePdf(cached.metadata_json !== null ? JSON.parse(cached.metadata_json) : null);
  }

  private async extractAndCache(
    filePath: string,
    ext: string,
    contentHash: string,
    name: string,
    fileSize: string,
  ): Promise<CachedExtraction> {
    const extractor = this.registry.getForExtension(ext);
    if (extractor === null) {
      const disabledReason = this.registry.getDisabledReason(ext);
      if (disabledReason !== null) throw new ExtractionDisabledError(ext, `EXTRACTOR_UNAVAILABLE: ${disabledReason}`);
      const unavailableReason = this.registry.getUnavailableReason(ext);
      if (unavailableReason !== null) {
        throw new Error(`EXTRACTOR_UNAVAILABLE: ${unavailableReason}`);
      }
      throw new UnsupportedExtensionError(ext, `No extractor registered for ${ext}`);
    }

    // Cache miss — extract
    console.log(`[extraction] cache miss: ${name} (${fileSize}) → extracting with ${extractor.id}`);
    const startTime = Date.now();
    let result = await this.runExtractor(extractor, filePath, name);
    let usedExtractor = extractor;
    const elapsed = Date.now() - startTime;

    // PDF fallback: if avgCharsPerPage < 50 and fallback is set
    if (ext === '.pdf' && this.pdfFallback !== null && isSparsePdf(result.metadata)) {
      console.log(`[extraction] PDF sparse text (${(result.metadata as Record<string, unknown>).avgCharsPerPage} chars/page) → falling back to ${this.pdfFallback.id}`);
      const fallbackStart = Date.now();
      result = await this.runExtractor(this.pdfFallback, filePath, name);
      usedExtractor = this.pdfFallback;
      console.log(`[extraction] PDF fallback complete: ${name} → ${formatSize(result.text.length)} text in ${Date.now() - fallbackStart}ms`);
    }

    console.log(`[extraction] extracted: ${name} via ${usedExtractor.id} → ${formatSize(result.text.length)} text in ${elapsed}ms`);

    // Store in cache
    const metadataJson = result.metadata !== undefined ? JSON.stringify(result.metadata) : null;
    const extractedAt = new Date().toISOString();

    // Replaces a sparse PDF's text-layer entry when the fallback read it again.
    this.db
      .prepare(
        `INSERT INTO extraction_cache
          (content_hash, file_path, media_type, extractor_id, extracted_text, metadata_json, extracted_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           file_path = excluded.file_path,
           media_type = excluded.media_type,
           extractor_id = excluded.extractor_id,
           extracted_text = excluded.extracted_text,
           metadata_json = excluded.metadata_json,
           extracted_at = excluded.extracted_at,
           last_used_at = excluded.last_used_at`,
      )
      .run(contentHash, filePath, usedExtractor.mediaType, usedExtractor.id, result.text, metadataJson, extractedAt, extractedAt);

    console.log(`[extraction] cached: ${name} (hash ${contentHash.slice(0, 8)}…)`);

    return {
      text: result.text,
      metadata: result.metadata ?? null,
      mediaType: usedExtractor.mediaType,
      extractorId: usedExtractor.id,
      contentHash,
    };
  }

  private async runExtractor(
    extractor: Extractor,
    filePath: string,
    name: string,
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    try {
      return await extractor.extract(filePath);
    } catch (err) {
      console.error(`[extraction] failed: ${name} via ${extractor.id} after ${Date.now() - startTime}ms:`, err);
      throw err;
    }
  }
}

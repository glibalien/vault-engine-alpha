/** No extractor claims this file extension. Permanent for the process lifetime —
 *  consumers should skip the file, never retry. */
export class UnsupportedExtensionError extends Error {
  constructor(readonly ext: string, message: string) {
    super(message);
    this.name = 'UnsupportedExtensionError';
  }
}

/** The extractor for this file is turned off by the engine setting extractionEnabled.
 *  Permanent until a restart with extraction on — consumers should skip, never retry. */
export class ExtractionDisabledError extends Error {
  constructor(readonly ext: string, message: string) {
    super(message);
    this.name = 'ExtractionDisabledError';
  }
}

export interface Extractor {
  id: string;                    // e.g. 'deepgram-nova-3'
  mediaType: string;             // e.g. 'audio'
  supportedExtensions: string[]; // e.g. ['.m4a', '.mp3']
  extract(filePath: string): Promise<ExtractionResult>;
}

export interface ExtractionResult {
  text: string;
  metadata?: unknown;
}

export interface CachedExtraction {
  text: string;
  metadata: unknown;
  mediaType: string;
  extractorId: string;
  contentHash: string;
}

export interface EmbedEntry {
  reference: string;
  mediaType: string;
  text: string;
  source?: string;
  sourceDeleted?: boolean;
}

export interface EmbedError {
  reference: string;
  error: string;
}

export interface AssembledNode {
  node: {
    title: string | null;
    types: string[];
    fields: Record<string, unknown>;
  };
  body: string | null;
  embeds: EmbedEntry[];
  errors: EmbedError[];
}

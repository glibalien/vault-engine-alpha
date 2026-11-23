import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { complete, type ProviderClients } from '@vault/llm';
import { PROVIDERS, type ModelProvider } from '@vault/settings-registry';
import { resolveImageMime } from '../image-sniff.js';
import type { Extractor, ExtractionResult } from '../types.js';
import { completionUsageFields, type UsageRecorder } from '../../usage/recorder.js';

/** The model `visionProvider: claude` pins, for images and scanned PDFs. */
export const CLAUDE_VISION_MODEL = 'claude-sonnet-4-6';

const STANDARD_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Fireworks also accepts tiff and bmp ("Supported formats: jpeg, png, gif, tiff,
// bmp" per its own 400 message); OpenRouter has always shared this list.
const WIDE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  ...STANDARD_IMAGE_TYPES,
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
};

/** Image extension → MIME type each provider's vision input accepts. */
const IMAGE_TYPES: Readonly<Record<ModelProvider, Readonly<Record<string, string>>>> = {
  fireworks: WIDE_IMAGE_TYPES,
  openrouter: WIDE_IMAGE_TYPES,
  anthropic: STANDARD_IMAGE_TYPES,
  openai: STANDARD_IMAGE_TYPES,
};

/** Image extensions the provider's vision input accepts. */
export function visionImageExtensions(provider: ModelProvider): string[] {
  return Object.keys(IMAGE_TYPES[provider]);
}

/** Extractor ids follow the provider's wire API, so a provider change within the
 *  same API keeps the id. The extraction cache keys on content hash, never on id. */
export function visionExtractorId(provider: ModelProvider, mediaType: 'image' | 'pdf'): string {
  return `${PROVIDERS[provider].api === 'anthropic' ? 'claude' : 'openai-compat'}-vision-${mediaType}`;
}

const IMAGE_PROMPT =
  'Extract all text from this image. If it contains handwriting, transcribe it. If it contains a diagram or photo, describe what you see. Return only the extracted content, no commentary.';

const PDF_PROMPT =
  'Extract all text from this scanned PDF document. Transcribe any handwriting. Return only the extracted content, no commentary.';

const IMAGE_MAX_TOKENS = 4096;
const PDF_MAX_TOKENS = 8192;

export interface VisionTarget {
  provider: ModelProvider;
  model: string;
}

/** Image text extraction through any catalog provider's vision model. */
export class ModelVisionImageExtractor implements Extractor {
  readonly id: string;
  readonly mediaType = 'image';
  readonly supportedExtensions: string[];
  readonly provider: ModelProvider;
  readonly model: string;
  private readonly types: Readonly<Record<string, string>>;

  constructor(private readonly clients: ProviderClients, target: VisionTarget, private readonly recorder?: UsageRecorder) {
    this.provider = target.provider;
    this.model = target.model;
    this.id = visionExtractorId(target.provider, 'image');
    this.types = IMAGE_TYPES[target.provider];
    this.supportedExtensions = Object.keys(this.types);
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const buffer = await readFile(filePath);
    // Trust the bytes, not the filename — see image-sniff.ts.
    const resolved = resolveImageMime(buffer, ext, Object.values(this.types), this.types);
    if (!resolved.ok) throw new Error(resolved.reason);
    const { mimeType } = resolved;
    if (resolved.sniffedButUnsupported) {
      console.warn(`[extraction:vision] ${filePath} is really ${resolved.sniffedButUnsupported} but named ${ext}; sending as ${mimeType} because the provider does not list its true type`);
    }
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:vision] sending ${sizeMB}MB ${ext} image to ${this.model} (${this.provider})`);
    const text = await callVision(this.clients, this.recorder, this, filePath, [
      { type: 'image', mimeType, data: buffer },
      { type: 'text', text: IMAGE_PROMPT },
    ], IMAGE_MAX_TOKENS);
    console.log(`[extraction:vision] image extraction complete: ${text.length} chars`);
    return { text };
  }
}

/** Scanned-PDF text extraction through a catalog provider that takes PDF input. */
export class ModelVisionPdfExtractor implements Extractor {
  readonly id: string;
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];
  readonly provider: ModelProvider;
  readonly model: string;

  constructor(private readonly clients: ProviderClients, target: VisionTarget, private readonly recorder?: UsageRecorder) {
    if (!PROVIDERS[target.provider].pdfInput) {
      throw new Error(`${PROVIDERS[target.provider].label} takes no PDF input`);
    }
    this.provider = target.provider;
    this.model = target.model;
    this.id = visionExtractorId(target.provider, 'pdf');
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:vision] sending ${sizeMB}MB scanned PDF to ${this.model} (${this.provider})`);
    const text = await callVision(this.clients, this.recorder, this, filePath, [
      { type: 'pdf', data: buffer },
      { type: 'text', text: PDF_PROMPT },
    ], PDF_MAX_TOKENS);
    console.log(`[extraction:vision] scanned PDF extraction complete: ${text.length} chars`);
    return { text };
  }
}

async function callVision(
  clients: ProviderClients,
  recorder: UsageRecorder | undefined,
  target: VisionTarget,
  filePath: string,
  content: Parameters<typeof complete>[1]['content'],
  maxTokens: number,
): Promise<string> {
  const t0 = Date.now();
  const result = await complete(clients, { provider: target.provider, model: target.model, content, maxTokens });
  recorder?.record({
    provider: target.provider,
    model: target.model,
    service: 'engine',
    purpose: 'vision-extraction',
    ...completionUsageFields(result),
    sourceRef: filePath,
    latencyMs: Date.now() - t0,
  });
  return result.text;
}

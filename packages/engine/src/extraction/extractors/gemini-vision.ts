import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolveImageMime } from '../image-sniff.js';
import { GoogleGenAI } from '@google/genai';
import type { Extractor, ExtractionResult } from '../types.js';
import type { UsageRecorder } from '../../usage/recorder.js';

const MODEL = 'gemini-2.5-flash';

export const GEMINI_IMAGE_EXTENSIONS: string[] = ['.png', '.jpg', '.jpeg', '.webp'];

/** What the Gemini API actually accepts as inline image data — ai.google.dev/gemini-api/docs/image-understanding.
 *  Notably NOT avif, which several vault attachments are despite their .jpg names. */
export const GEMINI_SUPPORTED_MIME: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_PROMPT =
  'Extract all text from this image. If it contains handwriting, transcribe it. If it contains a diagram or photo, describe what you see. Return only the extracted content, no commentary.';

const PDF_PROMPT =
  'Extract all text from this scanned PDF document. Transcribe any handwriting. Return only the extracted content, no commentary.';

function extractText(response: { text?: string }): string {
  return response.text ?? '';
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** Gemini's promptTokenCount INCLUDES cached tokens — subtract them out so the
 *  ledger's input_tokens bucket excludes cache reads (suite-wide convention). */
export function geminiUsageTokens(meta: GeminiUsageMetadata | undefined): {
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
} {
  const cached = meta?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (meta?.promptTokenCount ?? 0) - cached),
    outputTokens: meta?.candidatesTokenCount ?? 0,
    cacheReadTokens: cached,
  };
}

export class GeminiVisionImageExtractor implements Extractor {
  readonly id = 'gemini-vision-image';
  readonly mediaType = 'image';
  readonly supportedExtensions = GEMINI_IMAGE_EXTENSIONS;

  private readonly client: GoogleGenAI;

  constructor(apiKey: string, private readonly recorder?: UsageRecorder) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const buffer = await readFile(filePath);
    // Trust the bytes, not the filename — see image-sniff.ts. Gemini accepts only
    // GEMINI_SUPPORTED_MIME; anything else fails here naming its real format rather
    // than going upstream under a borrowed label.
    const resolved = resolveImageMime(buffer, ext, GEMINI_SUPPORTED_MIME, IMAGE_MIME_TYPES);
    if (!resolved.ok) throw new Error(resolved.reason);
    const { mimeType } = resolved;
    if (resolved.sniffedButUnsupported) {
      console.warn(`[extraction:gemini-vision] ${filePath} is really ${resolved.sniffedButUnsupported} but named ${ext}; sending as ${mimeType} because the provider does not list its true type`);
    }

    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:gemini-vision] sending ${sizeMB}MB ${ext} image to Gemini vision`);
    const data = buffer.toString('base64');

    const t0 = Date.now();
    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data } },
            { text: IMAGE_PROMPT },
          ],
        },
      ],
    });
    this.recorder?.record({
      provider: 'google',
      model: MODEL,
      service: 'engine',
      purpose: 'vision-extraction',
      ...geminiUsageTokens((response as { usageMetadata?: GeminiUsageMetadata }).usageMetadata),
      sourceRef: filePath,
      latencyMs: Date.now() - t0,
    });

    const text = extractText(response);
    console.log(`[extraction:gemini-vision] image extraction complete: ${text.length} chars`);
    return { text };
  }
}

export class GeminiVisionPdfExtractor implements Extractor {
  readonly id = 'gemini-vision-pdf';
  readonly mediaType = 'pdf';
  readonly supportedExtensions = ['.pdf'];

  private readonly client: GoogleGenAI;

  constructor(apiKey: string, private readonly recorder?: UsageRecorder) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async extract(filePath: string): Promise<ExtractionResult> {
    const buffer = await readFile(filePath);
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
    console.log(`[extraction:gemini-vision] sending ${sizeMB}MB scanned PDF to Gemini vision`);
    const data = buffer.toString('base64');

    const t0 = Date.now();
    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'application/pdf', data } },
            { text: PDF_PROMPT },
          ],
        },
      ],
    });
    this.recorder?.record({
      provider: 'google',
      model: MODEL,
      service: 'engine',
      purpose: 'vision-extraction',
      ...geminiUsageTokens((response as { usageMetadata?: GeminiUsageMetadata }).usageMetadata),
      sourceRef: filePath,
      latencyMs: Date.now() - t0,
    });

    const text = extractText(response);
    console.log(`[extraction:gemini-vision] scanned PDF extraction complete: ${text.length} chars`);
    return { text };
  }
}

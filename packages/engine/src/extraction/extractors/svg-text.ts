import { readFile } from 'node:fs/promises';
import type { Extractor, ExtractionResult } from '../types.js';

// Pull human-readable text out of an SVG (XML) locally — no vision model.
// Vision APIs accept only raster formats, so a .svg embed would otherwise be
// skipped as an unsupported extension. Tspans live inside <text>, so the
// <text> match already covers them (nested tags are stripped from the
// captured inner content).
const TEXT_ELEMENT_RE = /<(title|desc|text)\b[^>]*>([\s\S]*?)<\/\1>/gi;

function fromCodePointSafe(cp: number): string {
  try {
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  } catch {
    return '';
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => fromCodePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => fromCodePointSafe(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // ampersand last so decoded text isn't re-decoded
}

export class SvgTextExtractor implements Extractor {
  readonly id = 'svg-text';
  readonly mediaType = 'image';
  readonly supportedExtensions = ['.svg'];

  async extract(filePath: string): Promise<ExtractionResult> {
    const raw = await readFile(filePath, 'utf-8');
    const parts: string[] = [];
    TEXT_ELEMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEXT_ELEMENT_RE.exec(raw)) !== null) {
      const inner = m[2].replace(/<[^>]*>/g, ' '); // strip nested tags (e.g. tspan)
      const decoded = decodeEntities(inner).replace(/\s+/g, ' ').trim();
      if (decoded) parts.push(decoded);
    }
    const text = parts.join('\n');
    console.log(`[extraction:svg-text] extracted ${text.length} chars from ${parts.length} elements`);
    return { text, metadata: { elements: parts.length } };
  }
}

// src/mcp/tools/attachment-name.ts
// Pure helpers for naming a pasted image attachment. No fs, no db.
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** True for the image mime types the engine's vision extractors support. */
export function isAllowedImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_EXT, mime);
}

const AUDIO_MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
};

/** True for the audio mime types the engine's Deepgram extractor can transcribe. */
export function isAllowedAudioMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIO_MIME_EXT, mime);
}

function slugify(name: string): string {
  const base = basename(name).replace(/\.[^.]*$/, ''); // drop dir + extension
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'image';
}

/**
 * Collision-safe, idempotent attachment filename: `<slug>-<sha256(bytes)[:12]>.<ext>`.
 * Same bytes + same name → same filename, so re-pasting an image dedupes. `mime` must be allowed.
 */
export function attachmentFilename(originalName: string, mime: string, bytes: Buffer): string {
  const ext = MIME_EXT[mime] ?? AUDIO_MIME_EXT[mime] ?? (extname(originalName).replace(/^\./, '').toLowerCase() || 'bin');
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return `${slugify(originalName)}-${hash}.${ext}`;
}

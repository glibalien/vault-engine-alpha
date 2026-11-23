import { describe, it, expect } from 'vitest';
import { sniffImageMime, resolveImageMime } from '../../src/extraction/image-sniff.js';

/** Minimal headers — the sniffer only ever reads the first few bytes. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a______');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(4)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(4)]);
const BMP = Buffer.from('BM__________');
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML = Buffer.from('<!DOCTYPE html>');

describe('sniffImageMime', () => {
  it('identifies each format from its magic bytes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(AVIF)).toBe('image/avif');
    expect(sniffImageMime(HEIC)).toBe('image/heic');
    expect(sniffImageMime(BMP)).toBe('image/bmp');
    expect(sniffImageMime(TIFF)).toBe('image/tiff');
  });

  it('returns null for non-images and for buffers too short to identify', () => {
    expect(sniffImageMime(HTML)).toBeNull();
    expect(sniffImageMime(Buffer.alloc(2))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('resolveImageMime', () => {
  const SUPPORTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  it('believes the bytes over the extension when they disagree', () => {
    // The whole point: 87 vault attachments are PNG/WebP/AVIF named ".jpg".
    // Trusting the extension sent Gemini `image/jpeg` for bytes that were not JPEG.
    expect(resolveImageMime(WEBP, '.jpg', SUPPORTED)).toEqual({ ok: true, mimeType: 'image/webp' });
    expect(resolveImageMime(PNG, '.jpg', SUPPORTED)).toEqual({ ok: true, mimeType: 'image/png' });
  });

  it('agrees with the extension when the bytes match it', () => {
    expect(resolveImageMime(JPEG, '.jpg', SUPPORTED)).toEqual({ ok: true, mimeType: 'image/jpeg' });
  });

  it('falls back to the extension when the true format is outside the provider list', () => {
    // AVIF is absent from Gemini's DOCUMENTED list, but the provider decodes by
    // content and accepts it: all 12 AVIF-as-.jpg vault attachments extracted
    // successfully on 2026-07-25 while labelled image/jpeg. Refusing them here
    // would break what works, so prefer the extension and let the provider judge.
    expect(resolveImageMime(AVIF, '.jpg', SUPPORTED)).toMatchObject({ ok: true, mimeType: 'image/jpeg' });
  });

  it('reports the true format so the fallback is visible, not silent', () => {
    const r = resolveImageMime(AVIF, '.jpg', SUPPORTED);
    expect(r.ok).toBe(true);
    expect(r.ok === true ? r.sniffedButUnsupported : undefined).toBe('image/avif');
  });

  it('does not flag a discrepancy when the bytes are supported outright', () => {
    const r = resolveImageMime(WEBP, '.jpg', SUPPORTED);
    expect(r.ok === true ? r.sniffedButUnsupported : 'x').toBeUndefined();
  });

  it('refuses only when neither the bytes nor the extension yield a supported type', () => {
    const r = resolveImageMime(AVIF, '.avif', SUPPORTED);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/image\/avif/);
  });

  it('falls back to the extension when the bytes are unrecognisable', () => {
    // Keeps prior behaviour for anything the sniffer does not know.
    expect(resolveImageMime(Buffer.alloc(2), '.png', SUPPORTED)).toEqual({ ok: true, mimeType: 'image/png' });
  });

  it('refuses when neither the bytes nor the extension resolve', () => {
    const r = resolveImageMime(Buffer.alloc(2), '.xyz', SUPPORTED);
    expect(r.ok).toBe(false);
  });
});

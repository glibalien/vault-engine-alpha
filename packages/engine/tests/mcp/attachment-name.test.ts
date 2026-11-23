import { describe, it, expect } from 'vitest';
import { isAllowedImageMime, isAllowedAudioMime, attachmentFilename } from '../../src/mcp/tools/attachment-name.js';

describe('isAllowedImageMime', () => {
  it('accepts the supported image types', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(isAllowedImageMime(m)).toBe(true);
  });
  it('rejects non-image and unsupported types', () => {
    for (const m of ['text/plain', 'application/pdf', 'image/svg+xml', '']) expect(isAllowedImageMime(m)).toBe(false);
  });
});

describe('isAllowedAudioMime', () => {
  it('accepts the supported audio types', () => {
    for (const m of ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg']) expect(isAllowedAudioMime(m)).toBe(true);
  });
  it('rejects non-audio types', () => {
    for (const m of ['text/plain', 'image/png', '']) expect(isAllowedAudioMime(m)).toBe(false);
  });
});

describe('attachmentFilename', () => {
  const bytes = Buffer.from('hello world');
  it('is deterministic (same bytes + name -> same filename) for idempotent dedupe', () => {
    expect(attachmentFilename('Screenshot.png', 'image/png', bytes))
      .toBe(attachmentFilename('Screenshot.png', 'image/png', bytes));
  });
  it('slugifies the base name, appends a 12-char content hash, and uses the mime extension', () => {
    const name = attachmentFilename('My Screenshot 2026.PNG', 'image/png', bytes);
    expect(name).toMatch(/^my-screenshot-2026-[0-9a-f]{12}\.png$/);
  });
  it('maps jpeg to .jpg and derives the slug from a path-y name', () => {
    expect(attachmentFilename('foo/bar baz.jpeg', 'image/jpeg', bytes)).toMatch(/^bar-baz-[0-9a-f]{12}\.jpg$/);
  });
  it('falls back to "image" when the base name is empty after slugify', () => {
    expect(attachmentFilename('***', 'image/webp', bytes)).toMatch(/^image-[0-9a-f]{12}\.webp$/);
  });
  it('changes the hash when the bytes change', () => {
    const a = attachmentFilename('x.png', 'image/png', Buffer.from('a'));
    const b = attachmentFilename('x.png', 'image/png', Buffer.from('b'));
    expect(a).not.toBe(b);
  });
  it('maps audio/webm to a .webm extension and slugifies the recording name', () => {
    expect(attachmentFilename('Recording 20260618213455', 'audio/webm', bytes)).toMatch(/^recording-20260618213455-[0-9a-f]{12}\.webm$/);
  });
});

// Content-based image type detection.
//
// The vision extractors used to derive the MIME type from the file EXTENSION alone,
// which meant the engine asserted a format it had not checked. Real vault data broke
// that assumption badly: 87 attachments named `.jpg` are actually WebP (50), PNG (25)
// or AVIF (12) — browsers save whatever the CDN negotiated under the clicked name.
// Sending AVIF bytes labelled `image/jpeg` produced opaque upstream 400s on every
// engine restart. Bytes are the truth; the extension is a hint.

/** Magic-byte signatures. Order matters only in that ISO-BMFF brands share a prefix. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);

/** ISO-BMFF `ftyp` brands (bytes 4..12) → MIME. AVIF and HEIC share the container. */
const FTYP_BRANDS: ReadonlyArray<readonly [string, string]> = [
  ['avif', 'image/avif'],
  ['avis', 'image/avif'],
  ['heic', 'image/heic'],
  ['heix', 'image/heic'],
  ['heim', 'image/heic'],
  ['heis', 'image/heic'],
  ['hevc', 'image/heic'],
  ['mif1', 'image/heif'],
  ['msf1', 'image/heif'],
];

/**
 * MIME type implied by a buffer's leading bytes, or null when unrecognised.
 * Reads at most the first 12 bytes and never throws on short input.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 3) return null;

  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 4 && (buf.subarray(0, 4).equals(TIFF_LE) || buf.subarray(0, 4).equals(TIFF_BE))) return 'image/tiff';

  // RIFF....WEBP — the middle 4 bytes are the chunk size, not part of the signature.
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';

  // ISO-BMFF: size(4) + 'ftyp' + brand(4).
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1').toLowerCase();
    for (const [b, mime] of FTYP_BRANDS) if (brand === b) return mime;
  }
  return null;
}

export type ResolvedImageMime =
  | { ok: true; mimeType: string; sniffedButUnsupported?: string }
  | { ok: false; reason: string };

/**
 * Decide the MIME type to send upstream: prefer what the bytes say, fall back to the
 * extension, and only refuse when neither yields something the provider accepts.
 *
 * The fallback is load-bearing, not laziness. A provider's DOCUMENTED MIME list is
 * narrower than what it actually decodes: Gemini does not list image/avif, yet all
 * twelve AVIF-named-.jpg attachments in this vault extracted successfully while
 * labelled image/jpeg (verified 2026-07-25). Refusing a file the provider would have
 * accepted is a worse failure than sending a slightly-off label, so when the true
 * format is outside `supported` we defer to the extension and report the discrepancy
 * via `sniffedButUnsupported` for the caller to log. The lie that mattered — claiming
 * jpeg for WebP/PNG that ARE supported under their real names — is still fixed.
 */
export function resolveImageMime(
  buf: Buffer,
  ext: string,
  supported: readonly string[],
  byExtension: Readonly<Record<string, string>> = {},
): ResolvedImageMime {
  const sniffed = sniffImageMime(buf);
  const fromExt = byExtension[ext] ?? EXT_FALLBACK[ext];

  if (sniffed && supported.includes(sniffed)) return { ok: true, mimeType: sniffed };

  if (sniffed && fromExt && supported.includes(fromExt)) {
    return { ok: true, mimeType: fromExt, sniffedButUnsupported: sniffed };
  }
  if (!sniffed && fromExt && supported.includes(fromExt)) return { ok: true, mimeType: fromExt };

  const what = sniffed ?? fromExt;
  if (!what) {
    return { ok: false, reason: `Unsupported image format: ${ext} (contents not recognised as an image)` };
  }
  const how = sniffed ? 'file contents are' : 'extension implies';
  return { ok: false, reason: `Unsupported image format: ${how} ${what}, which this vision provider does not accept (file named ${ext})` };
}

/** Extension → MIME used when the bytes are unrecognisable. Superset of both providers'
 *  lists; the `supported` check is what actually gates. */
const EXT_FALLBACK: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
};

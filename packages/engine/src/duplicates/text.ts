import { createHash } from 'node:crypto';
import { seededRandom } from '../survey/kmeans.js';

/**
 * How two notes' texts are compared (#646). No model and no embedding: a duplicate is the same
 * words, and embeddings measure the same subject, which notes written from one template share
 * without being copies.
 *
 * - **Exact:** the same body once line endings and trailing spaces are set aside.
 * - **Near:** the share of three-word runs ("shingles") two notes have in common, out of all the
 *   runs either has (Jaccard similarity). Words are letters and digits only, so the same text in
 *   another app's markup (`## Heading` or `**Heading**`, `-` or `*` bullets) is the same text.
 *
 * To compare many notes without comparing every pair, each note gets a short signature whose
 * positions agree between two notes about as often as their texts overlap (MinHash). Notes that
 * agree on a whole band of positions are candidates, and only candidates are compared in full.
 */

export const TEXT_LIMITS = {
  /** Words in a shingle. */
  shingleWords: 3,
  /** Shingle hashes kept per note: the smallest. A note with fewer is kept whole and compared exactly. */
  sketch: 512,
  /** Signature positions, in bands of `rows`. */
  hashes: 96,
  rows: 3,
} as const;

export const BANDS = TEXT_LIMITS.hashes / TEXT_LIMITS.rows;

/** A body with line endings and trailing spaces set aside, and blank lines at either end dropped. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
}

export function bodyHash(normalized: string): string {
  return createHash('sha1').update(normalized).digest('hex');
}

/** The words of a text, lowercased: runs of letters and digits. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hashWords(words: readonly string[], from: number, count: number): number {
  // FNV-1a over the words, with a separator so ("ab", "c") and ("a", "bc") differ.
  let hash = 0x811c9dc5;
  for (let w = from; w < from + count; w++) {
    const word = words[w]!;
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface TextSketch {
  /** Distinct shingles in the text. */
  shingles: number;
  /** The smallest shingle hashes, ascending: all of them when `complete`. */
  hashes: Uint32Array;
  complete: boolean;
}

/** A note's shingles as a bounded sketch. A text with fewer words than a shingle has none. */
export function sketchOf(words: readonly string[]): TextSketch {
  const runs = words.length - TEXT_LIMITS.shingleWords + 1;
  if (runs <= 0) return { shingles: 0, hashes: new Uint32Array(0), complete: true };
  const all = new Uint32Array(runs);
  for (let i = 0; i < runs; i++) all[i] = hashWords(words, i, TEXT_LIMITS.shingleWords);
  all.sort();
  let distinct = 0;
  for (let i = 0; i < runs; i++) {
    if (i === 0 || all[i] !== all[i - 1]) all[distinct++] = all[i]!;
  }
  const kept = Math.min(distinct, TEXT_LIMITS.sketch);
  return { shingles: distinct, hashes: all.slice(0, kept), complete: distinct <= TEXT_LIMITS.sketch };
}

/**
 * The share of shingles two texts have in common. Exact when both sketches are complete;
 * otherwise estimated from the smallest hashes of the two together, which is unbiased and
 * within a few hundredths at this sketch size.
 */
export function similarity(a: TextSketch, b: TextSketch): number {
  if (a.shingles === 0 || b.shingles === 0) return 0;
  const exact = a.complete && b.complete;
  // The smallest `take` hashes of the union are known for sure: each sketch holds every hash of
  // its text below its own largest.
  const take = exact ? Infinity : Math.min(a.hashes.length, b.hashes.length);
  let i = 0;
  let j = 0;
  let seen = 0;
  let shared = 0;
  while (seen < take && (i < a.hashes.length || j < b.hashes.length)) {
    const x = i < a.hashes.length ? a.hashes[i]! : Infinity;
    const y = j < b.hashes.length ? b.hashes[j]! : Infinity;
    if (x === y) { shared += 1; i += 1; j += 1; } else if (x < y) i += 1; else j += 1;
    seen += 1;
  }
  return seen === 0 ? 0 : shared / seen;
}

/** Multipliers and offsets for the signature's hash functions: fixed, so the same notes always give the same result. */
const MIX: ReadonlyArray<readonly [number, number]> = (() => {
  const random = seededRandom(646);
  return Array.from({ length: TEXT_LIMITS.hashes }, () =>
    [(Math.floor(random() * 0x100000000) | 1) >>> 0, Math.floor(random() * 0x100000000) >>> 0] as const);
})();

/** Writes a sketch's signature into `out` at `offset`: per hash function, the smallest value over the sketch. */
export function writeSignature(sketch: TextSketch, out: Uint32Array, offset: number): void {
  for (let h = 0; h < TEXT_LIMITS.hashes; h++) {
    const [multiply, add] = MIX[h]!;
    let least = 0xffffffff;
    for (let i = 0; i < sketch.hashes.length; i++) {
      const value = (Math.imul(sketch.hashes[i]!, multiply) + add) >>> 0;
      if (value < least) least = value;
    }
    out[offset + h] = least;
  }
}

/** One band of a signature as a single number: equal for two notes that agree on the whole band. */
export function bandKey(signatures: Uint32Array, offset: number, band: number): number {
  let hash = (0x811c9dc5 ^ band) >>> 0;
  for (let r = 0; r < TEXT_LIMITS.rows; r++) {
    hash ^= signatures[offset + band * TEXT_LIMITS.rows + r]!;
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 15;
  }
  return hash >>> 0;
}

// src/search/chunker.ts
//
// Pure, tokenizer-agnostic chunking for long documents. The caller supplies a
// token-counting callback; in production the Nomic tokenizer via the worker
// pipeline, in tests an approximation. No imports from the worker or model code.
//
// Cycle 5: every chunk also carries the ordered, unique ATX heading trails
// (H1 > H2 > H3) of the sections packed inside it, so the worker can render
// them into the vector input. Headings inside fenced code blocks are content,
// not structure.

export type Tokenize = (text: string) => number;

export interface ChunkOptions {
  /** Maximum tokens per chunk. Nomic v1.5 context window is 8192. */
  maxTokens: number;
  /** Tokens of overlap when hard-splitting content with no natural boundaries. */
  overlapTokens: number;
}

export interface HeadingChunk {
  text: string;
  /** Ordered unique heading trails; each trail is [H1, H2, ...] outermost first. */
  trails: string[][];
}

/** Chunk text only — same boundaries as chunkForEmbeddingWithHeadings. */
export function chunkForEmbedding(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  return chunkForEmbeddingWithHeadings(text, tokenize, options).map(c => c.text);
}

export function chunkForEmbeddingWithHeadings(
  text: string,
  tokenize: Tokenize,
  options: ChunkOptions,
): HeadingChunk[] {
  if (text.length === 0) return [];
  if (tokenize(text) <= options.maxTokens) {
    return [{ text, trails: collectTrails(text) }];
  }

  const sections = splitByHeadings(text);
  const split = sections.flatMap(section =>
    splitIfNeeded(section.text, tokenize, options).map(piece => ({ text: piece, trails: [section.trail] as string[][] })),
  );
  return pack(split, tokenize, options.maxTokens).map(c => ({ text: c.text, trails: pruneAncestorTrails(c.trails) }));
}

/**
 * Drop trails that are a strict prefix of a later trail — a parent section's
 * chunk text is only its heading line(s) once a nested child section is packed
 * into the same chunk, so the child trail already carries that context.
 * Ordered uniqueness is preserved.
 */
export function pruneAncestorTrails(trails: string[][]): string[][] {
  return trails.filter((t, i) =>
    !trails.some((other, j) =>
      j !== i && other.length > t.length && t.every((h, k) => other[k] === h),
    ),
  );
}

interface Section {
  text: string;
  trail: string[];
}

/**
 * Collect every unique heading trail appearing in a (single-piece) document,
 * in first-appearance order. Used when the whole text fits in one chunk.
 */
function collectTrails(text: string): string[][] {
  const sections = splitByHeadings(text);
  const seen = new Set<string>();
  const trails: string[][] = [];
  for (const section of sections) {
    const key = section.trail.join('\u0001');
    if (section.trail.length > 0 && !seen.has(key)) {
      seen.add(key);
      trails.push(section.trail);
    }
  }
  return trails;
}

/**
 * Split into sections at ATX headings, tracking the nested heading trail.
 * Lines inside ``` / ~~~ fenced code blocks never start a section and never
 * update the trail. Heading lines stay in the section text (unchanged from
 * v2); the trail is metadata for rendering, not removed content.
 */
function splitByHeadings(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let current: string[] = [];
  // Track (level, text) pairs — heading LEVELS, not array positions, decide
  // nesting (a document may start at H2, so position alone is wrong).
  let stack: Array<{ level: number; text: string }> = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  const pushCurrent = (): void => {
    if (current.length > 0) sections.push({ text: current.join('\n'), trail: stack.map(s => s.text) });
  };

  for (const line of lines) {
    if (fence) {
      // CommonMark closers use the same marker, are at least as long as the
      // opener, allow at most three leading spaces, and have no trailing text.
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close) {
        const marker = close[1][0] as '`' | '~';
        if (marker === fence.marker && close[1].length >= fence.length) fence = null;
      }
      current.push(line);
      continue;
    }

    // CommonMark openers allow at most three leading spaces. Backtick info
    // strings may not themselves contain a backtick.
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      const marker = open[1][0] as '`' | '~';
      if (marker === '~' || !open[2].includes('`')) {
        fence = { marker, length: open[1].length };
        current.push(line);
        continue;
      }
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      pushCurrent();
      const level = headingMatch[1].length;
      // Strip optional closing hashes (`## Title ##`) and trim.
      const headingText = headingMatch[2].replace(/\s#+\s*$/, '').trim();
      stack = [...stack.filter(s => s.level < level), { level, text: headingText }];
      current = [line];
    } else {
      current.push(line);
    }
  }
  pushCurrent();
  return sections;
}

function splitIfNeeded(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  if (tokenize(text) <= options.maxTokens) return [text];

  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    return paragraphs.flatMap(p => splitIfNeeded(p, tokenize, options));
  }

  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    return sentences.flatMap(s => splitIfNeeded(s, tokenize, options));
  }

  return hardSplit(text, tokenize, options);
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"(\d])/);
  return parts.filter(p => p.length > 0);
}

function hardSplit(text: string, tokenize: Tokenize, options: ChunkOptions): string[] {
  const chunks: string[] = [];
  const approxCharsPerToken = Math.max(1, Math.ceil(text.length / Math.max(1, tokenize(text))));
  const charBudget = options.maxTokens * approxCharsPerToken;
  const overlapChars = options.overlapTokens * approxCharsPerToken;

  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + charBudget);
    while (end > start && tokenize(text.slice(start, end)) > options.maxTokens) {
      end -= Math.max(1, Math.floor(charBudget * 0.1));
    }
    if (end <= start) {
      end = Math.min(text.length, start + 1);
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

/**
 * Pack adjacent pieces up to the budget. A packed chunk carries every ordered,
 * unique heading trail of the pieces inside it (first-appearance order).
 */
function pack(pieces: HeadingChunk[], tokenize: Tokenize, maxTokens: number): HeadingChunk[] {
  const packed: HeadingChunk[] = [];
  let buffer: HeadingChunk | null = null;
  for (const piece of pieces) {
    if (piece.text.length === 0) continue;
    if (!buffer) {
      buffer = { text: piece.text, trails: [...piece.trails] };
      continue;
    }
    const candidate: string = `${buffer.text}\n\n${piece.text}`;
    if (tokenize(candidate) <= maxTokens) {
      buffer = { text: candidate, trails: mergeTrails(buffer.trails, piece.trails) };
    } else {
      packed.push(buffer);
      buffer = { text: piece.text, trails: [...piece.trails] };
    }
  }
  if (buffer) packed.push(buffer);
  return packed;
}

function mergeTrails(a: string[][], b: string[][]): string[][] {
  const seen = new Set(a.map(t => t.join('\u0001')));
  const merged = [...a];
  for (const trail of b) {
    const key = trail.join('\u0001');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(trail);
    }
  }
  return merged;
}

/** Render heading trails for the vector input: one `H1 > H2 > H3` per line. */
export function renderHeadingTrails(trails: string[][]): string {
  return trails
    .map(t => t.filter(h => h.length > 0).join(' > '))
    .filter(line => line.length > 0)
    .join('\n');
}

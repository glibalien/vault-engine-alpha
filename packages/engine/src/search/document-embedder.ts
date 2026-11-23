// src/search/document-embedder.ts
//
// Per-request embedding orchestration, pure and tokenizer-injected so it is
// unit-testable without the ONNX model. The worker (embedder-worker.ts) wires
// in the real tokenizer + embedOne; tests wire in approximations.
//
// Cycle 5 rendering: when a request carries a semantic context, every vector
// input is rendered as
//
//   search_document: <static semantic context, ≤256 tokens>
//   <heading trails, ≤64 tokens>
//   Content: <chunk body>
//
// and the fully rendered candidate is verified against the token ceiling with
// the real tokenizer. Without a context the legacy `prefix: text` behavior is
// preserved byte-for-byte (queries and fallback callers).

import { chunkForEmbedding, chunkForEmbeddingWithHeadings, renderHeadingTrails, type Tokenize } from './chunker.js';
import {
  capContextLines,
  renderContextLines,
  truncateToTokens,
  CONTEXT_TOKEN_BUDGET,
  HEADING_TRAIL_TOKEN_BUDGET,
  type EmbeddingDocumentContext,
} from './semantic-context.js';

export interface DocumentEmbedRequest {
  text: string;
  prefix: 'search_document' | 'search_query';
  context?: EmbeddingDocumentContext;
}

export interface DocumentEmbedDeps {
  tokenCount: Tokenize;
  embedOne: (rendered: string) => Promise<number[]>;
  maxTokens: number;
  overlapTokens: number;
  /** Headroom for prefix + [CLS]/[SEP] specials on the legacy path. */
  prefixHeadroomTokens: number;
}

/**
 * Embed one request, returning one vector per chunk. Guarantees every
 * rendered input sent to embedOne is within deps.maxTokens (real tokenizer).
 */
export async function embedRequest(
  req: DocumentEmbedRequest,
  deps: DocumentEmbedDeps,
): Promise<number[][]> {
  const { tokenCount, embedOne, maxTokens } = deps;

  // Legacy path: no context → unchanged v2 behavior.
  if (!req.context) {
    const prefixed = `${req.prefix}: ${req.text}`;
    if (tokenCount(prefixed) <= maxTokens) {
      return [await embedOne(prefixed)];
    }
    const chunks = chunkForEmbedding(req.text, tokenCount, {
      maxTokens: maxTokens - deps.prefixHeadroomTokens,
      overlapTokens: deps.overlapTokens,
    });
    const vectors: number[][] = [];
    for (const chunk of chunks) {
      vectors.push(await embedOne(`${req.prefix}: ${chunk}`));
    }
    return vectors;
  }

  // Context-rich path (documents only — queries never carry a context).
  const contextLines = renderContextLines(req.context);
  let contextBudget = Math.min(CONTEXT_TOKEN_BUDGET, maxTokens);
  let contextBlock = capContextLines(contextLines, tokenCount, contextBudget);

  const renderWith = (trailsBlock: string, body: string): string =>
    trailsBlock
      ? `${req.prefix}: ${contextBlock}\n${trailsBlock}\nContent: ${body}`
      : `${req.prefix}: ${contextBlock}\nContent: ${body}`;

  // The context cap alone is not enough: task prefix, newlines, and Content:
  // framing also consume model tokens. Tighten the context until the empty-body
  // render fits, using the real tokenizer against the complete candidate.
  let staticTokens = tokenCount(renderWith('', ''));
  while (staticTokens > maxTokens && contextBudget > 0) {
    contextBudget = Math.max(0, contextBudget - Math.max(1, staticTokens - maxTokens));
    contextBlock = capContextLines(contextLines, tokenCount, contextBudget);
    staticTokens = tokenCount(renderWith('', ''));
  }
  if (staticTokens > maxTokens) {
    throw new Error(`Embedding framing exceeds the ${maxTokens}-token model ceiling`);
  }

  // Context-only node (empty body): still produces exactly one vector.
  if (req.text.trim().length === 0) {
    return [await embedOne(renderWith('', ''))];
  }

  // Chunk the body with a budget that reserves room for the static render
  // overhead + the trail budget, then verify every fully rendered candidate
  // against the ceiling, shrinking the budget and re-chunking on overflow.
  const staticOverhead = staticTokens;
  let budget = Math.max(1, maxTokens - staticOverhead - HEADING_TRAIL_TOKEN_BUDGET);

  while (true) {
    const chunks = chunkForEmbeddingWithHeadings(req.text, tokenCount, {
      maxTokens: budget,
      overlapTokens: deps.overlapTokens,
    });

    let worstOverflow = 0;
    const rendered: string[] = [];
    for (const chunk of chunks) {
      const trailsBlock = truncateToTokens(
        renderHeadingTrails(chunk.trails), tokenCount, HEADING_TRAIL_TOKEN_BUDGET,
      );
      const candidate = renderWith(trailsBlock, chunk.text);
      const overflow = tokenCount(candidate) - maxTokens;
      if (overflow > worstOverflow) worstOverflow = overflow;
      rendered.push(candidate);
    }

    if (worstOverflow <= 0) {
      const vectors: number[][] = [];
      for (const candidate of rendered) {
        vectors.push(await embedOne(candidate));
      }
      return vectors;
    }

    // Shrink the body budget by the worst overflow and re-chunk. The budget
    // strictly decreases, so this terminates; the floor guards pathological
    // tokenizers where even a tiny body + context exceeds the ceiling.
    if (budget === 1) break;
    budget = Math.max(1, Math.min(budget - worstOverflow, Math.floor(budget / 2)));
  }

  // Pathological tokenizer fallback: hard-split at one token, but still verify
  // every complete render. If even one character cannot coexist with the
  // framing, fail the request rather than violating the model ceiling.
  const fallback = chunkForEmbeddingWithHeadings(req.text, tokenCount, { maxTokens: 1, overlapTokens: 0 });
  const vectors: number[][] = [];
  for (const chunk of fallback) {
    const candidate = renderWith('', chunk.text);
    if (tokenCount(candidate) > maxTokens) {
      throw new Error(`Embedding content cannot fit within the ${maxTokens}-token model ceiling`);
    }
    vectors.push(await embedOne(candidate));
  }
  return vectors;
}

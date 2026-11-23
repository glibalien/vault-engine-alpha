// src/search/embedder.ts
//
// Public API for the embedding subsystem. The Embedder interface is consumed
// by indexer.ts, search.ts, query-nodes.ts, and watcher.ts. The implementation
// runs in a subprocess to allow memory reclamation when idle.

import type { EmbeddingDocumentContext } from './semantic-context.js';

export { createSubprocessEmbedder, resolveModelsDir } from './embedder-host.js';
export type { SubprocessEmbedderOptions } from './embedder-host.js';
export type { EmbeddingDocumentContext } from './semantic-context.js';

export interface Embedder {
  embedDocument(text: string, context?: EmbeddingDocumentContext): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  isReady(): boolean;
}

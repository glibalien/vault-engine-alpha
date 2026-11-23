export interface EmbeddingMeta {
  id: number;
  node_id: string;
  source_type: 'node' | 'extraction';
  source_hash: string;
  chunk_index: number;
  extraction_ref: string | null;
  embedded_at: string;
}

export interface EmbeddingQueueItem {
  node_id: string;
  source_type: 'node' | 'extraction';
  extraction_ref?: string;
  retries?: number;
}

export interface SearchHit {
  node_id: string;
  score: number;
  match_sources: Array<'fts' | 'semantic'>;
  matched_embed?: string;
  matched_chunk_index?: number;
  snippet?: string;
}

/** Per-drain-loop disposition counts (cycle 5). */
export interface DrainSummary {
  /** Groups whose vectors were (re)written. */
  completed: number;
  /** Groups skipped because the versioned source hash already matched. */
  skipped: number;
  /** Groups dropped after retries or blocked by a permanent rolling-upgrade gap. */
  failed: number;
}

export interface SearchIndexStatus {
  status: 'ready' | 'indexing' | 'disabled';
  nodes_total: number;
  nodes_indexed: number;
  /** Nodes intentionally excluded from semantic embedding. */
  nodes_excluded: number;
  /** Semantically eligible nodes that do not have a node embedding. */
  nodes_unindexed: number;
  extractions_total: number;
  extractions_indexed: number;
  pending: number;
  /** ISO timestamp of the last embedding the drain loop completed; null until first progress. */
  last_drain_at: string | null;
  /** Version recorded in the DB meta table (cycle 5 rolling-upgrade state). */
  stored_version: number;
  /** Version this build embeds. */
  target_version: number;
  /** True while stored_version < target_version (rolling replacement running). */
  rolling_upgrade: boolean;
  /** Cumulative terminal failures this process, including permanent upgrade blockers. */
  terminal_failures: number;
  /** Disposition counts of the most recent drain loop. */
  last_drain: DrainSummary;
}

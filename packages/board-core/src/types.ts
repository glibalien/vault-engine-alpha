import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface BoardCard {
  card_id: string;
  spec: unknown;
  layout: { width?: number; height?: number; order: number };
}

export interface BoardSummary {
  id: string;
  name: string;
  /** Creation time; drives the stable oldest-first board order. Absent on older engines. */
  created_at?: number;
  updated_at: number;
  card_count: number;
}

export interface Board {
  id: string;
  name: string;
  cards: BoardCard[];
  created_at: number;
  updated_at: number;
  /** Doc node ids this board is linked to (Phase 4b). May be absent on older engines. */
  linked_docs?: string[];
}

export interface SaveBoardInput {
  id?: string;
  name: string;
  cards: BoardCard[];
}

/** Tool-name-agnostic call core. Same structural shape as @vault/query-core's CallFn. */
export type CallFn = (toolCall: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<CallToolResult>;

/**
 * Active-document scope seam for a board surface. Resolves the active doc to its
 * stable engine node id (rename-safe) and notifies on active-document changes.
 * Host-specific implementations live in each host (Obsidian, web).
 */
export interface DocScope {
  /** Active doc's node id, or null if there's no active doc / it isn't a node yet. */
  current(): Promise<string | null>;
  /**
   * Stable host-defined key for the active doc (Obsidian: file path), or null
   * when there is no active doc at all. Distinguishes "no active doc" from "an
   * active doc that simply isn't an engine node yet" — `current()` collapses
   * both to null, but a follow handler must reset on the latter and not the
   * former. Synchronous: it reads host state, no engine round-trip.
   */
  currentKey(): string | null;
  /** Subscribe to active-document changes; returns an unsubscribe fn. */
  subscribe(cb: () => void): () => void;
}

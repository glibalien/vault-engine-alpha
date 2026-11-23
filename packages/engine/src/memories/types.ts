import type { MemorySubject, SubjectSetBy } from './subjects.js';
import type { MemoryEvidence } from '../mcp/tools/memory-evidence.js';
import type { UsageService } from '../usage/recorder.js';

/**
 * Shared durable-memory domain types. Extracted from `mcp/tools/memories.ts`
 * (Task 1 of the durable-memory markdown-projection plan) so both the MCP
 * tool surface and the markdown note ingest path reuse one row model, one
 * versioning rule set, and one dedup posture.
 *
 * The service module (`service.ts`) is the single home for row serialization,
 * versioning, vector insertion, temporal predicates, and prepared statements.
 * It never imports from `mcp/` — the MCP tools are thin envelope wrappers over
 * it, and the note ingest path calls it directly without going through MCP.
 */

// ---------------------------------------------------------------------------
// Row + serialized shapes
// ---------------------------------------------------------------------------

/** Raw `memories` table row (one-for-one with the SELECT * columns). */
export interface MemoryRow {
  id: number;
  source: string;
  scope: string;
  node_id: string | null;
  content: string;
  category: string | null;
  metadata_json: string | null;
  vec_id: number | null;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  valid_at: string | null;
  invalid_at: string | null;
  superseded_by: number | null;
  evidence_kind: string;
  evidence_node_id: string | null;
  evidence_hash: string | null;
  evidence_ref: string | null;
  expire_reason: string | null;
  /** Absent on a database that predates the column. */
  changed_by?: string | null;
}

/** Serialized memory returned by every read/mutate result. */
export interface Memory {
  id: number;
  source: string;
  scope: 'vault' | 'node';
  node_id: string | null;
  content: string;
  category: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  valid_at: string | null;
  invalid_at: string | null;
  superseded_by: number | null;
  evidence_kind: string;
  evidence_node_id: string | null;
  evidence_hash: string | null;
  evidence_ref: string | null;
  expire_reason: string | null;
  /**
   * The signed-in chat client that last wrote this row through the memory tools: it minted
   * the row as a new version, edited its category or metadata, or retired or reactivated it.
   * Null when the suite itself wrote the row. `source` is kept across updates, so this is
   * what says an `owner` or `curator` memory is no longer in its source's own words (#532).
   */
  changed_by: string | null;
  /** What the memory is about (#554): links to notes of the vault map's `entityTypes`, and
   *  names no note answers to yet. Present on get-memory, list-memories, create and update results. */
  subjects?: MemorySubject[];
}

// ---------------------------------------------------------------------------
// Service result envelope (domain-level, MCP-agnostic)
// ---------------------------------------------------------------------------

export interface ServiceError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface MemoryWarning {
  code: string;
  severity: 'warning';
  message: string;
}

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

// ---------------------------------------------------------------------------
// create-memory
// ---------------------------------------------------------------------------

export interface CreateMemoryArgs {
  source: string;
  content: string;
  scope: 'vault' | 'node';
  node_id?: string | undefined;
  category?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  dedup_threshold?: number | undefined;
  evidence?: MemoryEvidence | undefined;
  /** Spend attribution for the consolidation call this create may make (#298). */
  usage?: CreateMemoryUsage | undefined;
  /** Who or what the memory is about (#554): note titles, aliases, `[[links]]` or note ids. */
  subjects?: readonly string[] | undefined;
  /** How the subjects were set; the memory note's ingest passes `owner`. Default `tool`. */
  subjects_set_by?: SubjectSetBy | undefined;
}

/** Who a create's consolidation call is spent for: the calling service and its run or
 *  conversation. Omitted, the call stays on the Engine's own account. */
export interface CreateMemoryUsage {
  service: UsageService;
  run_ref?: string | undefined;
  source_ref?: string | undefined;
  conversation_id?: string | undefined;
  /** What the consolidation call is recorded as: `memory-consolidation-run` for a Curator run paid
   *  from its own limit (#659), so the Curator's daily tally can leave it out by purpose. */
  purpose?: ConsolidationPurpose | undefined;
}

/** The purposes a consolidation call may be recorded under. */
export const CONSOLIDATION_PURPOSES = ['memory-consolidation', 'memory-consolidation-run'] as const;
export type ConsolidationPurpose = (typeof CONSOLIDATION_PURPOSES)[number];

export type CreateMemoryOk = Omit<Memory, 'valid_at'> & {
  /** Present on add/noop/contradict; omitted on the update-in-create path (matches pre-extraction JSON). */
  dedup_checked?: boolean;
  /** Present on add/noop/contradict; omitted on the update-in-create path. */
  embedding?: boolean;
  operation: 'add' | 'noop' | 'update' | 'contradict';
  superseded: Array<{ id: number; content: string; reason: string }>;
  valid_at: string;
  /** Present when this create made a consolidation model call: what it cost, or null when
   *  unknown. Lets a caller with its own spend cap count the charge as it happens (#298). */
  consolidation_cost_usd?: number | null;
  /** Present when look-alike memories were left out of the comparison because their subjects
   *  are different things of the same kind (#718): none of them could merge with this one. */
  kept_apart?: number[];
};

// ---------------------------------------------------------------------------
// update-memory
// ---------------------------------------------------------------------------

export interface UpdateMemoryArgs {
  id: number;
  content?: string | undefined;
  category?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  evidence?: MemoryEvidence | undefined;
  /** The chat client making the change, recorded on the row it writes. Set by the tool layer. */
  changed_by?: string | undefined;
  /** The memory's subjects, replacing the ones it has (#554). An empty list removes them all. */
  subjects?: readonly string[] | undefined;
  /** How the subjects were set; the memory note's ingest passes `owner`. Default `tool`. */
  subjects_set_by?: SubjectSetBy | undefined;
}

export interface UpdateMemoryOk extends Memory {
  operation: 'update';
  superseded: Array<{ id: number; content: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// expire-memory
// ---------------------------------------------------------------------------

export interface ExpireMemoryArgs {
  id: number;
  reason: string;
  superseded_by?: number | undefined;
  invalid_at?: string | undefined;
  reactivate?: boolean | undefined;
  /** With superseded_by: refuse (CONFLICT, `details.subjects_apart`) when the subject rule keeps the
   *  two apart, checked in the write's transaction (#718). The Curator's reconcile sets it: subjects
   *  can change while its model call runs (Codex, #726). */
  unless_subjects_apart?: boolean | undefined;
  /** The chat client retiring or reactivating the memory. Set by the tool layer. */
  changed_by?: string | undefined;
}

export type ExpireMemoryOk = Memory & {
  already_expired?: boolean;
  already_live?: boolean;
  reactivated?: boolean;
};

// ---------------------------------------------------------------------------
// delete-memory
// ---------------------------------------------------------------------------

export interface DeleteMemoryArgs {
  id: number;
  purge: boolean;
  confirm: boolean;
  /** The chat client deleting the memory. A purge leaves no row, so it is logged. Set by the tool layer. */
  changed_by?: string | undefined;
}

export type DeleteMemoryOk =
  | (Memory & { already_expired?: boolean; operation?: 'expired' })
  | { deleted: { id: number; content: string } };

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export interface GetMemoryArgs {
  id: number;
  include_lineage?: boolean | undefined;
  include_history?: boolean | undefined;
}

/**
 * One in-place change to a memory (#300): a reactivation, with the expiry it cleared, or an
 * edit of its category, metadata or (from a consolidation replay, #346) valid_at, with the
 * values it replaced. Content changes version the memory instead (see lineage).
 */
export interface MemoryHistoryEntry {
  changed_at: string;
  change: 'reactivated' | 'edited';
  reason: string | null;
  previous: Record<string, unknown>;
}

/** The startup vector backfill's tally (#300). */
export interface VectorBackfillResult {
  embedded: number;
  failed: number;
  /** Live memories still without a vector afterwards. */
  remaining: number;
}

export interface ListMemoriesArgs {
  /** FTS5 query; when set, results rank by relevance instead of newest first. */
  query?: string | undefined;
  source?: string | undefined;
  scope?: 'vault' | 'node' | undefined;
  node_id?: string | undefined;
  category?: string | undefined;
  evidence_kind?: string | undefined;
  evidence_node_id?: string | undefined;
  /** Any of these evidence nodes: the memories drawn from a set of notes (#297). */
  evidence_node_ids?: readonly string[] | undefined;
  /** Only these memories, by id: a wiki page keeps a rule while its memory is live (#474). */
  ids?: readonly number[] | undefined;
  /** A node id: memories of the project(s) it is filed under, or of it when it is a project (#352). */
  project_of?: string | undefined;
  /** A node id: the memories about that note (#554), by a subject linked to it or a name that
   *  now resolves to it alone. */
  subject_of?: string | undefined;
  evidence_ref?: string | undefined;
  /** Conversation evidence in either ref format: the bare id or `<id>#<message>` (#300). */
  evidence_conversation?: string | undefined;
  include_superseded?: boolean | undefined;
  /** Only memories expired for one of these reasons (#717): the ones another replaced, with no live ones. */
  expire_reasons?: readonly string[] | undefined;
  as_of?: string | undefined;
  limit: number;
  offset: number;
}

/** How `MemoryService.list` ranks, beyond its filters. */
export interface ListMemoriesOptions {
  /** Rank by closeness of meaning to this vector (`embedSearchQuery`) instead of full text (#560). */
  queryVector?: Float32Array | undefined;
  /** With `queryVector`: leave out memories farther than this cosine distance (default `MEMORY_SEARCH_MAX_DISTANCE`). */
  maxDistance?: number | undefined;
}

/** A near pair's member, with its source note: the reconciler chooses a survivor by its date
 *  (#351), and tells different contexts apart by its title and projects (#352). */
export interface NearPairMember extends Memory {
  note_date: string | null;
  note_title: string | null;
  note_projects: string[];
}

export interface NearPairsArgs {
  near: number;
  far: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Projection snapshot (Task 2)
// ---------------------------------------------------------------------------

/**
 * One row of a consistent full-stock snapshot for the markdown projection.
 * `embedded` is derived from `vec_id IS NOT NULL` — never exposes the raw
 * `vec_id` or vector bytes. `predecessors` is derived by reverse
 * `superseded_by` mapping (the rows that were superseded by this one),
 * oldest-first.
 */
export interface MemoryProjectionRow {
  id: number;
  source: string;
  scope: 'vault' | 'node';
  node_id: string | null;
  content: string;
  category: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  valid_at: string | null;
  invalid_at: string | null;
  superseded_by: number | null;
  predecessors: number[];
  evidence_kind: string;
  evidence_node_id: string | null;
  evidence_hash: string | null;
  evidence_ref: string | null;
  expire_reason: string | null;
  changed_by: string | null;
  embedded: boolean;
  /** The memory's subject names as they were given (#554), in the order they were set. */
  subjects: string[];
}

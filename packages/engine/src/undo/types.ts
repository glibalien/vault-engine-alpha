// src/undo/types.ts
//
// Types shared between the undo module, pipeline integration, and MCP tools.

export interface UndoOperationRow {
  operation_id: string;
  timestamp: number;
  source_tool: string;
  description: string;
  node_count: number;
  schema_count: number;
  global_field_count: number;
  status: 'active' | 'undone' | 'expired';
}

export interface UndoSnapshotRow {
  operation_id: string;
  node_id: string;
  file_path: string;
  title: string | null;
  body: string | null;
  types: string | null;                 // JSON array
  fields: string | null;                // JSON object
  relationships: string | null;         // JSON array
  explicit_null_fields: string | null;  // JSON array; NULL for legacy snapshots
  was_deleted: 0 | 1;
  post_mutation_hash: string | null;
  /** Lines of fields only the note's file held (#656): JSON [{ name, text }]; NULL for none or legacy snapshots. */
  file_only_fields?: string | null;
}

export type ConflictReason =
  | 'path_occupied'
  | 'modified_after_operation'
  | 'superseded_by_later_op';

export interface Conflict {
  operation_id: string;
  node_id: string;
  file_path: string;
  reason: ConflictReason;
  modified_by?: string[];             // e.g., ["update-node at 2026-04-19T14:30:00Z"]
  current_summary: Record<string, unknown>;
  would_restore_summary: Record<string, unknown>;
}

/**
 * The file at the path an operation had moved a note to, which the undo that moved the
 * note back left in place (#509): it is no longer the file Engine wrote there, or it
 * could not be removed. The watcher indexes it as a separate note.
 */
export interface KeptMovedFile {
  node_id: string;
  /** Where the operation had put the note: the kept file's path. */
  file_path: string;
  /** Where the undo put the note back. */
  restored_file_path: string;
  reason: 'changed' | 'remove_failed';
  /** The error, when the file could not be removed. */
  error?: string;
}

export interface RestoreResult {
  operations: Array<{
    operation_id: string;
    node_count: number;
    schema_count: number;
    global_field_count: number;
    status: 'would_undo' | 'undone';
  }>;
  conflicts: Conflict[];
  total_undone: number;
  total_conflicts: number;
  total_skipped: number;
  /** Nodes written back by the restore (embedding refresh targets). */
  restored_node_ids?: string[];
  /** Nodes re-deleted by the restore (embedding rows should be removed). */
  deleted_node_ids?: string[];
  /** Schema projections that remained stale after a committed restore. */
  blocked_schema_exports?: string[];
  /** Files at a moved note's post-operation path that the undo kept (#509). */
  kept_files?: KeptMovedFile[];
}

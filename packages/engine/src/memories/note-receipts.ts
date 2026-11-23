import type Database from 'better-sqlite3';

/**
 * Idempotency + audit ledger for the editable `Settings/Memories.md`
 * projection (Task 2 of the durable-memory markdown-projection plan).
 *
 * Every applied (or definitively rejected) edit is receipted by
 * `(block_key, edit_hash)` so a repeated watcher/reconciler/restart delivery
 * is an exact no-op, and `new:<uuid>` owner drafts are mapped to their
 * resulting memory id. Lookups and inserts are plain prepared-statement
 * helpers: they do NOT open their own transaction, so a caller can compose
 * a receipt insert with the memory-domain mutation it records inside one
 * atomic transaction (the charter's "data is never silently lost" applies
 * symmetrically here — a receipt without its mutation, or vice versa, would
 * be a corrupting partial state).
 *
 * Outcomes (closed set, recorded in `outcome`):
 *  - `created`      owner `new:<uuid>` draft became a live memory
 *  - `updated`      content/category change on an existing block
 *  - `expired`      status live → expired
 *  - `reactivated`  status expired → live
 *  - `noop`         editable hash matched the marker `base` (no-op echo)
 *  - `duplicate`    `DUPLICATE_MEMORY` resolved to an existing id
 *  - `conflict`     stale revision (DB advanced past the marker)
 *  - `rejected`     whole-note validation rejected this block
 */

export interface MemoryNoteReceipt {
  block_key: string;
  edit_hash: string;
  source_memory_id: number | null;
  result_memory_id: number | null;
  outcome: string;
  details_json: string | null;
  applied_at: string;
}

export interface RecordReceiptInput {
  block_key: string;
  edit_hash: string;
  source_memory_id?: number | null | undefined;
  result_memory_id?: number | null | undefined;
  outcome: string;
  details?: Record<string, unknown> | undefined;
  applied_at: string;
}

export type ReceiptOutcome =
  | 'created'
  | 'updated'
  | 'expired'
  | 'reactivated'
  | 'noop'
  | 'duplicate'
  | 'conflict'
  | 'rejected';

export class MemoryNoteReceipts {
  private readonly stmtFind: Database.Statement<[string, string], MemoryNoteReceipt>;
  private readonly stmtFindByBlock: Database.Statement<[string], MemoryNoteReceipt>;
  private readonly stmtInsert: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtFind = db.prepare<[string, string], MemoryNoteReceipt>(
      'SELECT * FROM memory_note_receipts WHERE block_key = ? AND edit_hash = ?',
    );
    this.stmtFindByBlock = db.prepare<[string], MemoryNoteReceipt>(
      'SELECT * FROM memory_note_receipts WHERE block_key = ? ORDER BY applied_at DESC',
    );
    this.stmtInsert = db.prepare(
      `INSERT INTO memory_note_receipts
         (block_key, edit_hash, source_memory_id, result_memory_id, outcome, details_json, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Exact-match lookup: was this precise (block_key, edit_hash) edit already applied/rejected? */
  find(blockKey: string, editHash: string): MemoryNoteReceipt | undefined {
    return this.stmtFind.get(blockKey, editHash);
  }

  /** Any prior receipt for the block key (used for `new:<uuid>` draft idempotency). */
  findByBlockKey(blockKey: string): MemoryNoteReceipt[] {
    return this.stmtFindByBlock.all(blockKey);
  }

  /**
   * Record a receipt. Callers MUST check {@link find} first and wrap this with
   * the mutation it records in one transaction. Throws on PK collision (a
   * collision means a concurrent caller already receipted this edit — the
   * caller's pre-check should have prevented reaching here, so surfacing it is
   * correct rather than silently swallowing it with `INSERT OR IGNORE`).
   */
  record(input: RecordReceiptInput): void {
    this.stmtInsert.run(
      input.block_key,
      input.edit_hash,
      input.source_memory_id ?? null,
      input.result_memory_id ?? null,
      input.outcome,
      input.details !== undefined ? JSON.stringify(input.details) : null,
      input.applied_at,
    );
  }
}

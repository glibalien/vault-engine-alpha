import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryService } from './service.js';
import { MemoryNoteReceipts, type ReceiptOutcome } from './note-receipts.js';
import {
  memoryNotePath,
  parseMemoryNote,
  validateParsedMemoryNote,
  editableMemoryHash,
  subjectKeys,
  type ParsedMemoryNote,
  type NoteEditPlan,
  type EditOp,
  type NewMemoryBlockPayload,
  type MemoryNoteIssue,
} from './note-format.js';
import type { MemoryEvidence } from '../mcp/tools/memory-evidence.js';
import type { SettingsChangeKind } from '../settings/hook.js';

/**
 * Serialized note ingestion for the editable `Settings/Memories.md` projection
 * (Task 4 of the durable-memory markdown-projection plan).
 *
 * The watcher event first ingests `Settings/Memories.md` as an ordinary node
 * through `executeMutation({source:'watcher', db_only:true})`; the post-index
 * `notifySettingsChange` hook then fires, and this module:
 *   1. Reads the already-indexed memory-note node id + content hash from the DB.
 *   2. Parses and validates the whole note before applying anything.
 *   3. On validation failure, writes one `edits_log` event
 *      (`memory-note-rejected`) and applies zero memory changes.
 *   4. For each changed existing block, checks the receipt ledger for idempotency,
 *      then calls `MemoryService.update` / `.expire` / `.reactivate`.
 *   5. For `new:<uuid>` blocks (Task 5), calls `MemoryService.create` with
 *      `source:'owner'` and note evidence.
 *   6. Receipts every applied or definitively-rejected edit.
 *
 * `drain()` resolves after all queued edits — used by the projection refresh
 * (Task 6) to ensure pending ingest lands before rendering the canonical note.
 *
 * `unlink` never changes memories. This module never renders or writes the
 * markdown file — that's the projection path's job (Task 6).
 */

const EXPIRE_REASON_OWNER_EDIT = 'owner-edited-memory-note';

export interface MemoryNoteIngestDeps {
  db: Database.Database;
  vaultPath: string;
  settingsDir: string;
  service: MemoryService;
  receipts: MemoryNoteReceipts;
}

interface QueuedWork {
  relPath: string;
  kind: SettingsChangeKind;
}

export class MemoryNoteIngest {
  private readonly deps: MemoryNoteIngestDeps;
  private readonly notePath: string;
  private readonly queue: QueuedWork[] = [];
  private processing = false;
  private drainResolvers: Array<() => void> = [];

  constructor(deps: MemoryNoteIngestDeps) {
    this.deps = deps;
    this.notePath = memoryNotePath(deps.settingsDir);
  }

  handles(relPath: string): boolean {
    return relPath === this.notePath;
  }

  /**
   * Enqueue asynchronous work and return immediately; errors are caught/logged.
   * Called from the settings change hook (composed with SettingsIngest).
   */
  onFileEvent(relPath: string, kind: SettingsChangeKind): void {
    if (!this.handles(relPath)) return;
    this.queue.push({ relPath, kind });
    void this.processQueue();
  }

  /**
   * Resolve after all queued edits are processed. Used by the projection
   * refresh (Task 6) to ensure pending ingest lands before rendering.
   */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.processing) return;
    await new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const work = this.queue.shift()!;
        try {
          await this.processOne(work.relPath, work.kind);
        } catch (e) {
          console.error(`[memory-note] ingest error for ${work.relPath}:`, e instanceof Error ? e.message : e);
        }
      }
    } finally {
      this.processing = false;
      // Notify anyone waiting on drain()
      const resolvers = this.drainResolvers;
      this.drainResolvers = [];
      for (const r of resolvers) r();
      // If more work arrived during processing, re-enter
      if (this.queue.length > 0) void this.processQueue();
    }
  }

  private async processOne(relPath: string, kind: SettingsChangeKind): Promise<void> {
    if (kind === 'unlink') return; // unlink never changes memories

    // Read the already-indexed memory-note node id + content hash.
    const row = this.deps.db.prepare('SELECT id, content_hash FROM nodes WHERE file_path = ?').get(relPath) as
      | { id: string; content_hash: string }
      | undefined;
    const memoryNoteNodeId = row?.id ?? null;
    const indexedContentHash = row?.content_hash ?? null;

    // Read the raw file content.
    let raw: string;
    try {
      raw = readFileSync(join(this.deps.vaultPath, relPath), 'utf8');
    } catch {
      return; // deleted between event and read; unlink event will follow
    }

    // Parse the whole note.
    const parsed = parseMemoryNote(raw);
    if (!parsed.ok) {
      this.logRejection(memoryNoteNodeId, parsed.errors.map((e) => `line ${e.line}: ${e.message}`));
      return;
    }

    // Validate against the current snapshot.
    const snapshot = this.deps.service.snapshotAll();
    const plan = validateParsedMemoryNote(parsed, snapshot);
    if (!plan.ok) {
      this.logRejection(memoryNoteNodeId, plan.errors.map((e) => `${e.block_key}: ${e.message}`));
      // Receipt the rejected blocks so they don't retry forever on identical input.
      for (const err of plan.errors) {
        const blockKey = err.block_key;
        const editHash = editableMemoryHash({ content: '', category: null, status: 'live' }); // synthetic
        this.recordReceiptSafe(blockKey, `rejected:${err.message}`, { outcome: 'rejected', details: { message: err.message } });
      }
      return;
    }

    // Node-scoped owner drafts are validated as part of the whole-note
    // preflight, before any memory operation may be applied. This keeps an
    // invalid draft from leaving earlier blocks partially applied.
    const draftTargetErrors = this.validateOwnerDraftTargets(plan);
    if (draftTargetErrors.length > 0) {
      this.logRejection(memoryNoteNodeId, draftTargetErrors);
      return;
    }

    // Apply the edit plan.
    await this.applyPlan(plan, parsed, memoryNoteNodeId, indexedContentHash);
  }

  private async applyPlan(
    plan: NoteEditPlan,
    parsed: ParsedMemoryNote,
    memoryNoteNodeId: string | null,
    indexedContentHash: string | null,
  ): Promise<void> {
    for (const op of plan.ops) {
      try {
        await this.applyOp(op, memoryNoteNodeId, indexedContentHash);
      } catch (e) {
        // Runtime failure: log and leave this block unreceipted so a later
        // delivery retries. Earlier successfully receipted blocks remain safe.
        console.error(`[memory-note] apply error for ${op.block_key}:`, e instanceof Error ? e.message : e);
        this.logApplyError(memoryNoteNodeId, op.block_key, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async applyOp(op: EditOp, memoryNoteNodeId: string | null, indexedContentHash: string | null): Promise<void> {
    switch (op.kind) {
      case 'noop':
      case 'absent':
        return; // no-op

      case 'content-or-category': {
        const editHash = editableMemoryHash({
          content: op.after.content,
          category: op.after.category,
          status: op.after.status,
          subjects: op.after.subjects,
        });
        if (this.isAlreadyAppliedOrStale(op, editHash, memoryNoteNodeId)) return;

        // Content/category change → MemoryService.update with note evidence.
        const contentChanged = op.before.content !== op.after.content;
        const evidence: MemoryEvidence | undefined = contentChanged
          ? { kind: 'note', node_id: memoryNoteNodeId ?? undefined, hash: indexedContentHash ?? undefined }
          : undefined;

        // Subjects the owner typed replace the memory's (#554); unchanged ones keep how they were set.
        const subjectsChanged = JSON.stringify(subjectKeys(op.before.subjects ?? [])) !== JSON.stringify(subjectKeys(op.after.subjects ?? []));
        const { result } = await this.deps.service.update({
          id: op.id,
          ...(op.after.content !== op.before.content ? { content: op.after.content } : {}),
          ...(op.after.category !== op.before.category ? { category: op.after.category ?? null } : {}),
          ...(evidence ? { evidence } : {}),
          ...(subjectsChanged ? { subjects: op.after.subjects ?? [], subjects_set_by: 'owner' as const } : {}),
        });

        if (result.ok) {
          this.recordReceiptSafe(op.block_key, editHash, {
            outcome: 'updated',
            source_memory_id: op.id,
            result_memory_id: result.data.id,
          });
        } else {
          throw new Error(`update failed: ${result.error.code} — ${result.error.message}`);
        }
        return;
      }

      case 'expire': {
        const editHash = editableMemoryHash({
          content: op.after.content,
          category: op.after.category,
          status: op.after.status,
          subjects: op.after.subjects,
        });
        if (this.isAlreadyAppliedOrStale(op, editHash, memoryNoteNodeId)) return;

        const { result } = await this.deps.service.expire({
          id: op.id,
          reason: EXPIRE_REASON_OWNER_EDIT,
        });

        if (result.ok) {
          this.recordReceiptSafe(op.block_key, editHash, {
            outcome: result.data.already_expired ? 'noop' : 'expired',
            source_memory_id: op.id,
          });
        } else {
          throw new Error(`expire failed: ${result.error.code} — ${result.error.message}`);
        }
        return;
      }

      case 'reactivate': {
        const editHash = editableMemoryHash({
          content: op.after.content,
          category: op.after.category,
          status: op.after.status,
          subjects: op.after.subjects,
        });
        if (this.isAlreadyAppliedOrStale(op, editHash, memoryNoteNodeId)) return;

        const { result } = await this.deps.service.expire({
          id: op.id,
          reason: EXPIRE_REASON_OWNER_EDIT,
          reactivate: true,
        });

        if (result.ok) {
          this.recordReceiptSafe(op.block_key, editHash, {
            outcome: result.data.already_live ? 'noop' : 'reactivated',
            source_memory_id: op.id,
          });
        } else {
          throw new Error(`reactivate failed: ${result.error.code} — ${result.error.message}`);
        }
        return;
      }

      case 'create-owner': {
        await this.applyCreateOwner(op.block_key, op.draft, memoryNoteNodeId, indexedContentHash);
        return;
      }
    }
  }

  // Task 5: owner-authored additions — kept in the same module per the plan.
  private async applyCreateOwner(
    blockKey: string,
    draft: NewMemoryBlockPayload,
    memoryNoteNodeId: string | null,
    indexedContentHash: string | null,
  ): Promise<void> {
    // Draft validation: non-empty content, status live, scope vault|node,
    // existing node_id when node-scoped. Read-only/source/evidence fields are
    // forbidden (the engine fixes source='owner').
    if (typeof draft.content !== 'string' || draft.content.trim() === '') return;
    if (draft.status !== 'live') return;
    if (draft.scope !== 'vault' && draft.scope !== 'node') return;
    if (draft.scope === 'node' && !draft.node_id) return;

    // Before creation, check any prior receipt for the block key (not only the
    // exact edit hash). A consumed draft key can never mint a second row while
    // waiting for nightly canonicalization.
    const priorReceipts = this.deps.receipts.findByBlockKey(blockKey);
    if (priorReceipts.length > 0) {
      // Already processed — the nightly refresh will canonicalize it.
      return;
    }

    const editHash = editableMemoryHash({
      content: draft.content,
      category: draft.category ?? null,
      status: 'live',
      subjects: draft.subjects,
    });

    const evidence: MemoryEvidence = {
      kind: 'note',
      node_id: memoryNoteNodeId ?? undefined,
      hash: indexedContentHash ?? undefined,
    };

    const { result } = await this.deps.service.create({
      source: 'owner',
      content: draft.content,
      scope: draft.scope,
      ...(draft.node_id ? { node_id: draft.node_id } : {}),
      ...(draft.category ? { category: draft.category } : {}),
      ...(draft.subjects && draft.subjects.length > 0 ? { subjects: draft.subjects, subjects_set_by: 'owner' as const } : {}),
      evidence,
    });

    if (result.ok) {
      this.recordReceiptSafe(blockKey, editHash, {
        outcome: 'created',
        result_memory_id: result.data.id,
      });
    } else if (result.error.code === 'DUPLICATE_MEMORY') {
      // Receipt as duplicate so it doesn't retry forever; surface in the next
      // note issues callout.
      const existingId = result.error.details?.existing_id as number | undefined;
      this.recordReceiptSafe(blockKey, editHash, {
        outcome: 'duplicate',
        result_memory_id: existingId,
        details: { message: result.error.message },
      });
    } else {
      throw new Error(`create-owner failed: ${result.error.code} — ${result.error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** True if this exact edit was receipted, or the DB revision has advanced. */
  private isAlreadyAppliedOrStale(
    op: Extract<EditOp, { id: number; revision: string; block_key: string }>,
    editHash: string,
    memoryNoteNodeId: string | null,
  ): boolean {
    if (this.deps.receipts.find(op.block_key, editHash)) return true;
    const currentRow = this.deps.db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(op.id) as
      | { updated_at: string }
      | undefined;
    if (!currentRow) {
      this.recordReceiptSafe(op.block_key, editHash, {
        outcome: 'conflict', source_memory_id: op.id, details: { marker_revision: op.revision, current_revision: null },
      });
      return true;
    }
    if (currentRow.updated_at !== op.revision) {
      this.logConflict(memoryNoteNodeId, op.block_key, op.revision, currentRow.updated_at);
      this.recordReceiptSafe(op.block_key, editHash, {
        outcome: 'conflict',
        source_memory_id: op.id,
        details: { marker_revision: op.revision, current_revision: currentRow.updated_at },
      });
      return true;
    }
    return false;
  }

  private validateOwnerDraftTargets(plan: NoteEditPlan): string[] {
    const errors: string[] = [];
    const nodeExists = this.deps.db.prepare('SELECT 1 FROM nodes WHERE id = ?');
    for (const op of plan.ops) {
      if (op.kind !== 'create-owner') continue;
      const { draft } = op;
      if (draft.scope === 'vault' && draft.node_id !== null) {
        errors.push(`${op.block_key}: vault-scoped owner drafts must not set node_id`);
      }
      if (draft.scope === 'node' && (!draft.node_id || !nodeExists.get(draft.node_id))) {
        errors.push(`${op.block_key}: node-scoped owner draft requires an existing node_id`);
      }
    }
    return errors;
  }

  private recordReceiptSafe(
    blockKey: string,
    editHash: string,
    input: { outcome: ReceiptOutcome; source_memory_id?: number; result_memory_id?: number; details?: Record<string, unknown> },
  ): void {
    try {
      this.deps.receipts.record({
        block_key: blockKey,
        edit_hash: editHash,
        applied_at: new Date().toISOString(),
        ...input,
      });
    } catch (e) {
      // PK collision means a concurrent caller already receipted — safe.
      console.warn(`[memory-note] receipt collision for ${blockKey}:`, e instanceof Error ? e.message : e);
    }
  }

  private logRejection(nodeId: string | null, messages: string[]): void {
    try {
      this.deps.db.prepare(
        'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
      ).run(nodeId, Date.now(), 'memory-note-rejected', JSON.stringify({
        messages,
        issues: messages.map((message) => ({ block_key: message.match(/^(mem:[^:]+(?::[^:]+)?)/)?.[1] ?? 'note', message })),
      }));
    } catch {
      // best-effort
    }
  }

  private logConflict(nodeId: string | null, blockKey: string, markerRevision: string, currentRevision: string): void {
    try {
      this.deps.db.prepare(
        'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
      ).run(nodeId, Date.now(), 'memory-note-conflict', JSON.stringify({ block_key: blockKey, marker_revision: markerRevision, current_revision: currentRevision }));
    } catch {
      // best-effort
    }
  }

  private logApplyError(nodeId: string | null, blockKey: string, message: string): void {
    try {
      this.deps.db.prepare(
        'INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)',
      ).run(nodeId, Date.now(), 'memory-note-apply-error', JSON.stringify({ block_key: blockKey, message }));
    } catch {
      // best-effort
    }
  }
}

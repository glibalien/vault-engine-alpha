// src/mcp/tools/archive-source.ts
//
// Epic C3+C4: retire a source attachment after verifying its transcript is
// durably persisted. Default: materialize+repoint the transcript into a real
// node, then move the binary into .vault-engine/archive/ (invisible to the
// watcher/indexer and to Obsidian Sync — reversible by moving it back).
// purge:true hard-deletes instead, confirm-gated: undo CANNOT restore a
// binary. Sweep mode runs the same pipeline across all eligible attachments.
//
// Spec: docs/superpowers/specs/2026-06-09-archive-source-design.md

import type Database from 'better-sqlite3';
import { basename, dirname, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { countReferencing, materializeTranscript, transcriptKind } from './materialize-transcript.js';
import type { TranscriptStore, TranscriptRow } from '../../extraction/transcript-store.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import { renderSchemaFile } from '../../schema/render.js';
import { resolveEmbedRef } from '../../extraction/resolve.js';
import { ArchiveLog } from '../../extraction/archive-log.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { ExtractorRegistry } from '../../extraction/registry.js';
import { describePipelineError, ok, fail, type Issue, type ErrorCode } from './errors.js';

export const ARCHIVE_DIR = '.vault-engine/archive';

export type IneligibleReason =
  | 'no_transcript'
  | 'empty_transcript'
  | 'hash_mismatch'
  | 'not_a_file'
  | 'file_missing'
  | 'symlink';

export interface VerifiedSource {
  relPath: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
  rows: TranscriptRow[];
  /** rows' embed_refs + the path + its basename — the repoint/reference set */
  refs: string[];
  embeddingsVerified: boolean;
  referencingNotes: number;
}

export type EligibilityResult =
  | { eligible: true; source: VerifiedSource }
  | { eligible: false; reasons: IneligibleReason[] };

/**
 * The blocking gate of safe-delete: a durable transcript row must exist for
 * EVERY embed-ref spelling of this file, each non-empty and hashing to the
 * live bytes (a file modified after its last extraction would otherwise lose
 * the newer content — the watcher never re-captures on non-md changes).
 * Embedding coverage is reported but NOT blocking: the indexer regenerates
 * extraction embeddings from the retained transcript (Phase 1 fallback).
 */
export function verifyEligibility(
  db: Database.Database,
  vaultPath: string,
  transcriptStore: TranscriptStore,
  relPath: string,
): EligibilityResult {
  const absPath = safeVaultPath(vaultPath, relPath);
  let st;
  try {
    st = lstatSync(absPath);
  } catch {
    return { eligible: false, reasons: ['file_missing'] };
  }
  if (st.isSymbolicLink()) return { eligible: false, reasons: ['symlink'] };
  if (!st.isFile()) return { eligible: false, reasons: ['not_a_file'] };

  const rows = transcriptStore.listByPath(relPath);
  if (rows.length === 0) return { eligible: false, reasons: ['no_transcript'] };

  const reasons: IneligibleReason[] = [];
  if (rows.some(r => r.extracted_text.length === 0)) reasons.push('empty_transcript');
  const liveHash = createHash('sha256').update(readFileSync(absPath)).digest('hex');
  if (rows.some(r => r.content_hash !== liveHash)) reasons.push('hash_mismatch');
  if (reasons.length > 0) return { eligible: false, reasons };

  const refs = Array.from(new Set([...rows.map(r => r.embed_ref), relPath, basename(relPath)]));
  const stmtEmb = db.prepare(
    "SELECT COUNT(*) AS c FROM embedding_meta WHERE source_type = 'extraction' AND extraction_ref = ?",
  );
  const embeddingsVerified = rows.every(
    r => (stmtEmb.get(r.embed_ref) as { c: number }).c > 0,
  );
  const referencingNotes = countReferencing(db, refs);

  return {
    eligible: true,
    source: {
      relPath, absPath,
      bytes: st.size, mtimeMs: st.mtimeMs,
      rows, refs, embeddingsVerified, referencingNotes,
    },
  };
}

// ---------------------------------------------------------------------------
// Core (plain, testable)
// ---------------------------------------------------------------------------

export interface ArchiveDeps {
  db: Database.Database;
  writeLock: WriteLockManager;
  vaultPath: string;
  transcriptStore: TranscriptStore;
  syncLogger?: SyncLogger;
  extractorRegistry?: ExtractorRegistry;
}

export interface SweepParams {
  media_types?: string[];
  dir_prefix?: string;
  min_age_days?: number;
  limit?: number;
}

export interface ArchiveParams {
  embed_ref?: string;
  vault_path?: string;
  sweep?: SweepParams;
  materialize?: boolean;
  purge?: boolean;
  confirm?: boolean;
  dry_run?: boolean;
}

export type ArchiveOutcome =
  | { ok: true; data: Record<string, unknown>; warnings?: Issue[] }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> };

/** Pre-check failure inside the transactional region: carries the envelope. */
class ArchiveAbort extends Error {
  constructor(public readonly outcome: { code: ErrorCode; message: string; details?: Record<string, unknown> }) {
    super(outcome.message);
  }
}

function embeddingsWarning(relPath: string): Issue {
  return {
    code: 'EMBEDDINGS_UNVERIFIED',
    severity: 'warning',
    message: `Extraction-embedding coverage for ${relPath} is missing or incomplete. The retained transcript regenerates embeddings on the next index pass, so archiving is still safe.`,
  };
}

function archiveDestFor(vaultPath: string, relPath: string): { destRel: string; destAbs: string } {
  let destRel = `${ARCHIVE_DIR}/${relPath}`;
  let destAbs = safeVaultPath(vaultPath, destRel);
  if (existsSync(destAbs)) {
    const ext = extname(relPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    destRel = `${ARCHIVE_DIR}/${relPath.slice(0, relPath.length - ext.length)}-${stamp}${ext}`;
    destAbs = safeVaultPath(vaultPath, destRel);
  }
  return { destRel, destAbs };
}

/** A transcript row already materialized into a node that still exists. */
function liveMaterializedNodeId(db: Database.Database, rows: TranscriptRow[]): string | null {
  for (const r of rows) {
    if (r.materialized_node_id && db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(r.materialized_node_id)) {
      return r.materialized_node_id;
    }
  }
  return null;
}

function preflightArchiveMaterialization(
  deps: ArchiveDeps,
  source: VerifiedSource,
  materialize: boolean,
):
  | { ok: true; wouldMaterialize: boolean }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, unknown> } {
  if (!materialize || liveMaterializedNodeId(deps.db, source.rows) !== null) {
    return { ok: true, wouldMaterialize: false };
  }

  const preview = materializeTranscript(
    {
      db: deps.db,
      writeLock: deps.writeLock,
      vaultPath: deps.vaultPath,
      transcriptStore: deps.transcriptStore,
      ...(deps.syncLogger === undefined ? {} : { syncLogger: deps.syncLogger }),
    },
    { embed_ref: source.rows[0].embed_ref, dry_run: true },
  );
  if (!preview.ok) {
    return {
      ok: false,
      code: preview.code as ErrorCode,
      message: preview.message,
      ...(preview.details === undefined ? {} : { details: preview.details }),
    };
  }
  return { ok: true, wouldMaterialize: true };
}

export interface ArchiveItemResult {
  vault_path: string;
  bytes: number;
  mode: 'archive' | 'purge';
  archive_path: string | null;
  materialized_node_id: string | null;
  repointed_notes: number;
  /** IDs of nodes whose embeds were repointed (embedding refresh targets). */
  repointed_node_ids: string[];
}

/**
 * Execute one verified archive. Rollback semantics: everything up to and
 * including the DB transaction is atomic (fs moves are replayed in reverse on
 * throw); the purge unlink runs AFTER commit — the irreversible step goes
 * last, and a failed unlink is reported with the DB state already recorded
 * (re-running is safe: markDeleted is idempotent, archive_log is append-only).
 */
function executeArchiveItem(
  deps: ArchiveDeps,
  archiveLog: ArchiveLog,
  source: VerifiedSource,
  opts: { materialize: boolean; purge: boolean },
  operation_id: string,
): ArchiveItemResult {
  const { db, writeLock, vaultPath, transcriptStore, syncLogger } = deps;
  const fsUndos: Array<() => void> = [];
  const fsRollback = { push: (u: () => void) => fsUndos.push(u) };

  let matNodeId: string | null = null;
  let repointed = 0;
  let repointedNodeIds: string[] = [];
  let schemaCreated: string | null = null; // the transcript kind whose schema the materialize created
  let destRel: string | null = null;

  try {
    const txn = db.transaction(() => {
      if (opts.materialize) {
        matNodeId = liveMaterializedNodeId(db, source.rows);
        if (!matNodeId) {
          const mat = materializeTranscript(
            { db, writeLock, vaultPath, transcriptStore, syncLogger },
            { embed_ref: source.rows[0].embed_ref },
            { operation_id, fsRollback },
          );
          if (!mat.ok) throw new ArchiveAbort({ code: mat.code as ErrorCode, message: mat.message, details: mat.details });
          matNodeId = mat.data.node_id as string;
          repointed = mat.data.references_repointed as number;
          repointedNodeIds = (mat.data.repointed_node_ids as string[] | undefined) ?? [];
          if (mat.data.schema_created === true) schemaCreated = (mat.data.types as string[])[0] ?? null;
        }
      }
      if (!opts.purge) {
        const dest = archiveDestFor(vaultPath, source.relPath);
        destRel = dest.destRel;
        mkdirSync(dirname(dest.destAbs), { recursive: true });
        writeLock.withLockSync(source.absPath, () => {
          renameSync(source.absPath, dest.destAbs);
        });
        fsUndos.push(() => {
          // Mirror executeRename's reverse-rename guard: never clobber a file
          // concurrently recreated at the source path.
          if (existsSync(dest.destAbs) && !existsSync(source.absPath)) {
            renameSync(dest.destAbs, source.absPath);
          }
        });
      }
      transcriptStore.markDeleted(source.relPath);
      archiveLog.record({
        vaultPath: source.relPath,
        contentHash: source.rows[0].content_hash,
        bytes: source.bytes,
        mode: opts.purge ? 'purge' : 'archive',
        archivePath: destRel,
        materializedNodeId: matNodeId,
        operationId: operation_id,
      });
    });
    txn();
  } catch (err) {
    for (let i = fsUndos.length - 1; i >= 0; i--) {
      try { fsUndos[i](); } catch (e) {
        console.error(`[archive-source] fs rollback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw err;
  }

  if (schemaCreated !== null) {
    try {
      renderSchemaFile(db, vaultPath, schemaCreated);
    } catch (err) {
      // Post-commit: the archive already succeeded. The schema file is a
      // rendered view that self-heals on the next propagation — don't turn
      // a successful archive into a false failure.
      console.error(`[archive-source] schema render failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.purge) {
    writeLock.withLockSync(source.absPath, () => {
      // Belt-and-suspenders for the one irreversible step: re-hash the live
      // bytes under the lock and refuse to unlink if they no longer match the
      // verified transcript (closes the verify→purge TOCTOU window). ENOENT
      // means the file is already gone — fall through; unlink tolerates it.
      let liveHash: string | null = null;
      try {
        liveHash = createHash('sha256').update(readFileSync(source.absPath)).digest('hex');
      } catch {
        liveHash = null; // unreadable/missing — let unlink's ENOENT handling decide
      }
      if (liveHash !== null && liveHash !== source.rows[0].content_hash) {
        throw new ArchiveAbort({
          code: 'INTERNAL_ERROR',
          message: `Purge aborted: ${source.relPath} changed on disk after verification — the newer bytes are NOT covered by the retained transcript and were left in place. DB provenance was already recorded; re-run archive-source after re-indexing to retry.`,
          details: { vault_path: source.relPath },
        });
      }
      try {
        unlinkSync(source.absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          throw new ArchiveAbort({
            code: 'INTERNAL_ERROR',
            message: `Purge unlink failed after provenance was recorded (${code}). The transcript is safe; re-running archive-source for this file is safe.`,
            details: { vault_path: source.relPath },
          });
        }
      }
    });
  }

  return {
    vault_path: source.relPath,
    bytes: source.bytes,
    mode: opts.purge ? 'purge' : 'archive',
    archive_path: destRel,
    materialized_node_id: matNodeId,
    repointed_notes: repointed,
    repointed_node_ids: repointedNodeIds,
  };
}

export async function archiveSource(deps: ArchiveDeps, params: ArchiveParams): Promise<ArchiveOutcome> {
  const sweepMode = params.sweep !== undefined;
  const singleKeys = (params.embed_ref !== undefined ? 1 : 0) + (params.vault_path !== undefined ? 1 : 0);
  if (sweepMode && singleKeys > 0) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'sweep is mutually exclusive with embed_ref/vault_path.' };
  }
  if (!sweepMode && singleKeys === 0) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Provide embed_ref, vault_path, or sweep.' };
  }
  if (singleKeys === 2) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Provide exactly one of embed_ref or vault_path.' };
  }

  const purge = params.purge ?? false;
  // With no transcript kind (transcriptType none in the vault map) archiving makes no transcript
  // note unless asked to, and asking is refused: the retained transcript stays searchable.
  const materialize = params.materialize ?? transcriptKind(deps.db) !== null;
  const dryRun = params.dry_run ?? sweepMode; // bulk-effect default: sweep previews unless told otherwise

  if (purge && !dryRun && params.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'purge:true permanently deletes the binary — undo cannot restore it. Pass confirm:true to proceed (or omit purge to use the reversible archive move).',
    };
  }

  if (sweepMode) {
    return runSweep(deps, params.sweep!, { materialize, purge, dryRun });
  }

  // --- single mode ---
  let relPath = params.vault_path ?? null;
  if (!relPath) {
    const row = deps.transcriptStore.getByRef(params.embed_ref!);
    if (row?.vault_path) {
      relPath = row.vault_path;
    } else {
      const resolved = await resolveEmbedRef(deps.db, deps.vaultPath, params.embed_ref!);
      if (!resolved) {
        return {
          ok: false, code: 'NOT_ELIGIBLE',
          message: `Cannot resolve ${params.embed_ref} to a file in the vault.`,
          details: { reasons: ['file_missing'] },
        };
      }
      relPath = relative(deps.vaultPath, resolved.filePath);
    }
  }

  const v = verifyEligibility(deps.db, deps.vaultPath, deps.transcriptStore, relPath);
  if (!v.eligible) {
    return {
      ok: false, code: 'NOT_ELIGIBLE',
      message: `${relPath} is not safe to archive: ${v.reasons.join(', ')}. The transcript gate requires a durable, current transcript for every embed ref of this file.`,
      details: { vault_path: relPath, reasons: v.reasons },
    };
  }

  const warnings: Issue[] = [];
  if (!v.source.embeddingsVerified) warnings.push(embeddingsWarning(relPath));

  if (dryRun) {
    const materialization = preflightArchiveMaterialization(deps, v.source, materialize);
    if (!materialization.ok) return materialization;
    return {
      ok: true,
      data: {
        dry_run: true,
        would_archive: {
          vault_path: relPath,
          bytes: v.source.bytes,
          mode: purge ? 'purge' : 'archive',
          archive_path: purge ? null : archiveDestFor(deps.vaultPath, relPath).destRel,
        },
        referencing_notes: v.source.referencingNotes,
        would_materialize: materialization.wouldMaterialize,
      },
      warnings,
    };
  }

  const archiveLog = new ArchiveLog(deps.db);
  const operation_id = createOperation(deps.db, {
    source_tool: 'archive-source',
    description: `archive-source: ${relPath}${purge ? ' (purge)' : ''}`,
  });
  try {
    const r = executeArchiveItem(deps, archiveLog, v.source, { materialize, purge }, operation_id);
    return { ok: true, data: { archived: r }, warnings };
  } catch (err) {
    if (err instanceof ArchiveAbort) return { ok: false, ...err.outcome };
    const described = describePipelineError(err);
    if (described) return { ok: false, code: described.code, message: described.message, details: described.details };
    return { ok: false, code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) };
  } finally {
    finalizeOperation(deps.db, operation_id);
  }
}

function runSweep(
  deps: ArchiveDeps,
  sweep: SweepParams,
  opts: { materialize: boolean; purge: boolean; dryRun: boolean },
): ArchiveOutcome {
  const { db, vaultPath, extractorRegistry } = deps;
  const minAgeDays = sweep.min_age_days ?? 30;
  const limit = Math.min(sweep.limit ?? 100, 500);
  const mediaTypes = sweep.media_types ?? ['audio'];

  if (extractorRegistry) {
    const status = extractorRegistry.getStatus();
    const known = new Set([...status.active, ...status.unavailable, ...status.disabled].map(e => e.mediaType));
    const unknown = mediaTypes.filter(m => !known.has(m));
    if (unknown.length > 0) {
      return {
        ok: false, code: 'INVALID_PARAMS',
        message: `Unknown media_types: ${unknown.join(', ')}. Known: ${[...known].sort().join(', ')}.`,
      };
    }
  }

  const prefix = sweep.dir_prefix
    ? (sweep.dir_prefix.endsWith('/') ? sweep.dir_prefix : `${sweep.dir_prefix}/`)
    : null;

  // MIN(media_type): one binary has one media type across its ref spellings;
  // GROUP BY needs an aggregate, any row's value would do.
  const all = db.prepare(`
    SELECT vault_path, MIN(media_type) AS media_type
    FROM attachment_transcripts
    WHERE source_deleted = 0 AND vault_path IS NOT NULL
    GROUP BY vault_path
    ORDER BY vault_path
  `).all() as Array<{ vault_path: string; media_type: string }>;

  const filtered = all.filter(c =>
    mediaTypes.includes(c.media_type) && (!prefix || c.vault_path.startsWith(prefix)),
  );
  const candidates = filtered.slice(0, limit);
  const warnings: Issue[] = [];
  if (filtered.length > limit) {
    warnings.push({
      code: 'RESULT_TRUNCATED',
      severity: 'warning',
      message: `Sweep capped at limit (${limit} of ${filtered.length} candidates). Raise \`limit\` or narrow the filters, then run again for the rest.`,
      details: { count: limit, limit, remaining: filtered.length - limit },
    });
  }

  /**
   * Verify + age-check one candidate. Called immediately before use in BOTH
   * paths — in execute mode this keeps the per-item verify→execute window
   * minimal (see the spec's "Known limitation" section).
   */
  const checkItem = (vault_path: string):
    | { kind: 'eligible'; source: VerifiedSource }
    | { kind: 'skipped'; reason: string } => {
    const v = verifyEligibility(db, vaultPath, deps.transcriptStore, vault_path);
    if (!v.eligible) return { kind: 'skipped', reason: v.reasons.join(', ') };
    if (minAgeDays > 0) {
      const ageDays = (Date.now() - v.source.mtimeMs) / 86_400_000;
      if (ageDays < minAgeDays) return { kind: 'skipped', reason: 'too_recent' };
    }
    return { kind: 'eligible', source: v.source };
  };

  const skipped: Array<{ vault_path: string; reason: string }> = [];
  const errors: Array<{ vault_path: string; error: string }> = [];
  let embUnverified = 0;
  const aggregateEmbWarning = (): void => {
    if (embUnverified > 0) {
      warnings.push({
        code: 'EMBEDDINGS_UNVERIFIED',
        severity: 'warning',
        message: `${embUnverified} candidate(s) have missing/incomplete extraction-embedding coverage. The retained transcripts regenerate embeddings on the next index pass; archiving is still safe.`,
        details: { count: embUnverified },
      });
    }
  };

  if (opts.dryRun) {
    const wouldArchive: Array<Record<string, unknown>> = [];
    let wouldReclaim = 0;
    for (const c of candidates) {
      const item = checkItem(c.vault_path);
      if (item.kind === 'skipped') {
        skipped.push({ vault_path: c.vault_path, reason: item.reason });
        continue;
      }
      const s = item.source;
      if (!s.embeddingsVerified) embUnverified += 1;
      const materialization = preflightArchiveMaterialization(deps, s, opts.materialize);
      if (!materialization.ok) {
        errors.push({ vault_path: s.relPath, error: materialization.message });
        continue;
      }
      wouldReclaim += s.bytes;
      wouldArchive.push({
        vault_path: s.relPath,
        bytes: s.bytes,
        refs: s.rows.length,
        referencing_notes: s.referencingNotes,
        would_materialize: materialization.wouldMaterialize,
        embeddings_verified: s.embeddingsVerified,
      });
    }
    aggregateEmbWarning();
    return {
      ok: true,
      data: {
        dry_run: true,
        matched: candidates.length,
        would_archive: wouldArchive,
        skipped,
        errors,
        would_reclaim_bytes: wouldReclaim,
      },
      warnings,
    };
  }

  const archiveLog = new ArchiveLog(db);
  const operation_id = createOperation(db, {
    source_tool: 'archive-source',
    description: `archive-source sweep (limit ${limit})${opts.purge ? ' (purge)' : ''}`,
  });
  const archived: ArchiveItemResult[] = [];
  try {
    for (const c of candidates) {
      // Re-verify immediately before executing each item (spec commitment).
      const item = checkItem(c.vault_path);
      if (item.kind === 'skipped') {
        skipped.push({ vault_path: c.vault_path, reason: item.reason });
        continue;
      }
      if (!item.source.embeddingsVerified) embUnverified += 1;
      try {
        archived.push(executeArchiveItem(deps, archiveLog, item.source, { materialize: opts.materialize, purge: opts.purge }, operation_id));
      } catch (err) {
        const message = err instanceof ArchiveAbort
          ? err.outcome.message
          : (describePipelineError(err)?.message ?? (err instanceof Error ? err.message : String(err)));
        errors.push({ vault_path: c.vault_path, error: message });
      }
    }
  } finally {
    finalizeOperation(db, operation_id);
  }
  aggregateEmbWarning();
  return {
    ok: true,
    data: {
      matched: candidates.length,
      archived,
      skipped,
      errors,
      bytes_reclaimed: archived.reduce((sum, a) => sum + a.bytes, 0),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// MCP registration wrapper
// ---------------------------------------------------------------------------

const sweepShape = z.object({
  media_types: z.array(z.string()).optional().describe("Extractor media types to include (default ['audio']); validated against the extractor registry when available"),
  dir_prefix: z.string().optional().describe('Only attachments under this vault directory (segment-aware prefix, e.g. "Attachments")'),
  min_age_days: z.number().int().min(0).optional().describe('Minimum file age by mtime (default 30)'),
  limit: z.number().int().min(1).max(500).optional().describe('Max candidates per run (default 100, max 500). Each candidate is fully read and hashed synchronously for verification — large limits over big audio files mean seconds of blocking I/O; prefer several smaller runs.'),
});

const paramsShape = {
  embed_ref: z.string().optional().describe('The ![[ref]] string the attachment was embedded as'),
  vault_path: z.string().optional().describe('OR the vault-relative path of the source file; exactly one of embed_ref/vault_path'),
  sweep: sweepShape.optional().describe('Sweep mode: archive every eligible attachment matching these filters (mutually exclusive with embed_ref/vault_path; dry_run defaults TRUE here)'),
  materialize: z.boolean().optional().describe('Materialize the transcript into a real node and repoint embeds first (default true; false when transcriptType is none in Settings/Vault.md)'),
  purge: z.boolean().optional().describe('Hard-delete instead of moving to .vault-engine/archive/ — IRREVERSIBLE, requires confirm:true (default false)'),
  confirm: z.boolean().optional().describe('Required true to actually execute a purge (purge:true with dry_run:false); a purge dry-run preview needs no confirm'),
  dry_run: z.boolean().optional().describe('Preview without writing (default: false single mode, true sweep mode)'),
};

/**
 * Materialized node ids out of either shape archive-source returns: single
 * mode's `{ archived: ArchiveItemResult }` and sweep mode's
 * `{ archived: ArchiveItemResult[] }`. Dry runs report under `would_archive`
 * and so correctly yield nothing.
 */
function materializedNodeIds(data: unknown): string[] {
  const archived = (data as { archived?: unknown } | null)?.archived;
  const items: unknown[] = Array.isArray(archived) ? archived : archived != null ? [archived] : [];
  return items
    .map((i) => (i as ArchiveItemResult).materialized_node_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** All repointed referencing-node IDs across archived item(s). */
function repointedNodeIds(data: unknown): string[] {
  const archived = (data as { archived?: unknown } | undefined)?.archived;
  const items: unknown[] = Array.isArray(archived) ? archived : archived != null ? [archived] : [];
  const ids = new Set<string>();
  for (const i of items) {
    for (const id of (i as ArchiveItemResult).repointed_node_ids ?? []) ids.add(id);
  }
  return [...ids];
}

export function registerArchiveSource(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  transcriptStore: TranscriptStore,
  syncLogger?: SyncLogger,
  extractorRegistry?: ExtractorRegistry,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'archive-source',
    'Safely retire a source attachment whose transcript is durably stored: verifies the retained transcript matches the live file bytes, materializes it into a real transcript node (default on), then moves the binary into .vault-engine/archive/ — invisible to Obsidian Sync, reversible by moving the file back. purge:true hard-deletes instead (confirm-gated; undo cannot restore binaries). Sweep mode (sweep:{media_types,dir_prefix,min_age_days,limit}) (default: audio files older than 30 days) previews/archives all eligible attachments and reports bytes reclaimed.',
    paramsShape,
    async (params) => {
      const outcome = await archiveSource(
        { db, writeLock, vaultPath, transcriptStore, syncLogger, extractorRegistry },
        params as ArchiveParams,
      );
      if (outcome.ok) {
        // T0.3: transcript nodes materialized here are tool-path writes, which
        // emit no watcher event — without this they stay unembedded until the
        // next startup bulk pass (a sweep can materialize hundreds at once).
        // Runs after commit, mirroring registerMaterializeTranscript, so a
        // rolled-back item is never enqueued.
        for (const nodeId of materializedNodeIds(outcome.data)) {
          embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
        }
        // Cycle 5: nodes whose embeds were repointed had their bodies (an
        // embedding input) rewritten — refresh them too.
        for (const nodeId of repointedNodeIds(outcome.data)) {
          embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
        }
        return ok(outcome.data, outcome.warnings ?? []);
      }
      return fail(outcome.code, outcome.message, outcome.details ? { details: outcome.details } : undefined);
    },
  );
}

// src/mcp/tools/materialize-transcript.ts
//
// Phase 2: turn a retained transcript (attachment_transcripts) into a real,
// editable markdown node of the vault map's transcript kind (`transcriptType`,
// in `transcriptDir`) via executeMutation — never the watcher. With the kind
// none, it refuses. Provenance rides as orphan frontmatter (no global-field pool footprint).

import type Database from 'better-sqlite3';
import { basename, extname } from 'node:path';
import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSchemaDefinition, createSchemaDefinition } from '../../schema/crud.js';
import { isSchemaName } from '../../schema/name.js';
import { captureSchemaSnapshot } from '../../undo/schema-snapshot.js';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { sanitizeFilename, checkTitleSafety, type ToolIssue } from './title-warnings.js';
import { titleFromFilename } from '../../parser/parse.js';
import { ContentHashMismatchError, executeMutation } from '../../pipeline/execute.js';
import { renderSchemaFile } from '../../schema/render.js';
import { createOperation, discardOperation, finalizeOperation } from '../../undo/operation.js';
import { preflightRepointEmbedRefs, repointEmbedRefs } from './repoint-embeds.js';
import { ok, fail, adaptIssue, describePipelineError } from './errors.js';
import type { TranscriptStore } from '../../extraction/transcript-store.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { buildContentHashMismatchDetails } from './content-hash-helpers.js';
import { getVaultSettings } from '../../settings/vault.js';

/** A schema display name for a kind: its name with the first letter capitalized ('transcript' → 'Transcript'). */
function displayName(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** The refusal when the vault map turns transcript notes off. */
export const TRANSCRIPTS_OFF_MESSAGE = 'Transcript notes are off: transcriptType is none in Settings/Vault.md. '
  + 'Name the kind transcript notes take to make them; the retained transcript stays searchable meanwhile.';

/** The kind and folder of transcript notes, from the vault map; null when the kind is none. */
export function transcriptKind(db: Database.Database): { type: string; dir: string } | null {
  const { transcriptType, transcriptDir } = getVaultSettings(db);
  return transcriptType === null ? null : { type: transcriptType, dir: transcriptDir };
}

/**
 * The refusal for a transcript kind that can't name a schema, or null when it can. The kind's
 * schema is rendered to `.schemas/<kind>.yaml`, so a name with a path part would write outside
 * that folder, and a name starting with `_` is reserved for Engine's own files there
 * (`isSchemaName`, the rule every new schema follows). Checked here too so the refusal names
 * the setting and comes before any transcript note is written.
 */
function unusableKindMessage(type: string): string | null {
  return !isSchemaName(type)
    ? `transcriptType "${type}" in Settings/Vault.md can't name a kind: a kind name has no slashes, isn't "." or "..", and doesn't start with "_".`
    : null;
}

/**
 * Ensure a thin schema for the transcript kind exists (default_directory only, no field
 * claims — provenance is carried as orphan fields). Created under the given
 * undo operation so it is reversible. Returns { created } so the caller can
 * render the schema file only when it was newly made. Does NOT write the
 * schema file itself (caller renders post-commit to avoid orphan-on-rollback).
 */
export function ensureTranscriptSchema(
  db: Database.Database,
  operationId: string,
  kind: { type: string; dir: string },
): { created: boolean } {
  if (getSchemaDefinition(db, kind.type)) return { created: false };

  const tx = db.transaction(() => {
    captureSchemaSnapshot(db, operationId, kind.type, { was_new: true });
    createSchemaDefinition(db, {
      name: kind.type,
      display_name: displayName(kind.type),
      default_directory: kind.dir,
      field_claims: [],
    });
    db.prepare('UPDATE undo_operations SET schema_count = schema_count + 1 WHERE operation_id = ?')
      .run(operationId);
  });
  tx();
  return { created: true };
}

// ---------------------------------------------------------------------------
// Core function (plain, testable)
// ---------------------------------------------------------------------------

export interface MaterializeDeps {
  db: Database.Database;
  writeLock: WriteLockManager;
  vaultPath: string;
  transcriptStore: TranscriptStore;
  syncLogger?: SyncLogger;
}

export interface MaterializeParams {
  embed_ref?: string;
  vault_path?: string;
  directory?: string;
  title?: string;
  repoint?: boolean;
  dry_run?: boolean;
}

export type MaterializeOutcome =
  | { ok: true; data: Record<string, unknown>; warnings?: ToolIssue[] }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/** Composition context: run under the caller's undo operation + fs rollback
 * queue. When provided, materializeTranscript does NOT create/finalize an
 * operation, does NOT replay fs undos or envelope thrown errors (it rethrows —
 * the caller owns rollback), and does NOT render the schema file (the caller
 * renders post-commit using data.schema_created). */
export interface MaterializeRunCtx {
  operation_id: string;
  fsRollback: { push(undo: () => void): void };
}

/** Count nodes indexed as wiki-linking to any supplied ref. */
export function countReferencing(db: Database.Database, refs: Array<string | null>): number {
  const distinct = Array.from(new Set(refs.filter((r): r is string => !!r)));
  if (distinct.length === 0) return 0;
  const placeholders = distinct.map(() => '?').join(',');
  return (db.prepare(
    `SELECT COUNT(DISTINCT source_id) c FROM relationships WHERE target IN (${placeholders}) AND rel_type = 'wiki-link'`,
  ).get(...distinct) as { c: number }).c;
}

export function materializeTranscript(
  deps: MaterializeDeps,
  params: MaterializeParams,
  runCtx?: MaterializeRunCtx,
): MaterializeOutcome {
  const { db, writeLock, vaultPath, transcriptStore, syncLogger } = deps;
  const { embed_ref, vault_path, directory, title: titleOverride, repoint = true, dry_run = false } = params;

  if ((!embed_ref && !vault_path) || (embed_ref && vault_path)) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Provide exactly one of embed_ref or vault_path.' };
  }
  const kind = transcriptKind(db);
  if (kind === null) return { ok: false, code: 'INVALID_PARAMS', message: TRANSCRIPTS_OFF_MESSAGE };
  const unusable = unusableKindMessage(kind.type);
  if (unusable !== null) return { ok: false, code: 'INVALID_PARAMS', message: unusable };

  const row = embed_ref ? transcriptStore.getByRef(embed_ref) : transcriptStore.getByPath(vault_path!);
  if (!row) {
    return { ok: false, code: 'NOT_FOUND', message: `No retained transcript for ${embed_ref ?? vault_path}.` };
  }

  if (row.materialized_node_id) {
    const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(row.materialized_node_id);
    if (exists) {
      return {
        ok: false,
        code: 'ALREADY_MATERIALIZED',
        message: `Transcript already materialized as node ${row.materialized_node_id}.`,
        details: { node_id: row.materialized_node_id },
      };
    }
  }

  const sourceRef = row.embed_ref;
  const base = basename(sourceRef, extname(sourceRef)) || basename(sourceRef);
  const title = titleOverride ?? base;
  const dir = directory ?? kind.dir;
  const sanitize = sanitizeFilename(`${title}.md`);
  const fileName = sanitize.filename;
  const warnings: ToolIssue[] = [...checkTitleSafety(title)];
  if (sanitize.sanitized) {
    warnings.push({
      code: 'TITLE_FILENAME_SANITIZED',
      message: `Title contains filename-reserved characters; replaced with '-' in the filename, which is also the stored title: ${sanitize.characters.join(' ')}`,
      characters: sanitize.characters,
    });
  }
  const filePath = dir ? `${dir}/${fileName}` : fileName;
  const absPath = safeVaultPath(vaultPath, filePath); // guards traversal; reuse the validated absolute path
  // Embeds are repointed to the stored title — the filename's — so they resolve by filename.
  const storedTitle = titleFromFilename(filePath);

  const existingNode = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as { id: string; title: string } | undefined;
  const diskConflict = existsSync(absPath);
  if (existingNode || diskConflict) {
    return { ok: false, code: 'INVALID_PARAMS', message: `File path "${filePath}" already exists. Pass a different title or directory.` };
  }

  const repointRefs: Array<string | null> = [sourceRef, row.vault_path];

  if (dry_run) {
    let repointTargets = 0;
    if (repoint) {
      try {
        repointTargets = preflightRepointEmbedRefs(db, vaultPath, repointRefs, storedTitle);
      } catch (err) {
        return materializeErrorOutcome(db, err);
      }
    }
    return {
      ok: true,
      data: {
        dry_run: true,
        would_create: {
          file_path: filePath,
          title: storedTitle,
          types: [kind.type],
          source_deleted: row.source_deleted === 1,
          would_ensure_schema: getSchemaDefinition(db, kind.type) === null,
          repoint,
          repoint_targets: repointTargets,
        },
      },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const operation_id = runCtx?.operation_id ?? createOperation(db, {
    source_tool: 'materialize-transcript',
    description: `materialize-transcript: '${title}'`,
  });
  const fsUndos: Array<() => void> = [];
  const fsRollback = runCtx?.fsRollback ?? { push: (u: () => void) => fsUndos.push(u) };
  let discardEmptyOperation = false;
  let committed = false;

  const fields: Record<string, unknown> = {
    source: sourceRef,
    captured_at: row.captured_at,
    media_type: row.media_type,
    extractor_id: row.extractor_id,
    source_deleted: row.source_deleted === 1,
    content_hash: row.content_hash,
  };

  try {
    let schemaCreated = false;
    let nodeId = '';
    let refsUpdated = 0;
    let repointedNodeIds: string[] = [];
    const txn = db.transaction(() => {
      schemaCreated = ensureTranscriptSchema(db, operation_id, kind).created;
      const created = executeMutation(db, writeLock, vaultPath, {
        source: 'tool',
        node_id: null,
        file_path: filePath,
        title,
        types: [kind.type],
        fields,
        body: row.extracted_text,
      }, syncLogger, { operation_id }, fsRollback);
      nodeId = created.node_id;
      if (repoint) {
        const repointed = repointEmbedRefs(db, writeLock, vaultPath, repointRefs, storedTitle, nodeId, syncLogger, { operation_id }, fsRollback);
        refsUpdated = repointed.updated;
        repointedNodeIds = repointed.changedNodeIds;
      }
      transcriptStore.markMaterialized(row.embed_ref, nodeId);
    });
    txn();
    committed = true;

    if (schemaCreated && !runCtx) renderSchemaFile(db, vaultPath, kind.type);

    return {
      ok: true,
      data: {
        node_id: nodeId,
        file_path: filePath,
        title: storedTitle,
        types: [kind.type],
        source_deleted: row.source_deleted === 1,
        references_repointed: refsUpdated,
        // Cycle 5: nodes whose bodies were rewritten by the repoint — the
        // top-level caller enqueues them for embedding after commit.
        repointed_node_ids: repointedNodeIds,
        schema_created: schemaCreated,
      },
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    if (runCtx) throw err; // caller owns rollback replay and error envelope
    if (!committed) {
      for (let i = fsUndos.length - 1; i >= 0; i--) {
        try { fsUndos[i](); } catch (e) {
          console.error(`[materialize-transcript] fs rollback failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (err instanceof ContentHashMismatchError) discardEmptyOperation = err.currentHash === null;
    return materializeErrorOutcome(db, err);
  } finally {
    if (!runCtx) {
      if (discardEmptyOperation) discardOperation(db, operation_id);
      else finalizeOperation(db, operation_id);
    }
  }
}

function materializeErrorOutcome(
  db: Database.Database,
  err: unknown,
): Extract<MaterializeOutcome, { ok: false }> {
  if (err instanceof ContentHashMismatchError) {
    return {
      ok: false,
      code: 'CONTENT_HASH_MISMATCH',
      message: `Node ${err.nodeId} changed on disk since you read it — reload or overwrite.`,
      details: buildContentHashMismatchDetails(db, err),
    };
  }
  const described = describePipelineError(err);
  if (described) {
    return { ok: false, code: described.code, message: described.message, details: described.details };
  }
  return { ok: false, code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// MCP registration wrapper
// ---------------------------------------------------------------------------

const paramsShape = {
  embed_ref: z.string().optional().describe('The ![[ref]] string the attachment was embedded as'),
  vault_path: z.string().optional().describe("OR the vault-relative path of the source file; exactly one of embed_ref/vault_path"),
  directory: z.string().optional().describe('Override the transcript folder (transcriptDir in Settings/Vault.md; Transcripts/ by default)'),
  title: z.string().optional().describe('Override the derived title (default: source filename without extension)'),
  repoint: z.boolean().optional().describe("Rewrite referencing notes' embeds to point at the new node (default true)"),
  dry_run: z.boolean().optional().describe('Preview without writing (default false)'),
};

export function registerMaterializeTranscript(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  transcriptStore: TranscriptStore,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'materialize-transcript',
    "Turn a retained transcript (see list-transcripts) into a real, editable markdown transcript node. Provenance (source, captured_at, media_type, extractor_id, source_deleted, content_hash) is written as frontmatter; the transcript text becomes the body. By default repoints referencing notes' embeds at the new node. Use dry_run:true to preview.",
    paramsShape,
    async (params) => {
      const outcome = materializeTranscript(
        { db, writeLock, vaultPath, transcriptStore, syncLogger },
        params,
      );
      if (outcome.ok) {
        // T0.3: a real node was created on the live path (dry-run returns no
        // top-level node_id); enqueue it for embedding (tool writes skip the
        // watcher). Cycle 5: also enqueue every node whose body the repoint
        // rewrote — their embedding inputs changed too.
        const newNodeId = (outcome.data as { node_id?: string }).node_id;
        if (newNodeId) embeddingIndexer?.enqueue({ node_id: newNodeId, source_type: 'node' });
        const repointedIds = (outcome.data as { repointed_node_ids?: string[] }).repointed_node_ids ?? [];
        for (const id of repointedIds) {
          embeddingIndexer?.enqueue({ node_id: id, source_type: 'node' });
        }
        return ok(outcome.data, (outcome.warnings ?? []).map(adaptIssue));
      }
      return fail(outcome.code as Parameters<typeof fail>[0], outcome.message, outcome.details ? { details: outcome.details } : undefined);
    },
  );
}

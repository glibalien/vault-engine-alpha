import { readReferencePolicyVersion } from '../../db/reference-policy-version.js';
import { buildReferenceWarnings } from '../../resolver/diagnostics.js';
import { collectStoredReferenceDiagnostics, recheckInboundDiagnostics, type ReferenceDiagnostic } from '../../pipeline/diagnostics.js';
// src/mcp/tools/batch-mutate.ts

import { createFieldMap } from '../../fields/field-map.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fieldRecordSchema } from '../field-record-schema.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { resolveDirectory, resolveFilename } from '../../schema/paths.js';
import { ok, fail, adaptIssue, type Issue } from './errors.js';
import { checkTitleSafety, checkBodyFrontmatter, sanitizeFilename } from './title-warnings.js';
import { titleFromFilename } from '../../parser/parse.js';
import { memoryNoteEditRefusal, resolveNodeIdentity, settingsNoteEditRefusal } from './resolve-identity.js';
import { toolCaller } from '../../auth/client-label.js';
import { assertRenameReferenceFilesPresent, executeRename } from './rename-node.js';
import {
  assertToolMutationFilePresent,
  ContentHashMismatchError,
  executeMutation,
  repairInboundLinks,
  StaleNodeError,
} from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { backupFile, restoreFile, cleanupBackups } from '../../pipeline/file-writer.js';
import { executeDeletion } from '../../pipeline/delete.js';
import { notifyToolWrite } from '../../settings/hook.js';
import { captureDeletionReferences, countUnresolvedReferences, type ReferenceKey } from '../../pipeline/delete-references.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { buildFixable } from '../../validation/fixable.js';
import { typeKeyFieldIssue } from '../../validation/type-key-field.js';
import { typeKey } from '../../parser/type-key.js';
import { createOperation, discardOperation, finalizeOperation } from '../../undo/operation.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { buildStaleNodeDetails } from './stale-helpers.js';
import { buildContentHashMismatchEnvelope } from './content-hash-helpers.js';

const createParamsSchema = z.object({
  title: z.string(),
  types: z.array(z.string()).optional(),
  fields: fieldRecordSchema(z.unknown()).optional(),
  body: z.string().optional(),
  directory: z.string().optional(),
  override_default_directory: z.boolean().optional(),
  path: z.string().optional().describe('DEPRECATED — use `directory`. Will be removed in a future release.'),
}).strict();

const updateParamsSchema = z.object({
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),
  add_types: z.array(z.string()).optional(),
  remove_types: z.array(z.string()).optional(),
  set_fields: fieldRecordSchema(z.unknown()).optional(),
  set_body: z.string().optional(),
  append_body: z.string().optional(),
  expected_version: z.number().int().min(1).optional(),
}).strict();

const deleteParamsSchema = z.object({
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  expected_version: z.number().int().min(1).optional(),
}).strict();

const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), params: createParamsSchema }),
  z.object({ op: z.literal('update'), params: updateParamsSchema }),
  z.object({ op: z.literal('delete'), params: deleteParamsSchema }),
]);

const paramsShape = {
  operations: z.array(operationSchema),
  dry_run: z.boolean().default(false),
};

type WouldApplyEntry =
  | { op: 'create'; node_id: string; file_path: string; title: string }
  | {
      op: 'update';
      node_id: string;
      file_path: string;
      fields_changed: string[];
      types_after?: string[];
      body_changed: boolean;
      title_changed: boolean;
    }
  | {
      op: 'delete';
      node_id: string;
      file_path: string;
      incoming_reference_count: number;
      unresolved_reference_count: number;
      referencing_nodes: Array<{ node_id: string; title: string; file_path: string }>;
    };

class DryRunRollback extends Error {
  constructor() {
    super('DryRunRollback');
    this.name = 'DryRunRollback';
  }
}

export function registerBatchMutate(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'batch-mutate',
    'Execute multiple mutation operations atomically. All operations succeed or all roll back. Rename is not supported in batch. '
      + `A note's types go in a create op's types and an update op's set_types, add_types or remove_types, never in fields or set_fields: "${typeKey()}" is the frontmatter key that holds them. `
      + 'Create ops use schema default_directory when directory is omitted — pass override_default_directory: true to place elsewhere. The legacy path alias is deprecated; use directory. Use dry_run: true to preview the entire batch atomically (composed effects via SAVEPOINT-style rollback) without applying. Delete ops report references left unresolved by the final composed state (would_apply unresolved_reference_count; results dangling_references).',
    paramsShape,
    async (params, extra) => {
      const caller = toolCaller(extra);
      const results: Array<{
        op: string;
        op_index: number;
        status: 'applied' | 'stale';
        node_id: string;
        file_path?: string;
        new_version?: number;
        dangling_references?: number;
        details?: Record<string, unknown>;
      }> = [];
      const tmpDir = join(vaultPath, '.vault-engine', 'tmp');
      const warnings: Issue[] = [];
      // A source is attributed to its last direct operation, or the rename
      // that first rewrote it. Resolve only after the complete batch is composed.
      const referenceSources = new Map<string, number>();
      // Other nodes' typed references an operation left unresolved, by operation index;
      // re-checked against the final state once every operation has run.
      const inboundReferences: ReferenceDiagnostic[] = [];
      const addInbound = (diagnostics: readonly ReferenceDiagnostic[], nodeId: string, opIndex: number) => {
        for (const diagnostic of diagnostics) {
          if (diagnostic.sourceId !== nodeId) inboundReferences.push({ ...diagnostic, opIndex });
        }
      };
      let referenceWarnings: Issue[] = [];
      const responseWarnings = () => [...warnings, ...referenceWarnings];
      // Tag a warning with the index of the op that produced it, so callers can
      // attribute flat-array warnings back to a specific operation.
      const addOpWarning = (issue: Issue, opIndex: number) => {
        warnings.push({ ...issue, op_index: opIndex });
      };

      // Track file state for rollback: files that existed before (backed up)
      // and files that were created new (to be deleted on rollback)
      const backups: Array<{ filePath: string; backupPath: string }> = [];
      const createdFiles: string[] = [];
      // Reverse-renames for set_title moves, replayed before backups are
      // restored (the backup was taken at the pre-rename path).
      const fsUndos: Array<() => void> = [];
      // Track node IDs deleted in this batch so we can clean up vec rows after commit.
      const deletedNodeIds: string[] = [];
      const deletedFilePaths: string[] = [];
      // Node IDs to enqueue for embedding AFTER the transaction commits
      // (cycle 5: never enqueue from inside the txn — a rollback would
      // otherwise leave a refresh queued for content that never landed).
      const pendingEmbedEnqueues = new Set<string>();
      // Created/renamed nodes whose inbound near-miss links are repaired once
      // the batch has committed: each repair is its own best-effort write, so
      // a batch rollback never has to unwind one.
      const linkRepairNodeIds = new Set<string>();

      let batchError: { failed_at: number; op: string; message: string; details: Record<string, unknown> } | null = null as { failed_at: number; op: string; message: string; details: Record<string, unknown> } | null;
      let contentHashMismatch: unknown;
      let discardEmptyOperation = false;
      let committed = false;

      const dryRun = params.dry_run;
      const mutationLogger = dryRun ? undefined : syncLogger;
      const operation_id: string | undefined = dryRun ? undefined : createOperation(db, {
        source_tool: 'batch-mutate',
        description: `batch-mutate: ${params.operations.length} ops (${countKinds(params.operations)})`,
      });

      const would_apply: WouldApplyEntry[] = [];
      const previewCreatedNodeIds = new Set<string>();
      const previewDiskHashes = new Map<string, string>();
      const previewKeyOrders = new Map<string, readonly string[]>();
      const previewContents = new Map<string, string>();
      const recordPreview = (nodeId: string, result: { rendered_hash: string; rendered_key_order?: string[]; rendered_content?: string }) => {
        previewDiskHashes.set(nodeId, result.rendered_hash);
        if (result.rendered_key_order !== undefined) previewKeyOrders.set(nodeId, result.rendered_key_order);
        if (result.rendered_content !== undefined) previewContents.set(nodeId, result.rendered_content);
      };
      // Deletions report references left unresolved by the final composed
      // state, so a later op that restores a namesake is accounted for.
      const deletionReferences: Array<{ keys: ReferenceKey[]; report: (unresolved: number) => void }> = [];

      const txn = db.transaction(() => {
        // Preview identities may move; presence guards still inspect the actual
        // pre-preview projection instead of a path that exists only in SQLite.
        const projectionPaths = new Map((db.prepare('SELECT id, file_path FROM nodes').all() as Array<{ id: string; file_path: string }>).map(row => [row.id, row.file_path]));
        // A dry run never moves or unlinks files, so a path an earlier preview op
        // vacated still exists on disk. Callers check the composed DB first, so
        // an indexed projection path reaching this check is one apply will have
        // freed by then; unindexed files on disk still count as occupied.
        const projectionOccupied = new Set(projectionPaths.values());
        const occupiedOnDisk = (filePath: string): boolean =>
          existsSync(safeVaultPath(vaultPath, filePath)) && !(dryRun && projectionOccupied.has(filePath));
        for (let i = 0; i < params.operations.length; i++) {
          const { op, params: opParams } = params.operations[i];

          try {
            if (op === 'create') {
              const title = opParams.title;
              const types = opParams.types ?? [];
              const fields = opParams.fields ?? {};
              const body = opParams.body ?? '';
              refuseTypeKeyField(fields, 'batch-create');

              // Directory param reconciliation: `path` is a deprecated alias for `directory`.
              if (opParams.path !== undefined && opParams.directory !== undefined) {
                throw new PipelineError(
                  'INVALID_PARAMS',
                  "Do not supply both 'path' and 'directory' on a create op. 'path' is deprecated — use 'directory'.",
                );
              }
              let directoryParam = opParams.directory;
              if (opParams.path !== undefined && opParams.directory === undefined) {
                directoryParam = opParams.path;
                addOpWarning({
                  severity: 'warning',
                  code: 'DEPRECATED_PARAM',
                  message: "Param 'path' is deprecated in batch-mutate create; use 'directory' instead.",
                }, i);
              }
              const override_default_directory = opParams.override_default_directory ?? false;

              // Type-schema check
              const typeCheck = checkTypesHaveSchemas(db, types);
              if (!typeCheck.valid) {
                throw new PipelineError('UNKNOWN_TYPE',
                  `Cannot create node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
              }

              const dirResult = resolveDirectory(db, { types, directory: directoryParam, override_default_directory });
              if (!dirResult.ok) throw new PipelineError(dirResult.code, dirResult.message);

              // Honor the schema's filename_template (parity with create-node).
              const fnResult = resolveFilename(db, { types, title, fields });
              if (!fnResult.ok) throw new PipelineError(fnResult.code, fnResult.message);
              const sanitize = sanitizeFilename(fnResult.fileName);
              if (sanitize.sanitized) {
                addOpWarning(adaptIssue({
                  code: 'TITLE_FILENAME_SANITIZED',
                  message: `Title contains filename-reserved characters; replaced with '-' in the filename, which is also the stored title: ${sanitize.characters.join(' ')}`,
                  characters: sanitize.characters,
                }), i);
              }
              for (const issue of checkTitleSafety(title)) addOpWarning(adaptIssue(issue), i);
              for (const issue of checkBodyFrontmatter(body)) addOpWarning(adaptIssue(issue), i);

              const filePath = dirResult.directory ? `${dirResult.directory}/${sanitize.filename}` : sanitize.filename;
              const absPath = safeVaultPath(vaultPath, filePath);
              const memoryNoteRefusal = memoryNoteEditRefusal(vaultPath, filePath, caller);
              if (memoryNoteRefusal !== null) throw new PipelineError('INVALID_PARAMS', memoryNoteRefusal);

              const existing = db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(filePath);
              if (existing || occupiedOnDisk(filePath)) {
                throw new PipelineError('INVALID_PARAMS', `File path "${filePath}" already exists`);
              }

              const result = executeMutation(db, writeLock, vaultPath, {
                source: 'tool',
                node_id: null,
                file_path: filePath,
                title,
                types,
                fields,
                body,
                deferLinkRepair: true,
                ...(dryRun ? { db_only: true } : {}),
              }, mutationLogger, operation_id ? { operation_id } : undefined);
              if (!dryRun) linkRepairNodeIds.add(result.node_id);
              referenceSources.set(result.node_id, i);
              addInbound(result.referenceDiagnostics, result.node_id, i);
              if (!dryRun && result.file_written) createdFiles.push(absPath);
              // T0.3: enqueue the created node for embedding on the committed
              // path only (dry-run writes are db_only and rolled back).
              if (!dryRun) pendingEmbedEnqueues.add(result.node_id);
              const newVersion = getNodeVersion(db, result.node_id);
              results.push({ op: 'create', op_index: i, status: 'applied', node_id: result.node_id, file_path: result.file_path, new_version: newVersion });
              if (dryRun) {
                previewCreatedNodeIds.add(result.node_id);
                recordPreview(result.node_id, result);
                would_apply.push({
                  op: 'create',
                  node_id: result.node_id,
                  file_path: result.file_path,
                  title: titleFromFilename(result.file_path),
                });
              }

            } else if (op === 'update') {
              refuseTypeKeyField(opParams.set_fields, 'batch-update');
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id,
                file_path: opParams.file_path,
                title: opParams.title,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const settingsRefusal = settingsNoteEditRefusal(node.file_path) ?? memoryNoteEditRefusal(vaultPath, node.file_path, caller);
              if (settingsRefusal !== null) throw new PipelineError('INVALID_PARAMS', settingsRefusal);
              const absPath = join(vaultPath, node.file_path);

              if (dryRun && !previewCreatedNodeIds.has(node.node_id)) {
                assertToolMutationFilePresent(db, vaultPath, {
                  source: 'tool',
                  node_id: node.node_id,
                  file_path: projectionPaths.get(node.node_id) ?? node.file_path,
                  db_only: false,
                });
              }

              // Back up the existing file before mutation (skip in dry-run — file is never written)
              if (!dryRun) {
                const bp = backupFile(absPath, tmpDir);
                if (bp) backups.push({ filePath: absPath, backupPath: bp });
              }

              const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
                .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);
              const currentFields = createFieldMap<unknown>();
              const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
                .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
              for (const row of fieldRows) currentFields[row.field_name] = reconstructValue(row);
              const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

              // Fields
              const finalFields = createFieldMap(currentFields);
              if (opParams.set_fields) {
                for (const [key, value] of Object.entries(opParams.set_fields)) {
                  finalFields[key] = value; // null passes through as deletion intent
                }
              }

              // Types: set_types wins outright, otherwise apply add/remove
              let finalTypes: string[];
              if (opParams.set_types !== undefined) {
                finalTypes = opParams.set_types;
              } else {
                finalTypes = [...currentTypes];
                if (opParams.add_types) {
                  for (const t of opParams.add_types) {
                    if (!finalTypes.includes(t)) finalTypes.push(t);
                  }
                }
                if (opParams.remove_types) {
                  finalTypes = finalTypes.filter(t => !opParams.remove_types!.includes(t));
                }
              }

              const hasTypeOp = opParams.set_types !== undefined || opParams.add_types !== undefined || opParams.remove_types !== undefined;
              if (hasTypeOp) {
                const typeCheck = checkTypesHaveSchemas(db, finalTypes);
                if (!typeCheck.valid) {
                  throw new PipelineError('UNKNOWN_TYPE',
                    `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Available: ${typeCheck.available.join(', ')}`);
                }
              }

              // Body: set_body and append_body are mutually exclusive
              if (opParams.set_body !== undefined && opParams.append_body !== undefined) {
                throw new PipelineError('INVALID_PARAMS', 'set_body and append_body are mutually exclusive');
              }
              let finalBody = currentBody;
              if (opParams.set_body !== undefined) {
                finalBody = opParams.set_body;
              } else if (opParams.append_body !== undefined) {
                finalBody = currentBody ? `${currentBody}\n\n${opParams.append_body}` : opParams.append_body;
              }

              // A changed title must move the file too — nodes.title is derived
              // from the filename (parser/parse.ts), so writing one without the
              // other desyncs them and silently breaks every title-derived
              // wikilink. Mirrors update-node.ts: mutate in place at the old
              // path, then executeRename moves the file and rewrites inbound
              // references.
              const newTitle = opParams.set_title ?? node.title;
              const titleChanged = opParams.set_title !== undefined && opParams.set_title !== node.title;
              let renamedFilePath: string | null = null;
              if (titleChanged) {
                const sanitize = sanitizeFilename(`${newTitle}.md`);
                const currentDir = dirname(node.file_path);
                const target = currentDir === '.' ? sanitize.filename : `${currentDir}/${sanitize.filename}`;
                if (target !== node.file_path) {
                  safeVaultPath(vaultPath, target); // throws on path traversal
                  const destinationRefusal = memoryNoteEditRefusal(vaultPath, target, caller);
                  if (destinationRefusal !== null) throw new PipelineError('INVALID_PARAMS', destinationRefusal);
                  const dbConflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?')
                    .get(target) as { id: string; title: string } | undefined;
                  if (dbConflict && dbConflict.id !== node.node_id) {
                    throw new PipelineError('CONFLICT',
                      `Cannot rename — file "${target}" already exists (node: ${dbConflict.title})`);
                  }
                  if (occupiedOnDisk(target)) {
                    throw new PipelineError('CONFLICT', `Cannot rename — file "${target}" already exists on disk`);
                  }
                  renamedFilePath = target;
                }
                if (sanitize.sanitized) {
                  addOpWarning(adaptIssue({
                    code: 'TITLE_FILENAME_SANITIZED',
                    message: `Title contains filename-reserved characters; replaced with '-' in the filename, which is also the stored title: ${sanitize.characters.join(' ')}`,
                    characters: sanitize.characters,
                  }), i);
                }
                for (const issue of checkTitleSafety(newTitle)) addOpWarning(adaptIssue(issue), i);
              }

              const result = executeMutation(db, writeLock, vaultPath, {
                source: 'tool',
                node_id: node.node_id,
                file_path: node.file_path,
                title: node.title,
                types: finalTypes,
                fields: finalFields,
                touchedFields: Object.keys(opParams.set_fields ?? {}),
                body: finalBody,
                deferLinkRepair: true,
                ...(dryRun ? {
                  db_only: true,
                  previewDiskContentHash: previewDiskHashes.get(node.node_id),
                  previewKeyOrder: previewKeyOrders.get(node.node_id),
                  previewContent: previewContents.get(node.node_id),
                } : {}),
                expectedVersion: opParams.expected_version,
              }, mutationLogger, operation_id ? { operation_id } : undefined);


              if (dryRun) recordPreview(result.node_id, result);

              // Dry-run never touches the filesystem; the conflict checks above
              // still ran, so a preview surfaces the same CONFLICT a commit would.
              if ((renamedFilePath || (titleChanged && readReferencePolicyVersion(db) === 2)) && dryRun) {
                assertRenameReferenceFilesPresent(
                  db,
                  vaultPath,
                  node.node_id,
                  node.title,
                  newTitle,
                  previewCreatedNodeIds,
                  renamedFilePath ?? node.file_path,
                  projectionPaths,
                );
              }
              if (renamedFilePath || (titleChanged && readReferencePolicyVersion(db) === 2)) {
                const renamed = executeRename(
                  db, writeLock, vaultPath,
                  { node_id: node.node_id, file_path: node.file_path, title: node.title },
                  newTitle, renamedFilePath ?? node.file_path, mutationLogger,
                  operation_id ? { operation_id } : undefined,
                  { push: (u) => fsUndos.push(u) },
                  undefined, dryRun ? { diskHashes: previewDiskHashes, keyOrders: previewKeyOrders, contents: previewContents } : undefined,
                  true,
                );
                if (!dryRun) linkRepairNodeIds.add(node.node_id);
                // Cycle 5: referencing nodes whose fields/body were rewritten
                // by the rename are embedding inputs too.
                for (const changedId of renamed.changedNodeIds) {
                  if (!dryRun) pendingEmbedEnqueues.add(changedId);
                  if (!referenceSources.has(changedId)) referenceSources.set(changedId, i);
                }
                addInbound(renamed.inboundDiagnostics, node.node_id, i);
                result.file_path = renamedFilePath ?? node.file_path;
              }
              // A title that sanitizes to the current filename changes nothing:
              // the stored title is always the filename's (pipeline/execute.ts).
              referenceSources.set(result.node_id, i);
              addInbound(result.referenceDiagnostics, result.node_id, i);

              // T0.3: enqueue the updated node for re-embedding on the committed
              // path only (dry-run writes are db_only and rolled back).
              if (!dryRun) pendingEmbedEnqueues.add(result.node_id);
              const newVersion = getNodeVersion(db, result.node_id);
              results.push({ op: 'update', op_index: i, status: 'applied', node_id: result.node_id, file_path: result.file_path, new_version: newVersion });

              if (dryRun) {
                // Rename has already recorded its final composed render hash.
                // Compute change-indicators by diffing against pre-update DB state we already loaded.
                const fields_changed: string[] = [];
                const allKeys = new Set([
                  ...Object.keys(currentFields),
                  ...Object.keys(finalFields),
                ]);
                for (const k of allKeys) {
                  const before = currentFields[k];
                  const after = finalFields[k];
                  if (JSON.stringify(before) !== JSON.stringify(after)) fields_changed.push(k);
                }
                const typesChanged = JSON.stringify([...currentTypes].sort()) !== JSON.stringify([...finalTypes].sort());
                const entry: WouldApplyEntry = {
                  op: 'update',
                  node_id: result.node_id,
                  file_path: result.file_path,
                  fields_changed,
                  body_changed: finalBody !== currentBody,
                  title_changed: (opParams.set_title ?? node.title) !== node.title,
                };
                if (typesChanged) entry.types_after = finalTypes;
                would_apply.push(entry);
              }

            } else if (op === 'delete') {
              const resolved = resolveNodeIdentity(db, {
                node_id: opParams.node_id,
                file_path: opParams.file_path,
                title: opParams.title,
              });
              if (!resolved.ok) throw new PipelineError(resolved.code, resolved.message);

              const { node } = resolved;
              const absPath = join(vaultPath, node.file_path);

              // Back up the file before deleting (skip in dry-run — file is never unlinked)
              if (!dryRun) {
                const bp = backupFile(absPath, tmpDir);
                if (bp) backups.push({ filePath: absPath, backupPath: bp });
              }

              const referenceKeys = captureDeletionReferences(db, node);
              let preview_refs: { count: number; nodes: Array<{ node_id: string; title: string; file_path: string }> } | undefined;
              if (dryRun) {
                const incomingCount = (db.prepare(
                  'SELECT COUNT(*) as c FROM relationships WHERE target = ? OR target = ?'
                ).get(node.title, node.file_path) as { c: number }).c;
                const incomingRows = db.prepare(`
                  SELECT r.source_id as node_id, n.title, n.file_path
                  FROM relationships r JOIN nodes n ON n.id = r.source_id
                  WHERE r.target = ? OR r.target = ?
                  LIMIT 10
                `).all(node.title, node.file_path) as Array<{ node_id: string; title: string; file_path: string }>;
                preview_refs = { count: incomingCount, nodes: incomingRows };
              }

              executeDeletion(db, writeLock, vaultPath, {
                source: 'batch',
                node_id: node.node_id,
                file_path: node.file_path,
                unlink_file: !dryRun,
                expectedVersion: opParams.expected_version,
              }, operation_id ? { operation_id } : undefined, { suppressObservers: dryRun });
              if (dryRun) {
                previewDiskHashes.delete(node.node_id);
                previewKeyOrders.delete(node.node_id);
                previewContents.delete(node.node_id);
              }
              if (!dryRun) {
                deletedNodeIds.push(node.node_id);
                deletedFilePaths.push(node.file_path);
              }

              const deleteResult: (typeof results)[number] = { op: 'delete', op_index: i, status: 'applied', node_id: node.node_id, file_path: node.file_path, dangling_references: 0 };
              results.push(deleteResult);
              deletionReferences.push({ keys: referenceKeys, report: unresolved => { deleteResult.dangling_references = unresolved; } });
              if (dryRun && preview_refs) {
                const entry: WouldApplyEntry = {
                  op: 'delete',
                  node_id: node.node_id,
                  file_path: node.file_path,
                  incoming_reference_count: preview_refs.count,
                  unresolved_reference_count: 0,
                  referencing_nodes: preview_refs.nodes,
                };
                would_apply.push(entry);
                deletionReferences.push({ keys: referenceKeys, report: unresolved => { entry.unresolved_reference_count = unresolved; } });
              }
            }
          } catch (err) {
            if (err instanceof ContentHashMismatchError) {
              contentHashMismatch = err;
              throw err;
            }
            if (err instanceof StaleNodeError) {
              if (dryRun) {
                addOpWarning({
                  code: 'STALE_NODE', severity: 'warning',
                  message: `Operation skipped because the node version changed: ${err.message}`,
                  details: buildStaleNodeDetails(db, err),
                }, i);
              }
              results.push({
                op,
                op_index: i,
                status: 'stale',
                node_id: err.nodeId,
                details: buildStaleNodeDetails(db, err),
              });
              continue;
            }
            if (err instanceof PipelineError) {
              const details: Record<string, unknown> = {};
              if (err.validation) {
                details.issues = err.validation.issues.map(adaptIssue);
                const fixable = buildFixable(err.validation.issues, err.validation.effective_fields);
                if (fixable.length > 0) details.fixable = fixable;
              }
              batchError = { failed_at: i, op, message: err.message, details };
            } else {
              batchError = { failed_at: i, op, message: err instanceof Error ? err.message : String(err), details: {} };
            }
            // Throw to trigger SQLite transaction rollback
            throw err;
          }
        }

        function* finalDiagnostics(): Iterable<ReferenceDiagnostic> {
          for (const [sourceId, opIndex] of referenceSources) {
            for (const diagnostic of collectStoredReferenceDiagnostics(db, sourceId)) {
              yield { ...diagnostic, opIndex };
            }
          }
          yield* recheckInboundDiagnostics(db, inboundReferences, new Set(referenceSources.keys()));
        }
        referenceWarnings = buildReferenceWarnings(finalDiagnostics());
        for (const { keys, report } of deletionReferences) report(countUnresolvedReferences(db, keys));
        if (dryRun) throw new DryRunRollback();
        return results;
      });

      try {
        try {
          const applied = txn();
          committed = true;
          // Success: clean up backups and orphaned vec rows for deleted nodes.
          cleanupBackups(backups.map(b => b.backupPath));
          for (const nodeId of deletedNodeIds) {
            embeddingIndexer?.removeNode(nodeId);
          }
          // Deleted Settings/Models/ notes leave the model catalog once the batch commits (#595).
          for (const filePath of deletedFilePaths) notifyToolWrite(filePath);
          for (const nodeId of linkRepairNodeIds) {
            const repaired = repairInboundLinks(db, writeLock, vaultPath, nodeId, mutationLogger, operation_id ? { operation_id } : undefined);
            for (const repairedId of repaired) pendingEmbedEnqueues.add(repairedId);
          }
          // Post-commit embedding refreshes (deduplicated across ops).
          for (const nodeId of pendingEmbedEnqueues) {
            embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
          }
          return ok({ applied: true, results: applied }, responseWarnings());
        } catch (err) {
          // Dry-run paths: both successful preview (sentinel) and mid-batch failure.
          if (dryRun) {
            // No file restoration needed: backups[] and createdFiles[] are empty under dry_run gating.
            if (contentHashMismatch instanceof ContentHashMismatchError) {
              return buildContentHashMismatchEnvelope(db, contentHashMismatch);
            }
            if (err instanceof DryRunRollback) {
              return ok({
                dry_run: true,
                op_count: params.operations.length,
                would_apply,
              }, responseWarnings());
            }
            // Real op failure inside dry-run txn.
            if (batchError) {
              return ok({
                dry_run: true,
                failed_at: batchError.failed_at,
                op: batchError.op,
                message: batchError.message,
                would_apply,
              }, responseWarnings());
            }
            return fail('INTERNAL_ERROR', err instanceof Error ? err.message : 'Batch dry-run failed', { warnings: responseWarnings() });
          }

          if (committed) {
            return fail('INTERNAL_ERROR', err instanceof Error ? err.message : 'Batch post-commit observer failed', { warnings: responseWarnings() });
          }

          // Live-path rollback: DB transaction rolled back. Now revert file writes.
          const rollbackFailures: string[] = [];

          // 0. Undo set_title renames FIRST — backups were taken at the
          // pre-rename path, so restoring them before the move is reversed
          // would write the backup to a path the file no longer occupies.
          for (const undo of fsUndos.reverse()) {
            try {
              undo();
            } catch (err) {
              const msg = `Failed to undo rename: ${err instanceof Error ? err.message : err}`;
              console.error(`[batch-mutate] ${msg}`);
              rollbackFailures.push(msg);
            }
          }

          // 1. Restore backed-up files (updates and deletes)
          const contentMismatch = contentHashMismatch instanceof ContentHashMismatchError
            ? contentHashMismatch
            : undefined;
          const missingFilePath = contentMismatch?.currentHash === null
            ? (db.prepare('SELECT file_path FROM nodes WHERE id = ?')
                .get(contentMismatch.nodeId) as { file_path: string } | undefined)?.file_path
            : undefined;
          const missingAbsPath = missingFilePath === undefined ? undefined : join(vaultPath, missingFilePath);
          for (const { filePath, backupPath } of backups) {
            if (filePath === missingAbsPath) continue;
            try {
              restoreFile(backupPath, filePath);
            } catch (err) {
              const msg = `Failed to restore ${filePath}: ${err instanceof Error ? err.message : err}`;
              console.error(`[batch-mutate] ${msg}`);
              rollbackFailures.push(msg);
            }
          }
          // 2. Delete newly created files
          for (const absPath of createdFiles) {
            try {
              unlinkSync(absPath);
            } catch (err) {
              const msg = `Failed to delete ${absPath}: ${err instanceof Error ? err.message : err}`;
              console.error(`[batch-mutate] ${msg}`);
              rollbackFailures.push(msg);
            }
          }

          cleanupBackups(backups.map(b => b.backupPath));

          if (contentMismatch) {
            discardEmptyOperation = contentMismatch.currentHash === null;
            return buildContentHashMismatchEnvelope(db, contentMismatch);
          }

          if (batchError) {
            const details: Record<string, unknown> = {
              failed_at: batchError.failed_at,
              op: batchError.op,
              ...batchError.details,
            };
            if (rollbackFailures.length > 0) {
              details.rollback_failures = rollbackFailures;
            }
            // Surface DEPRECATED_PARAM warnings even on failure — a caller using a
            // deprecated param should see the warning regardless of whether the op succeeded.
            return fail('BATCH_FAILED', batchError.message, { details, warnings: responseWarnings() });
          }
          return fail('INTERNAL_ERROR', 'Batch operation failed', { warnings: responseWarnings() });
        }
      } finally {
        if (operation_id) {
          if (discardEmptyOperation) discardOperation(db, operation_id);
          else finalizeOperation(db, operation_id);
        }
      }
    },
  );
}

/**
 * The type key is never a field (#480): an operation that sets one stops the batch at that
 * operation, preview or apply, with the refusal as the batch's message.
 */
function refuseTypeKeyField(fields: Record<string, unknown> | undefined, site: 'batch-create' | 'batch-update'): void {
  const issue = typeKeyFieldIssue(fields, site);
  if (issue === null) return;
  throw new PipelineError('VALIDATION_FAILED', issue.message, {
    valid: false, effective_fields: new Map(), coerced_state: {}, issues: [issue], orphan_fields: [],
  });
}

function countKinds(ops: Array<{ op: string }>): string {
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
}

function getNodeVersion(db: Database.Database, nodeId: string): number | undefined {
  return (db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined)?.version;
}

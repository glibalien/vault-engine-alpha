import { buildReferenceWarnings } from '../../resolver/diagnostics.js';
import { collectStoredReferenceDiagnostics, collectReferenceDiagnostics, recheckInboundDiagnostics, validatedReferenceFields, type ReferenceDiagnostic } from '../../pipeline/diagnostics.js';
// src/mcp/tools/update-node.ts

import { createFieldMap } from '../../fields/field-map.js';
import { handleReferenceEdit, referenceEditSchema } from './reference-edit.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fieldRecordSchema } from '../field-record-schema.js';
import { nanoid } from 'nanoid';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { previewTypedRenameFields } from '../../resolver/rename-references.js';
import { readFileOrNull } from '../../pipeline/file-writer.js';
import { sha256 } from '../../indexer/hash.js';
import { ok, fail, adaptIssue, failTypeKeyField, type Issue } from './errors.js';
import { dropStoredTypeKeyField, typeKeyFieldIssue } from '../../validation/type-key-field.js';
import { typeKey } from '../../parser/type-key.js';
import { memoryNoteEditRefusal, resolveNodeIdentity, settingsNoteEditRefusal } from './resolve-identity.js';
import { toolCaller, type ToolCaller } from '../../auth/client-label.js';
import {
  assertRenameReferenceFilesPresent,
  executeRename,
} from './rename-node.js';
import { checkTitleSafety, sanitizeFilename, type ToolIssue } from './title-warnings.js';
import {
  assertToolMutationFilePresent,
  assertMutationPreviewGuards,
  assertExpectedNodeVersion,
  executeMutation,
  StaleNodeError,
  ContentHashMismatchError,
} from '../../pipeline/execute.js';
import { titleFromFilename } from '../../parser/parse.js';
import { PipelineError } from '../../pipeline/types.js';
import { reconstructValue } from '../../pipeline/classify-value.js';
import { hasBlockingErrors } from '../../pipeline/errors.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
import { buildFixable } from '../../validation/fixable.js';
import { buildNodeQuery } from '../query-builder.js';
import type { NodeQueryFilter } from '../query-builder.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { createOperation, discardOperation, finalizeOperation } from '../../undo/operation.js';
import { editSessions as defaultEditSessions, EditSessionRegistry } from '../../undo/edit-session.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';
import { buildContentHashMismatchEnvelope } from './content-hash-helpers.js';
import { computeJoinWarning } from '../join-warning.js';
import {
  assertConversationAuthority,
  conversationAuthorityGuardSchema,
  ConversationAuthorityError,
} from '../../conversations/authority.js';
import {
  overlayExplicitNullFields,
  readExplicitNullFields,
} from '../../fields/explicit-null.js';
import {
  FieldGuessGuardStaleError,
  requestedFileHeld, verifyFieldGuessMutationGuard,
} from '../../field-guess/mutation-guard.js';

const fieldGuessReferenceGuardSchema = z.object({
  node_id: z.string().min(1),
  title: z.string().min(1),
  required_type: z.string().min(1).nullable(),
});

const fieldGuessGuardSchema = z.object({
  offered_fields: z.array(z.object({
    field: z.string().min(1),
    definition_hash: z.string().regex(/^[0-9a-f]{64}$/),
    reference_targets: z.array(fieldGuessReferenceGuardSchema).optional(),
  })).min(1),
  requested: z.boolean().optional(),
  replace_invalid: z.boolean().optional(),
});

const _targetFilterSchema = z.object({
  where: z.never().optional().describe('Compound where filters are supported only by read tools.'),
  node_ids: z.array(z.string()).optional(),
  without_node_ids: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  without_types: z.array(z.string()).optional(),
  fields: fieldRecordSchema(fieldRecordSchema(z.unknown())).optional(),
  without_fields: z.array(z.string()).optional(),
  title_eq: z.string().optional(),
  title_contains: z.string().optional(),
  without_titles: z.array(z.string()).optional(),
  without_title_contains: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  references: z.object({
    target: z.string(),
    rel_type: z.string().optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  }).optional(),
  path_prefix: z.string().optional(),
  without_path_prefix: z.string().optional(),
  path_dir: z.string().optional(),
  modified_since: z.string().optional(),
  created_since: z.string().optional(),
  // NOT included: join_filters, without_joins (nested joins deferred)
});

const _joinFilterSchema = z.object({
  direction: z.enum(['outgoing', 'incoming']).default('outgoing'),
  rel_type: z.union([z.string(), z.array(z.string())]).optional(),
  target: _targetFilterSchema.optional(),
}).refine(
  (f) => f.rel_type !== undefined || f.target !== undefined,
  { message: 'INVALID_PARAMS: JoinFilter requires at least one of rel_type or target' },
);

const paramsShape = {
  reference_edit: referenceEditSchema.optional().describe('Add/remove one member of a claimed reference list. Requires node_id; cannot combine with other edits. Defaults to preview. Exact stored_value removal requires both CAS guards.'),
  // Single-node identity (exactly one required, mutually exclusive with query)
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  // Single-node updates
  set_title: z.string().optional(),
  set_types: z.array(z.string()).optional(),
  set_fields: fieldRecordSchema(z.unknown()).optional(),
  set_body: z.string().optional(),
  append_body: z.string().optional(),
  // Query-mode bulk update (mutually exclusive with node identity)
  query: z.object({
    where: z.never().optional().describe('Compound where filters are supported only by read tools.'),
    link_counts: z.never().optional().describe('Link-count filters are supported only by read tools.'),
    node_ids: z.array(z.string()).optional(),
    without_node_ids: z.array(z.string()).optional(),
    types: z.array(z.string()).optional(),
    without_types: z.array(z.string()).optional(),
    fields: fieldRecordSchema(fieldRecordSchema(z.unknown())).optional(),
    without_fields: z.array(z.string()).optional(),
    title_eq: z.string().optional(),
    title_contains: z.string().optional(),
    without_titles: z.array(z.string()).optional(),
    without_title_contains: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    full_text: z.string().optional(),
    full_text_words: z.string().optional(),
    references: z.object({
      target: z.string(),
      rel_type: z.string().optional(),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
    }).optional(),
    path_prefix: z.string().optional(),
    without_path_prefix: z.string().optional(),
    path_dir: z.string().optional(),
    modified_since: z.string().optional(),
    created_since: z.string().optional(),
    join_filters: z.array(_joinFilterSchema).optional(),
    without_joins: z.array(_joinFilterSchema).optional(),
  }).optional(),
  // Type operations (query mode)
  add_types: z.array(z.string()).optional(),
  remove_types: z.array(z.string()).optional(),
  // Batch controls
  confirm_large_batch: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  expected_version: z.number().int().min(1).optional(),
  expected_content_hash: z.string().optional().describe('Write only if the note is still as read: its content_hash in the database, and the file on disk, both still hash to this.'),
  field_guess_guard: fieldGuessGuardSchema.optional(),
  edit_session_id: z.string().optional(),
  // Path operation
  set_directory: z.string().optional(),
  conversation_authority: conversationAuthorityGuardSchema.optional(),
};

export function registerUpdateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  editSessions: EditSessionRegistry = defaultEditSessions,
): void {
  const registered = server.tool(
    'update-node',
    'Update a node, or bulk-update nodes via query-mode. Patch semantics for fields (null removes a field). set_body and append_body are mutually exclusive. Types can be changed with set_types (replace all), add_types (append), or remove_types (remove), never with set_fields: '
      + `"${typeKey()}" is the frontmatter key that holds them, not a field. `
      + 'All type changes require defined schemas — use list-schemas to see available types. set_title renames the file and rewrites wiki-link references vault-wide. set_directory moves files to a target directory; in single-node mode it can be combined with type, field, body, or title changes. Query mode accepts query filters including without_node_ids, without_titles and without_title_contains for excluding known keepers, supports set_directory for bulk moves, and accepts join_filters/without_joins (same shape as query-nodes) for cross-node filtering. When join filters have targets but unresolved edges exist, a `CROSS_NODE_FILTER_UNRESOLVED` warning surfaces in the envelope `warnings` array. Curator field repair may supply field_guess_guard with both CAS values; Engine then atomically rechecks every offered definition and accepted reference before applying the fields-only patch. Dry-run defaults to true in query mode.',
    paramsShape,
    async (params, extra) => {
      const caller = toolCaller(extra);
      if (params.query && hasGroupPredicate(params.query)) return fail('INVALID_PARAMS','Classification group predicates are read-only; bulk mutations do not support them.');
      if(params.query && (Object.hasOwn(params.query,'where') || [...params.query.join_filters??[],...params.query.without_joins??[]].some(j=>j.target && Object.hasOwn(j.target,'where')))) return fail('INVALID_PARAMS','Compound where filters are supported only by read tools.');
      if (params.reference_edit !== undefined) {
        return handleReferenceEdit({ db, writeLock, vaultPath, syncLogger }, params, embeddingIndexer);
      }
      const hasIdentity = params.node_id !== undefined || params.file_path !== undefined || params.title !== undefined;
      const hasQuery = params.query !== undefined;

      if (params.field_guess_guard !== undefined) {
        const hasForbiddenOperation = params.node_id === undefined
          || params.file_path !== undefined
          || params.title !== undefined
          || params.set_fields === undefined
          || Object.keys(params.set_fields).length === 0
          || params.set_title !== undefined
          || params.set_types !== undefined
          || params.set_body !== undefined
          || params.append_body !== undefined
          || params.add_types !== undefined
          || params.remove_types !== undefined
          || params.set_directory !== undefined
          || params.edit_session_id !== undefined
          || params.expected_version === undefined
          || params.expected_content_hash === undefined;
        if (hasForbiddenOperation) {
          return fail(
            'INVALID_PARAMS',
            'field_guess_guard requires one node_id-only field patch with both optimistic concurrency guards',
          );
        }
      }

      if (hasIdentity && hasQuery) {
        return fail('INVALID_PARAMS', 'Cannot provide both node identity and query parameters');
      }
      if (!hasIdentity && !hasQuery) {
        return fail('INVALID_PARAMS', 'Must provide either node identity (node_id/file_path/title) or query');
      }
      // The type key is never a field (#480): refused in either mode, a null or a dry run
      // included, before any node is read.
      const typeKeyRefusal = typeKeyFieldIssue(params.set_fields, hasQuery ? 'update-node-query' : 'update-node');
      if (typeKeyRefusal !== null) return failTypeKeyField(typeKeyRefusal);

      // ── Query mode ──────────────────────────────────────────────────
      if (hasQuery) {
        if (params.conversation_authority !== undefined) {
          return fail('INVALID_PARAMS', 'conversation_authority is supported only for exact single-node capture updates.');
        }
        if (params.expected_version !== undefined) {
          return fail('INVALID_PARAMS', 'expected_version is not supported in query mode (caller does not know which nodes will match).');
        }
        if (params.expected_content_hash !== undefined) {
          return fail('INVALID_PARAMS', 'expected_content_hash is not supported in query mode (caller does not know which nodes will match).');
        }
        if (params.edit_session_id !== undefined) {
          return fail('INVALID_PARAMS', 'edit_session_id is not supported in query mode.');
        }
        if (params.set_types !== undefined) {
          return fail(
            'INVALID_PARAMS',
            'set_types is not supported in query mode. Use add_types/remove_types for bulk type changes across filtered nodes.',
          );
        }
        const hasOp = params.set_fields !== undefined || params.add_types !== undefined || params.remove_types !== undefined || params.set_directory !== undefined;
        if (!hasOp) {
          return fail('INVALID_PARAMS', 'Query mode requires at least one operation: set_fields, add_types, remove_types, or set_directory');
        }

        if (params.set_directory !== undefined && params.set_directory.endsWith('.md')) {
          return fail(
            'INVALID_PARAMS',
            '"set_directory" must be a folder path, not a filename. The filename is always derived from the node title.',
          );
        }
        const dryRun = params.dry_run ?? true; // default true in query mode
        return handleQueryMode(db, writeLock, vaultPath, params.query!, {
          set_fields: params.set_fields,
          add_types: params.add_types,
          remove_types: params.remove_types,
          set_directory: params.set_directory,
        }, dryRun, params.confirm_large_batch, syncLogger, embeddingIndexer, caller);
      }

      // ── Single-node mode ────────────────────────────────────────────
      const dryRun = params.dry_run ?? false; // default false in single-node mode
      const { set_title, set_types, set_fields, set_body, append_body, set_directory } = params;

      if (set_body !== undefined && append_body !== undefined) {
        return fail('INVALID_PARAMS', 'set_body and append_body are mutually exclusive');
      }
      if (set_directory !== undefined && set_directory.endsWith('.md')) {
        return fail(
          'INVALID_PARAMS',
          '"set_directory" must be a folder path, not a filename. The filename is always derived from the node title.',
        );
      }

      const resolved = resolveNodeIdentity(db, {
        node_id: params.node_id,
        file_path: params.file_path,
        title: params.title,
      });
      if (!resolved.ok) {
        return fail(resolved.code, resolved.message);
      }
      const { node } = resolved;
      const settingsRefusal = settingsNoteEditRefusal(node.file_path) ?? memoryNoteEditRefusal(vaultPath, node.file_path, caller);
      if (settingsRefusal !== null) return fail('INVALID_PARAMS', settingsRefusal);

      try {
        assertToolMutationFilePresent(db, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: node.file_path,
        });
      } catch (err) {
        if (err instanceof ContentHashMismatchError) {
          return buildContentHashMismatchEnvelope(db, err);
        }
        throw err;
      }

      const currentTypes = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
        .all(node.node_id) as Array<{ schema_type: string }>).map(t => t.schema_type);

      const currentFields = createFieldMap<unknown>();
      const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
        .all(node.node_id) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
      for (const row of fieldRows) {
        currentFields[row.field_name] = reconstructValue(row);
      }
      dropStoredTypeKeyField(currentFields);
      const currentExplicitNullFields = readExplicitNullFields(db, node.node_id);

      const currentBody = (db.prepare('SELECT body FROM nodes WHERE id = ?').get(node.node_id) as { body: string }).body;

      const finalTitle = set_title ?? node.title;
      const titleChanged = set_title !== undefined && set_title !== node.title;

      // If title changed, derive new file path and check for conflicts
      let effectiveFilePath = node.file_path;
      const directoryChanged = set_directory !== undefined;
      const titleSanitized = titleChanged || directoryChanged ? sanitizeFilename(`${finalTitle}.md`) : null;
      if (titleChanged || directoryChanged) {
        const currentDir = dirname(node.file_path);
        const newDir = directoryChanged
          ? (set_directory === '.' ? '' : set_directory!)
          : (currentDir === '.' ? '' : currentDir);
        const sanitizedFilename = titleSanitized!.filename;
        effectiveFilePath = newDir ? `${newDir}/${sanitizedFilename}` : sanitizedFilename;

        // Conflict check
        if (effectiveFilePath !== node.file_path) {
          // A rename or move must not put another note's text where the memory note is read from.
          const destinationRefusal = memoryNoteEditRefusal(vaultPath, effectiveFilePath, caller);
          if (destinationRefusal !== null) return fail('INVALID_PARAMS', destinationRefusal);
          const conflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(effectiveFilePath) as { id: string; title: string } | undefined;
          if (conflict) {
            return fail('CONFLICT', `Cannot rename — file "${effectiveFilePath}" already exists (node: ${conflict.title}). Pass set_directory to choose another folder.`);
          }
          safeVaultPath(vaultPath, effectiveFilePath); // throws on path traversal
          if (existsSync(join(vaultPath, effectiveFilePath))) {
            return fail('CONFLICT', `Cannot rename — file "${effectiveFilePath}" already exists on disk.`);
          }
        }
      }

      // Compute final types: set_types wins outright, otherwise apply add/remove
      let finalTypes: string[];
      const hasTypeOp = set_types !== undefined || params.add_types !== undefined || params.remove_types !== undefined;
      const ignored: string[] = [];
      if (params.add_types !== undefined) ignored.push('add_types');
      if (params.remove_types !== undefined) ignored.push('remove_types');
      const typeOpIssues: ToolIssue[] =
        set_types !== undefined && ignored.length > 0
          ? [{
              code: 'TYPE_OP_CONFLICT',
              message: `set_types was provided — ${ignored.join(' and ')} ${ignored.length === 1 ? 'was' : 'were'} ignored. Send only set_types for a full replacement, or only add_types/remove_types for incremental changes.`,
            }]
          : [];
      if (set_types !== undefined) {
        finalTypes = set_types;
      } else {
        finalTypes = computeNewTypes(currentTypes, {
          add_types: params.add_types,
          remove_types: params.remove_types,
        });
      }
      if (hasTypeOp && finalTypes.length === 0 && currentTypes.length > 0) {
        typeOpIssues.push({
          code: 'LAST_TYPE_REMOVAL',
          message: 'This change leaves the node with no types. Its fields become orphans (see orphan_fields); undo-operations can restore them.',
        });
      }
      const typeRemovalOrphans = hasTypeOp
        ? fieldsOrphanedByTypeRemoval(db, currentTypes, finalTypes, [...Object.keys(currentFields), ...currentExplicitNullFields])
        : [];

      // Type-schema check (only when types are being changed)
      if (hasTypeOp) {
        const typeCheck = checkTypesHaveSchemas(db, finalTypes);
        if (!typeCheck.valid) {
          return fail(
            'UNKNOWN_TYPE',
            `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
            {
              details: {
                unknown_types: typeCheck.unknown,
                available_schemas: typeCheck.available,
                suggestion: `Cannot set types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
              },
            },
          );
        }
      }

      const finalFields = createFieldMap(currentFields);
      if (set_fields) {
        for (const [key, value] of Object.entries(set_fields)) {
          finalFields[key] = value;
        }
      }

      let finalBody = currentBody;
      if (set_body !== undefined) {
        finalBody = set_body;
      } else if (append_body !== undefined) {
        finalBody = currentBody ? `${currentBody}\n\n${append_body}` : append_body;
      }

      const { claimsByType, globalFields } = loadSchemaContext(db, finalTypes);
      const explicitNullOverlay = overlayExplicitNullFields(
        finalFields,
        currentExplicitNullFields,
        Object.keys(set_fields ?? {}),
      );
      const validation = validateProposedState(
        explicitNullOverlay.fields,
        finalTypes,
        claimsByType,
        globalFields,
        params.field_guess_guard === undefined ? undefined : { skipDefaults: true },
      );

      if (params.field_guess_guard !== undefined) {
        try {
          verifyFieldGuessMutationGuard(
            db,
            node.node_id,
            finalTypes,
            finalFields,
            Object.keys(set_fields ?? {}),
            params.field_guess_guard,
            { claimsByType, globalFields },
            requestedFileHeld(db, vaultPath, node.file_path, node.node_id, params.field_guess_guard),
          );
          if (dryRun) {
            assertFieldGuessPreviewCas(
              db,
              writeLock,
              vaultPath,
              node.node_id,
              node.file_path,
              params.expected_version!,
              params.expected_content_hash!,
            );
          }
        } catch (err) {
          if (err instanceof FieldGuessGuardStaleError) {
            return fail('STALE_NODE', 'Field guess precondition changed');
          }
          if (err instanceof ContentHashMismatchError) {
            return buildContentHashMismatchEnvelope(db, err);
          }
          if (err instanceof StaleNodeError) {
            return buildStaleNodeEnvelope(db, err);
          }
          throw err;
        }
      }

      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        try {
          db.transaction(() => assertConversationAuthority(db, params.conversation_authority))();
          if (!hasBlockingErrors(validation.issues, explicitNullOverlay.explicitNullFields)) {
            const checkGuards = () => assertMutationPreviewGuards(db, writeLock, vaultPath, {
              source: 'tool', node_id: node.node_id,
              file_path: node.file_path, title: node.title,
              types: finalTypes, fields: finalFields, touchedFields: Object.keys(set_fields ?? {}),
              body: finalBody, expectedVersion: params.expected_version,
              expectedContentHash: params.expected_content_hash,
              conversationAuthority: params.conversation_authority,
              // The caller's hash guards the file on disk too: a save the watcher has not read
              // yet is a change the caller never saw (#332's link writes).
              expectedDiskContentHash: params.expected_content_hash,
              fieldGuessGuard: params.field_guess_guard,
            });
            // Renames and moves commit through executeRename, whose content write can be a
            // no-op that skips the version check, so the live path checks it explicitly.
            if (titleChanged || (directoryChanged && effectiveFilePath !== node.file_path)) {
              assertExpectedNodeVersion(db, node.node_id, params.expected_version);
            }
            checkGuards();
          }
        } catch (err) {
          if (err instanceof StaleNodeError) return buildStaleNodeEnvelope(db, err);
          if (err instanceof ContentHashMismatchError) return buildContentHashMismatchEnvelope(db, err);
          if (err instanceof ConversationAuthorityError) {
            return fail('CONFLICT', err.message, { details: { ...err.state } });
          }
          throw err;
        }
        if ((titleChanged || directoryChanged) && !hasBlockingErrors(validation.issues, explicitNullOverlay.explicitNullFields)) {
          try {
            assertRenameReferenceFilesPresent(
              db,
              vaultPath,
              node.node_id,
              node.title,
              finalTitle,
              undefined,
              effectiveFilePath,
            );
          } catch (err) {
            if (err instanceof ContentHashMismatchError) {
              return buildContentHashMismatchEnvelope(db, err);
            }
            throw err;
          }
        }
        const titleIssues: ToolIssue[] = titleChanged ? checkTitleSafety(finalTitle) : [];
        const sanitizeIssues: ToolIssue[] = titleSanitized?.sanitized
          ? [{
              code: 'TITLE_FILENAME_SANITIZED',
              message: `Title contains filename-reserved characters; replaced with '-' in the filename, which is also the stored title: ${titleSanitized.characters.join(' ')}`,
              characters: titleSanitized.characters,
            }]
          : [];
        const allIssues = [...validation.issues, ...titleIssues, ...sanitizeIssues, ...typeOpIssues];
        return ok(
          {
            dry_run: true,
            preview: {
              node_id: node.node_id,
              file_path: effectiveFilePath,
              title: titleFromFilename(effectiveFilePath),
              types: finalTypes,
              coerced_state: validation.coerced_state,
              fixable: buildFixable(validation.issues, validation.effective_fields),
              orphan_fields: validation.orphan_fields,
            },
          },
          [...allIssues.map(adaptIssue), ...buildReferenceWarnings(collectReferenceDiagnostics(db, node.node_id, previewTypedRenameFields(db, { id: node.node_id, file_path: effectiveFilePath, title: finalTitle, types: finalTypes }, validatedReferenceFields(validation)), finalBody, {}, { file_path: effectiveFilePath, title: finalTitle, types: finalTypes }))],
        );
      }

      if (
        directoryChanged
        && effectiveFilePath !== node.file_path
        && hasBlockingErrors(validation.issues, explicitNullOverlay.explicitNullFields)
      ) {
        const errorCount = validation.issues.filter(i => i.severity === 'error').length;
        return fail(
          'VALIDATION_FAILED',
          `Validation failed with ${errorCount} error(s)`,
          {
            details: {
              issues: validation.issues.map(adaptIssue),
              fixable: buildFixable(validation.issues, validation.effective_fields),
            },
          },
        );
      }

      // ── Undo operation setup (skipped for dry_run) ──────────────────
      const operation_id = dryRun
        ? undefined
        : params.edit_session_id !== undefined
          ? editSessions.resolve(db, params.edit_session_id, () => `edit session: ${node.title}`, Date.now())
          : createOperation(db, {
              source_tool: 'update-node',
              description: buildSingleNodeDescription(node.title, {
                set_title,
                set_types,
                add_types: params.add_types,
                remove_types: params.remove_types,
                set_fields,
                set_body,
                append_body,
                set_directory,
              }),
            });
      const ownsOperation = operation_id !== undefined && params.edit_session_id === undefined;
      let discardEmptyOperation = false;
      const fsUndos: Array<() => void> = [];
      const fsRollback = { push: (undo: () => void) => fsUndos.push(undo) };
      let transactionCommitted = false;

      try {
        // Single-node moves take executeRename under either reference policy, the path the
        // retired rename-node used for every move. Query-mode moves are unchanged.
        if (titleChanged || (directoryChanged && effectiveFilePath !== node.file_path)) {
          if (!titleChanged && (node.title.includes('/') || node.title.includes('\\'))) {
            return fail('INVALID_PARAMS', 'Title contains path separators, cannot move');
          }
          const transaction = db.transaction(() => {
            // executeMutation skips its version check on a no-op content write, which a
            // pure rename or move is, so check the caller's version before anything moves.
            assertExpectedNodeVersion(db, node.node_id, params.expected_version);
            // Apply field/type/body changes first (with old file_path and title).
            const mutResult = executeMutation(db, writeLock, vaultPath, {
              source: 'tool',
              node_id: node.node_id,
              file_path: node.file_path,
              title: node.title,
              types: finalTypes,
              fields: finalFields,
              touchedFields: Object.keys(set_fields ?? {}),
              body: finalBody,
              expectedVersion: params.expected_version,
              expectedContentHash: params.expected_content_hash,
              conversationAuthority: params.conversation_authority,
              expectedDiskContentHash: params.expected_content_hash,
              fieldGuessGuard: params.field_guess_guard,
            }, syncLogger, operation_id ? { operation_id } : undefined, fsRollback);

            // Then rename (file + DB + references) under the same DB and
            // filesystem rollback boundary.
            const renamed = executeRename(db, writeLock, vaultPath, {
              node_id: node.node_id,
              file_path: node.file_path,
              title: node.title,
            }, finalTitle, effectiveFilePath, syncLogger, operation_id ? { operation_id } : undefined, fsRollback);
            const own = new Set([node.node_id]);
            return { mutResult, ...renamed,
              referenceDiagnostics: [...collectStoredReferenceDiagnostics(db, node.node_id),
                ...recheckInboundDiagnostics(db, [...mutResult.referenceDiagnostics, ...renamed.inboundDiagnostics], own)] };
          });
          const { mutResult, refsUpdated, changedNodeIds, referenceDiagnostics } = transaction();
          transactionCommitted = true;
          logFieldsOrphanedByTypeRemoval(db, node.node_id, currentTypes, finalTypes, typeRemovalOrphans);
          // T0.3 + cycle 5: title + content changed — re-embed the renamed node
          // and every referencing node whose fields/body were rewritten (tool
          // writes skip the watcher). Enqueues run post-commit.
          embeddingIndexer?.enqueue({ node_id: node.node_id, source_type: 'node' });
          for (const changedId of changedNodeIds) {
            embeddingIndexer?.enqueue({ node_id: changedId, source_type: 'node' });
          }
          const version = getNodeVersion(db, node.node_id);

          const titleIssues: ToolIssue[] = checkTitleSafety(finalTitle);
          const sanitizeIssues: ToolIssue[] = titleSanitized?.sanitized
            ? [{
                code: 'TITLE_FILENAME_SANITIZED',
                message: `Title contains filename-reserved characters; replaced with '-' in the filename, which is also the stored title: ${titleSanitized.characters.join(' ')}`,
                characters: titleSanitized.characters,
              }]
            : [];
          return ok(
            {
              node_id: node.node_id,
              file_path: effectiveFilePath,
              title: titleFromFilename(effectiveFilePath),
              types: finalTypes,
              references_updated: refsUpdated,
              coerced_state: mutResult.validation.coerced_state,
              orphan_fields: mutResult.validation.orphan_fields,
              version,
              content_hash: getNodeContentHash(db, node.node_id),
              ...(ownsOperation && operation_id !== undefined ? { operation_id } : {}),
            },
            [...[...mutResult.validation.issues, ...titleIssues, ...sanitizeIssues, ...typeOpIssues].map(adaptIssue), ...buildReferenceWarnings(referenceDiagnostics)],
          );
        }

        // No title change — standard mutation
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.node_id,
          file_path: effectiveFilePath,
          title: finalTitle,
          types: finalTypes,
          fields: finalFields,
          touchedFields: Object.keys(set_fields ?? {}),
          body: finalBody,
          expectedVersion: params.expected_version,
          expectedContentHash: params.expected_content_hash,
          conversationAuthority: params.conversation_authority,
          // The caller's hash guards the file on disk too (see the preview above).
          expectedDiskContentHash: params.expected_content_hash,
          fieldGuessGuard: params.field_guess_guard,
        }, syncLogger, operation_id ? { operation_id } : undefined);
        logFieldsOrphanedByTypeRemoval(db, node.node_id, currentTypes, finalTypes, typeRemovalOrphans);
        // T0.3: content changed — re-embed (tool writes skip the watcher).
        embeddingIndexer?.enqueue({ node_id: result.node_id, source_type: 'node' });
        for (const repairedId of result.links_repaired ?? []) {
          embeddingIndexer?.enqueue({ node_id: repairedId, source_type: 'node' });
        }
        const version = getNodeVersion(db, result.node_id);

        return ok(
          {
            node_id: result.node_id,
            file_path: result.file_path,
            title: titleFromFilename(result.file_path),
            types: finalTypes,
            coerced_state: result.validation.coerced_state,
            orphan_fields: result.validation.orphan_fields,
            version,
            content_hash: result.rendered_hash,
            // This call's own undo operation, for undo-operations. An edit session's is shared.
            ...(ownsOperation && operation_id !== undefined ? { operation_id } : {}),
          },
          [...[...result.validation.issues, ...typeOpIssues].map(adaptIssue), ...buildReferenceWarnings(result.referenceDiagnostics)],
        );
      } catch (err) {
        if (params.field_guess_guard !== undefined && !transactionCommitted) {
          discardEmptyOperation = ownsOperation;
        }
        if (!transactionCommitted) {
          for (let i = fsUndos.length - 1; i >= 0; i--) {
            try {
              fsUndos[i]();
            } catch (undoErr) {
              const msg = undoErr instanceof Error ? undoErr.message : String(undoErr);
              console.error(`[update-node] fs rollback failed: ${msg}`);
            }
          }
        }
        if (err instanceof ConversationAuthorityError) {
          discardEmptyOperation = ownsOperation;
          return fail('CONFLICT', err.message, { details: { ...err.state } });
        }
        if (err instanceof ContentHashMismatchError) {
          discardEmptyOperation = discardEmptyOperation || (ownsOperation && err.currentHash === null);
          return buildContentHashMismatchEnvelope(db, err);
        }
        if (err instanceof StaleNodeError) {
          return buildStaleNodeEnvelope(db, err);
        }
        if (err instanceof FieldGuessGuardStaleError) {
          discardEmptyOperation = ownsOperation;
          return fail('STALE_NODE', 'Field guess precondition changed');
        }
        if (err instanceof PipelineError && err.validation) {
          const errorCount = err.validation.issues.filter(i => i.severity === 'error').length;
          return fail(
            'VALIDATION_FAILED',
            `Validation failed with ${errorCount} error(s)`,
            {
              details: {
                issues: err.validation.issues.map(adaptIssue),
                fixable: buildFixable(err.validation.issues, err.validation.effective_fields),
              },
            },
          );
        }
        if (err instanceof PipelineError) {
          return fail('VALIDATION_FAILED', err.message);
        }
        return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      } finally {
        if (operation_id) {
          if (discardEmptyOperation) discardOperation(db, operation_id);
          else finalizeOperation(db, operation_id);
        }
      }
    },
  );
  // Keep unknown input keys until the mode-local strict parser can reject them.
  // Legacy handlers continue to ignore unknown keys as they did before SDK stripping.
  if (registered) registered.inputSchema = z.object(paramsShape).passthrough();
}

interface QueryModeOps {
  set_fields?: Record<string, unknown>;
  add_types?: string[];
  remove_types?: string[];
  set_directory?: string;
}

function buildSingleNodeDescription(
  title: string,
  params: {
    set_title?: string;
    set_types?: string[];
    add_types?: string[];
    remove_types?: string[];
    set_fields?: Record<string, unknown>;
    set_body?: string;
    append_body?: string;
    set_directory?: string;
  },
): string {
  const parts: string[] = [];
  if (params.set_title !== undefined) parts.push('title');
  if (params.set_types !== undefined) parts.push('types');
  if (params.add_types !== undefined) parts.push('add_types');
  if (params.remove_types !== undefined) parts.push('remove_types');
  if (params.set_fields !== undefined) {
    const n = Object.keys(params.set_fields).length;
    parts.push(`${n} field${n === 1 ? '' : 's'}`);
  }
  if (params.set_body !== undefined) parts.push('body');
  if (params.append_body !== undefined) parts.push('append_body');
  if (params.set_directory !== undefined) parts.push('directory');
  const changes = parts.length > 0 ? parts.join(', ') : 'no-op';
  return `update-node: ${changes} on '${title}'`;
}

/** Fields the node has (values or explicit nulls) that only removed types claimed. */
function fieldsOrphanedByTypeRemoval(
  db: Database.Database,
  currentTypes: string[],
  finalTypes: string[],
  nodeFieldNames: string[],
): string[] {
  const removedTypes = currentTypes.filter(t => !finalTypes.includes(t));
  if (removedTypes.length === 0) return [];
  const claimsOf = (types: string[]) => new Set(types.flatMap(t =>
    (db.prepare('SELECT field FROM schema_field_claims WHERE schema_name = ?').all(t) as Array<{ field: string }>)
      .map(c => c.field)));
  const remaining = claimsOf(finalTypes);
  const present = new Set(nodeFieldNames);
  return [...claimsOf(removedTypes)].filter(f => !remaining.has(f) && present.has(f));
}

/** Forensic record of fields a type removal orphaned (schema propagation writes the same event). */
function logFieldsOrphanedByTypeRemoval(
  db: Database.Database,
  nodeId: string,
  currentTypes: string[],
  finalTypes: string[],
  orphanedFields: string[],
): void {
  if (orphanedFields.length === 0) return;
  const removedTypes = currentTypes.filter(t => !finalTypes.includes(t));
  db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
    nodeId,
    Date.now(),
    'fields-orphaned',
    JSON.stringify({
      source: 'tool',
      trigger: `update-node: removed type(s) ${removedTypes.join(', ')}`,
      orphaned_fields: orphanedFields,
      node_types: finalTypes,
    }),
  );
}

function getNodeVersion(db: Database.Database, nodeId: string): number | undefined {
  return (db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined)?.version;
}

function getNodeContentHash(db: Database.Database, nodeId: string): string | null {
  return (db.prepare('SELECT content_hash FROM nodes WHERE id = ?').get(nodeId) as { content_hash: string | null } | undefined)?.content_hash ?? null;
}

function assertFieldGuessPreviewCas(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  nodeId: string,
  filePath: string,
  expectedVersion: number,
  expectedContentHash: string,
): void {
  db.transaction(() => {
    const row = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(nodeId) as
      | { version: number; content_hash: string | null }
      | undefined;
    const currentContentHash = row?.content_hash ?? null;
    if (currentContentHash !== expectedContentHash) {
      throw new ContentHashMismatchError(nodeId, expectedContentHash, currentContentHash);
    }
    if (row !== undefined && row.version !== expectedVersion) {
      throw new StaleNodeError(nodeId, expectedVersion, row.version);
    }

    const absPath = safeVaultPath(vaultPath, filePath);
    writeLock.withLockSync(absPath, () => {
      const content = readFileOrNull(absPath);
      const currentDiskHash = content === null ? null : sha256(content);
      if (currentDiskHash !== expectedContentHash) {
        throw new ContentHashMismatchError(nodeId, expectedContentHash, currentDiskHash);
      }
    });
  })();
}

function handleQueryMode(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  query: NodeQueryFilter,
  ops: QueryModeOps,
  dryRun: boolean,
  confirmLargeBatch?: boolean,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  caller?: ToolCaller,
) {
  // Build query to find matching nodes
  const { sql, params } = buildNodeQuery(query, db);
  const matchedNodes = db.prepare(sql).all(...params) as Array<{
    id: string; file_path: string; title: string; body: string;
  }>;

  // Batch size guard
  if (matchedNodes.length > 1000 && !confirmLargeBatch) {
    return fail('INVALID_PARAMS', `Query matched ${matchedNodes.length} nodes (>1000). Set confirm_large_batch: true to proceed.`);
  }

  // Type-schema check on add_types
  if (ops.add_types && ops.add_types.length > 0) {
    const typeCheck = checkTypesHaveSchemas(db, ops.add_types);
    if (!typeCheck.valid) {
      return fail(
        'UNKNOWN_TYPE',
        `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
        {
          details: {
            unknown_types: typeCheck.unknown,
            available_schemas: typeCheck.available,
            suggestion: `Cannot add types ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
          },
        },
      );
    }
  }

  const batchId = nanoid();

  const joinWarning = computeJoinWarning(db, query.join_filters, query.without_joins);

  try {
    for (const node of matchedNodes) {
      const state = loadNodeState(db, node.id);
      const newTypes = computeNewTypes(state.types, ops);
      const newFields = computeNewFields(state.fields, ops);
      const destination = computeNewPath(node.file_path, node.title, ops);
      const moved = destination !== null;
      if (!hasChanges(
        state.types,
        newTypes,
        state.fields,
        newFields,
        state.explicitNullFields,
        moved,
      )) continue;
      // The memory note is refused as the note being changed (its types and fields decide
      // what other tools may write into it) and as the place a bulk move would land.
      const settingsRefusal = settingsNoteEditRefusal(node.file_path)
        ?? memoryNoteEditRefusal(vaultPath, node.file_path, caller)
        ?? (destination !== null ? memoryNoteEditRefusal(vaultPath, destination.newFilePath, caller) : null);
      if (settingsRefusal !== null) {
        return fail('INVALID_PARAMS', `${settingsRefusal} Exclude it from the query with without_node_ids.`, {
          details: { node_id: node.id, file_path: node.file_path },
        });
      }
      assertToolMutationFilePresent(db, vaultPath, {
        source: 'tool',
        node_id: node.id,
        file_path: node.file_path,
      });
      const move = computeNewPath(node.file_path, node.title, ops);
      if (move) {
        assertRenameReferenceFilesPresent(db, vaultPath, node.id, node.title, node.title, undefined, move.newFilePath);
      }
    }
  } catch (err) {
    if (err instanceof ContentHashMismatchError) {
      return buildContentHashMismatchEnvelope(db, err);
    }
    throw err;
  }

  if (dryRun) {
    return handleDryRun(db, vaultPath, matchedNodes, ops, batchId, joinWarning);
  }

  // ── Undo operation setup (query mode) ──────────────────────────────
  // One operation covers all matched-node mutations; finalize once in a
  // finally so orphan snapshots still get tagged for cleanup on throw.
  const operation_id = createOperation(db, {
    source_tool: 'update-node',
    description: `update-node query: updating ${matchedNodes.length} node(s)`,
  });
  let discardEmptyOperation = false;
  const fsUndos: Array<() => void> = [];
  const fsRollback = { push: (undo: () => void) => fsUndos.push(undo) };
  const pendingEmbedEnqueues = new Set<string>();
  let committed = false;

  try {
    const result = db.transaction(() => handleExecution(
      db,
      writeLock,
      vaultPath,
      matchedNodes,
      ops,
      batchId,
      syncLogger,
      operation_id,
      pendingEmbedEnqueues,
      fsRollback,
    ))();
    committed = true;
    for (const nodeId of pendingEmbedEnqueues) {
      embeddingIndexer?.enqueue({ node_id: nodeId, source_type: 'node' });
    }
    return result;
  } catch (err) {
    if (!committed) {
      for (let i = fsUndos.length - 1; i >= 0; i--) {
        try {
          fsUndos[i]();
        } catch (undoErr) {
          const msg = undoErr instanceof Error ? undoErr.message : String(undoErr);
          console.error(`[update-node query] fs rollback failed: ${msg}`);
        }
      }
    }
    if (err instanceof ContentHashMismatchError) {
      discardEmptyOperation = err.currentHash === null;
      return buildContentHashMismatchEnvelope(db, err);
    }
    throw err;
  } finally {
    if (discardEmptyOperation) discardOperation(db, operation_id);
    else finalizeOperation(db, operation_id);
  }
}


function loadNodeState(db: Database.Database, nodeId: string) {
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?')
    .all(nodeId) as Array<{ schema_type: string }>).map(t => t.schema_type);

  const currentFields = createFieldMap<unknown>();
  const fieldRows = db.prepare('SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields WHERE node_id = ?')
    .all(nodeId) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
  for (const row of fieldRows) {
    currentFields[row.field_name] = reconstructValue(row);
  }
  dropStoredTypeKeyField(currentFields);

  return {
    types,
    body: (db.prepare('SELECT body FROM nodes WHERE id = ?').get(nodeId) as { body: string }).body,
    fields: currentFields,
    explicitNullFields: readExplicitNullFields(db, nodeId),
  };
}

function computeNewTypes(currentTypes: string[], ops: QueryModeOps): string[] {
  let types = [...currentTypes];
  if (ops.add_types) {
    for (const t of ops.add_types) {
      if (!types.includes(t)) types.push(t);
    }
  }
  if (ops.remove_types) {
    types = types.filter(t => !ops.remove_types!.includes(t));
  }
  return types;
}

function countAlreadyPresentAddTypes(currentTypes: string[], addTypes: string[] | undefined): number {
  if (!addTypes) return 0;
  return addTypes.filter(t => currentTypes.includes(t)).length;
}

function buildAddTypeConflictWarning(count: number): Issue | undefined {
  if (count <= 0) return undefined;
  return {
    code: 'TYPE_OP_CONFLICT',
    severity: 'warning',
    message: `${count} (node, type) combination(s) in add_types were already present — no-op for those.`,
    details: { count },
  };
}

function computeNewFields(currentFields: Record<string, unknown>, ops: QueryModeOps): Record<string, unknown> {
  const finalFields = createFieldMap(currentFields);
  if (ops.set_fields) {
    for (const [key, value] of Object.entries(ops.set_fields)) {
      finalFields[key] = value;
    }
  }
  return finalFields;
}

function computeNewPath(currentFilePath: string, title: string, ops: QueryModeOps): { newFilePath: string; newDir: string; moved: boolean } | null {
  if (ops.set_directory === undefined) return null;

  const targetDir = ops.set_directory === '.' ? '' : ops.set_directory;
  const { filename } = sanitizeFilename(`${title}.md`);
  const newFilePath = targetDir === '' ? filename : `${targetDir}/${filename}`;

  if (newFilePath === currentFilePath) return null; // already at target

  return { newFilePath, newDir: targetDir, moved: true };
}

function checkMoveConflict(db: Database.Database, vaultPath: string, newFilePath: string, currentNodeId: string): string | null {
  safeVaultPath(vaultPath, newFilePath); // throws on path traversal
  const dbConflict = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(newFilePath) as { id: string; title: string } | undefined;
  if (dbConflict && dbConflict.id !== currentNodeId) {
    return `File path "${newFilePath}" already exists (node: ${dbConflict.title})`;
  }
  if (existsSync(join(vaultPath, newFilePath))) {
    const currentNode = db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(currentNodeId) as { file_path: string } | undefined;
    if (currentNode?.file_path !== newFilePath) {
      return `File "${newFilePath}" already exists on disk`;
    }
  }
  return null;
}

function hasChanges(
  currentTypes: string[],
  newTypes: string[],
  currentFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
  explicitNullFields: ReadonlySet<string>,
  moved?: boolean,
): boolean {
  if (moved) return true;
  // Check types changed
  if (currentTypes.length !== newTypes.length || !currentTypes.every(t => newTypes.includes(t))) {
    return true;
  }
  // Check fields changed
  const allKeys = new Set([...Object.keys(currentFields), ...Object.keys(newFields)]);
  for (const key of allKeys) {
    const oldVal = currentFields[key];
    const newVal = newFields[key];
    if (oldVal !== newVal) {
      // Handle null removal: if new is null and old doesn't exist, no change
      if (newVal === null && oldVal === undefined && !explicitNullFields.has(key)) continue;
      return true;
    }
  }
  return false;
}

const PREVIEW_LIMIT = 20;

function handleDryRun(
  db: Database.Database,
  vaultPath: string,
  matchedNodes: Array<{ id: string; file_path: string; title: string; body: string }>,
  ops: QueryModeOps,
  batchId: string,
  joinWarning?: Issue,
) {
  const preview: Array<{
    node_id: string;
    file_path: string;
    title: string;
    changes: {
      path_changed?: { from: string; to: string };
      types_added: string[];
      types_removed: string[];
      fields_set: Record<string, { from: unknown; to: unknown }>;
      would_fail: boolean;
    };
  }> = [];
  let wouldUpdate = 0;
  let wouldSkip = 0;
  let wouldFail = 0;
  let alreadyPresentAddTypes = 0;
  const referenceDiagnostics: ReferenceDiagnostic[] = [];

  for (let i = 0; i < matchedNodes.length; i++) {
    const node = matchedNodes[i];
    const {
      types: currentTypes,
      fields: currentFields,
      explicitNullFields,
    } = loadNodeState(db, node.id);
    alreadyPresentAddTypes += countAlreadyPresentAddTypes(currentTypes, ops.add_types);
    const newTypes = computeNewTypes(currentTypes, ops);
    const newFields = computeNewFields(currentFields, ops);

    const moveResult = computeNewPath(node.file_path, node.title, ops);
    const moved = moveResult !== null;
    let moveConflict: string | null = null;
    if (moved) {
      moveConflict = checkMoveConflict(db, vaultPath, moveResult!.newFilePath, node.id);
    }

    if (!hasChanges(currentTypes, newTypes, currentFields, newFields, explicitNullFields, moved)) {
      wouldSkip++;
      continue;
    }

    // Validate proposed state
    const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
    const explicitNullOverlay = overlayExplicitNullFields(
      newFields,
      explicitNullFields,
      Object.keys(ops.set_fields ?? {}),
    );
    const validation = validateProposedState(
      explicitNullOverlay.fields,
      newTypes,
      claimsByType,
      globalFields,
    );
    referenceDiagnostics.push(...collectReferenceDiagnostics(db, node.id, previewTypedRenameFields(db, { id: node.id, file_path: moveResult?.newFilePath ?? node.file_path, title: node.title, types: newTypes }, validatedReferenceFields(validation)), node.body,
      {}, { file_path: moveResult?.newFilePath ?? node.file_path, title: node.title, types: newTypes }));
    const fails = hasBlockingErrors(validation.issues, explicitNullOverlay.explicitNullFields)
      || moveConflict !== null;

    if (fails) {
      wouldFail++;
    } else {
      wouldUpdate++;
    }

    // Build preview for first N nodes that have changes
    if (i < PREVIEW_LIMIT) {
      const typesAdded = newTypes.filter(t => !currentTypes.includes(t));
      const typesRemoved = currentTypes.filter(t => !newTypes.includes(t));
      const fieldsSet = createFieldMap<{ from: unknown; to: unknown }>();
      if (ops.set_fields) {
        for (const [key, value] of Object.entries(ops.set_fields)) {
          if (currentFields[key] !== value) {
            fieldsSet[key] = { from: currentFields[key] ?? null, to: value };
          }
        }
      }

      const pathChanged = moved
        ? { from: dirname(node.file_path) === '.' ? '' : dirname(node.file_path), to: moveResult!.newDir }
        : undefined;

      preview.push({
        node_id: node.id,
        file_path: node.file_path,
        title: node.title,
        changes: {
          ...(pathChanged && { path_changed: pathChanged }),
          types_added: typesAdded,
          types_removed: typesRemoved,
          fields_set: fieldsSet,
          would_fail: fails,
        },
      });
    }
  }

  const warnings: Issue[] = buildReferenceWarnings(referenceDiagnostics);
  if (joinWarning) warnings.push(joinWarning);
  const conflictWarning = buildAddTypeConflictWarning(alreadyPresentAddTypes);
  if (conflictWarning) warnings.push(conflictWarning);
  return ok(
    {
      dry_run: true,
      batch_id: batchId,
      matched: matchedNodes.length,
      would_update: wouldUpdate,
      would_skip: wouldSkip,
      would_fail: wouldFail,
      preview,
    },
    warnings,
  );
}

function handleExecution(
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  matchedNodes: Array<{ id: string; file_path: string; title: string; body: string }>,
  ops: QueryModeOps,
  batchId: string,
  syncLogger?: SyncLogger,
  operation_id?: string,
  pendingEmbedEnqueues?: Set<string>,
  fsRollback?: { push(undo: () => void): void },
) {
  let updated = 0;
  let skipped = 0;
  let alreadyPresentAddTypes = 0;
  const referenceDiagnostics: ReferenceDiagnostic[] = [];
  // Other nodes' references an update left unresolved, re-checked once every matched node
  // is done, since a later update may resolve them again. One the source's own later update
  // already diagnosed is dropped; its own diagnostics are reported above.
  const inboundDiagnostics: Array<{ diagnostic: ReferenceDiagnostic; at: number }> = [];
  const updatedAt = new Map<string, number>();
  const errors: Array<{ node_id: string; file_path: string; error: string }> = [];

  for (const node of matchedNodes) {
    const {
      types: currentTypes,
      fields: currentFields,
      body: currentBody,
      explicitNullFields,
    } = loadNodeState(db, node.id);
    alreadyPresentAddTypes += countAlreadyPresentAddTypes(currentTypes, ops.add_types);
    const newTypes = computeNewTypes(currentTypes, ops);
    const newFields = computeNewFields(currentFields, ops);
    const moveResult = computeNewPath(node.file_path, node.title, ops);
    const moved = moveResult !== null;

    if (!hasChanges(currentTypes, newTypes, currentFields, newFields, explicitNullFields, moved)) {
      skipped++;
      continue;
    }

    const { claimsByType, globalFields } = loadSchemaContext(db, newTypes);
    const explicitNullOverlay = overlayExplicitNullFields(
      newFields,
      explicitNullFields,
      Object.keys(ops.set_fields ?? {}),
    );
    const validation = validateProposedState(
      explicitNullOverlay.fields,
      newTypes,
      claimsByType,
      globalFields,
    );
    if (hasBlockingErrors(validation.issues, explicitNullOverlay.explicitNullFields)) {
      errors.push({
        node_id: node.id,
        file_path: node.file_path,
        // A field named like the type key says what to use instead (#445).
        error: validation.issues.find(issue => issue.code === 'TYPE_KEY_FIELD')?.message ?? 'Validation failed',
      });
      continue;
    }

    // ── Move (set_directory) ───────────────────────────────────────────
    let effectiveFilePath = node.file_path;
    // A move goes through executeRename under either reference policy, as a single-node move
    // does, so links to the note follow it (#590). Before, under policy 1 a bulk move only
    // renamed the file, and links written as its path named a file that no longer existed.

    if (moved) {
      const conflict = checkMoveConflict(db, vaultPath, moveResult!.newFilePath, node.id);
      if (conflict) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: conflict });
        continue;
      }

      if (node.title.includes('/') || node.title.includes('\\')) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: 'Title contains path separators, cannot move' });
        continue;
      }

      safeVaultPath(vaultPath, moveResult!.newFilePath); // throws on path traversal
      if (!existsSync(join(vaultPath, node.file_path))) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: 'Source file missing from disk' });
        continue;
      }

      effectiveFilePath = moveResult!.newFilePath;
    }

    const moveUndos: Array<() => void> = [];
    try {
      const result = db.transaction(() => {
        const mutation = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: node.id,
          file_path: node.file_path,
          title: node.title,
          types: newTypes,
          fields: newFields,
          touchedFields: Object.keys(ops.set_fields ?? {}),
          body: currentBody,
        }, syncLogger, operation_id ? { operation_id } : undefined,
        moved ? { push: undo => moveUndos.push(undo) } : fsRollback);
        if (moved) {
          const renamed = executeRename(db, writeLock, vaultPath,
            { node_id: node.id, file_path: node.file_path, title: node.title },
            node.title, effectiveFilePath, syncLogger, operation_id ? { operation_id } : undefined,
            { push: undo => moveUndos.push(undo) });
          for (const id of renamed.changedNodeIds) pendingEmbedEnqueues?.add(id);
          return { mutation, own: [...collectStoredReferenceDiagnostics(db, node.id)],
            inbound: [...mutation.referenceDiagnostics, ...renamed.inboundDiagnostics] };
        }
        return { mutation, own: mutation.referenceDiagnostics, inbound: mutation.referenceDiagnostics };
      })();
      for (const undo of moveUndos) fsRollback?.push(undo);
      moveUndos.length = 0;
      updatedAt.set(node.id, updatedAt.size);
      referenceDiagnostics.push(...result.own.filter(diagnostic => diagnostic.sourceId === node.id));
      for (const diagnostic of result.inbound) {
        if (diagnostic.sourceId !== node.id) inboundDiagnostics.push({ diagnostic, at: updatedAt.size - 1 });
      }

      // T0.3: re-embed the mutated node (tool writes skip the watcher). A
      // hash-match no-op is cheap, so enqueue regardless of file_written.
      pendingEmbedEnqueues?.add(node.id);

      if (result.mutation.file_written || moved) {
        updated++;
      } else {
        skipped++;
      }

      // Write bulk-mutate edits_log entry
      db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)').run(
        node.id,
        Date.now(),
        'bulk-mutate',
        JSON.stringify({ batch_id: batchId, ops }),
      );
    } catch (err) {
      for (let i = moveUndos.length - 1; i >= 0; i--) {
        try { moveUndos[i](); } catch (rollbackError) { console.error('[update-node] move rollback failed:', rollbackError); }
      }
      if (err instanceof ContentHashMismatchError) throw err;
      if (err instanceof PipelineError) {
        errors.push({ node_id: node.id, file_path: node.file_path, error: err.message });
      } else {
        errors.push({ node_id: node.id, file_path: node.file_path, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  referenceDiagnostics.push(...recheckInboundDiagnostics(db, inboundDiagnostics
    .filter(({ diagnostic, at }) => !((updatedAt.get(diagnostic.sourceId ?? '') ?? -1) > at))
    .map(({ diagnostic }) => diagnostic)));
  const warnings: Issue[] = buildReferenceWarnings(referenceDiagnostics);
  const conflictWarning = buildAddTypeConflictWarning(alreadyPresentAddTypes);
  if (conflictWarning) warnings.push(conflictWarning);
  return ok({
    dry_run: false,
    batch_id: batchId,
    matched: matchedNodes.length,
    updated,
    skipped,
    errors,
    // The batch's one undo operation, for undo-operations.
    ...(operation_id ? { operation_id } : {}),
  }, warnings);
}

/** Inspect predicate positions only; field names and literal values are user data. */
function hasGroupPredicate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const filter = value as Record<string,unknown>;
  if (filter.fields && typeof filter.fields === 'object') {
    for (const predicate of Object.values(filter.fields)) {
      if (predicate && typeof predicate === 'object' &&
          (Object.hasOwn(predicate,'in_group') || Object.hasOwn(predicate,'is_unclassified'))) return true;
    }
  }
  if (hasGroupPredicate(filter.where)) return true;
  for (const key of ['all','any']) {
    if (Array.isArray(filter[key]) && filter[key].some(hasGroupPredicate)) return true;
  }
  for (const key of ['join_filters','without_joins']) {
    if (Array.isArray(filter[key]) && filter[key].some(join => join && typeof join === 'object' && hasGroupPredicate(join.target))) return true;
  }
  return false;
}

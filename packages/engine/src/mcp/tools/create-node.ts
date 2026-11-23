import { buildReferenceWarnings } from '../../resolver/diagnostics.js';
import { collectReferenceDiagnostics, validatedReferenceFields } from '../../pipeline/diagnostics.js';
// src/mcp/tools/create-node.ts

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fieldRecordSchema } from '../field-record-schema.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeVaultPath } from '../../pipeline/safe-path.js';
import { ok, fail, adaptIssue, failTypeKeyField } from './errors.js';
import { memoryNoteEditRefusal } from './resolve-identity.js';
import { toolCaller } from '../../auth/client-label.js';
import { typeKeyFieldIssue } from '../../validation/type-key-field.js';
import { typeKey } from '../../parser/type-key.js';
import { exampleNamesFor, type ExampleNames } from '../example-names.js';
import { checkTitleSafety, checkBodyFrontmatter, sanitizeFilename, type ToolIssue } from './title-warnings.js';
import { executeMutation } from '../../pipeline/execute.js';
import { titleFromFilename } from '../../parser/parse.js';
import { PipelineError } from '../../pipeline/types.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import { checkTypesHaveSchemas } from '../../pipeline/check-types.js';
import { resolveDirectory, resolveFilename } from '../../schema/paths.js';
import { loadSchemaContext } from '../../pipeline/schema-context.js';
import { validateProposedState } from '../../validation/validate.js';
import { buildFixable } from '../../validation/fixable.js';
import { createOperation, finalizeOperation } from '../../undo/operation.js';
import {
  assertConversationAuthority,
  conversationAuthorityGuardSchema,
  ConversationAuthorityError,
} from '../../conversations/authority.js';

const paramsShape = {
  title: z.string(),
  types: z.array(z.string()).default([]),
  fields: fieldRecordSchema(z.unknown()).default({}),
  body: z.string().default(''),
  directory: z.string().optional(),
  override_default_directory: z.boolean().default(false),
  dry_run: z.boolean().default(false),
  conversation_authority: conversationAuthorityGuardSchema.optional(),
};

/** Which type to use for a general-purpose note: the vault map's note kind, or nothing when it is none. */
function generalNoteAdvice({ vault }: ExampleNames): string {
  return vault.journalType === null ? '' : `For general-purpose notes and reference material, use type ${vault.journalType}. `;
}

export function registerCreateNode(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
): void {
  server.tool(
    'create-node',
    'Create a new node and write it to disk. Every type in types must have a defined schema — call list-schemas to see available types. '
      + generalNoteAdvice(exampleNamesFor(db))
      + 'File location is derived from the type\'s schema (default_directory + filename_template). To override the schema directory, pass directory with override_default_directory: true. Use dry_run: true to validate types and fields before generating long body content — this catches errors without wasting work. '
      + `Put the note's types in types, never in fields: "${typeKey()}" is the frontmatter key that holds them.`,
    paramsShape,
    async (params, extra) => {
      const { title, types = [], fields = {}, body = '', directory, override_default_directory = false, dry_run: dryRun = false, conversation_authority } = params;

      // The type key is never a field (#480): refused, dry run included, before anything else.
      const typeKeyRefusal = typeKeyFieldIssue(fields, 'create-node');
      if (typeKeyRefusal !== null) return failTypeKeyField(typeKeyRefusal);

      // ── Type-schema check (Stage 1 gate) ──────────────────────────
      const typeCheck = checkTypesHaveSchemas(db, types);
      if (!typeCheck.valid) {
        return fail(
          'UNKNOWN_TYPE',
          `Unknown type(s): ${typeCheck.unknown.join(', ')}`,
          {
            details: {
              unknown_types: typeCheck.unknown,
              available_schemas: typeCheck.available,
              suggestion: `Cannot write node with type${typeCheck.unknown.length > 1 ? 's' : ''} ${typeCheck.unknown.map(t => `'${t}'`).join(', ')} — no schema exists. Use list-schemas to see available types, or use create-schema to define a new type first.`,
            },
          },
        );
      }

      // ── Resolve directory via shared helper ───────────────────────
      const dirResult = resolveDirectory(db, {
        types,
        directory,
        override_default_directory,
      });
      if (!dirResult.ok) return fail(dirResult.code, dirResult.message);

      // Filename template lookup via shared helper (also used by batch-mutate).
      const fnResult = resolveFilename(db, { types, title, fields });
      if (!fnResult.ok) return fail(fnResult.code, fnResult.message);
      const sanitize = sanitizeFilename(fnResult.fileName);
      const fileName = sanitize.filename;
      const filePath = dirResult.directory
        ? `${dirResult.directory}/${fileName}`
        : fileName;
      const memoryNoteRefusal = memoryNoteEditRefusal(vaultPath, filePath, toolCaller(extra));
      if (memoryNoteRefusal !== null) return fail('INVALID_PARAMS', memoryNoteRefusal);

      // ── Compute warnings ────────────────────────────────────────
      const titleIssues = checkTitleSafety(title);
      const bodyIssues = checkBodyFrontmatter(body);
      const sanitizeIssues: ToolIssue[] = sanitize.sanitized
        ? [{
            code: 'TITLE_FILENAME_SANITIZED',
            message: `Title contains filename-reserved characters; replaced with '-' in the filename, which is also the stored title: ${sanitize.characters.join(' ')}`,
            characters: sanitize.characters,
          }]
        : [];
      const extraIssues = [...titleIssues, ...bodyIssues, ...sanitizeIssues];

      // Conflict check
      const existing = db.prepare('SELECT id, title FROM nodes WHERE file_path = ?').get(filePath) as { id: string; title: string } | undefined;
      safeVaultPath(vaultPath, filePath); // throws on path traversal
      const diskConflict = existsSync(join(vaultPath, filePath));

      // ── Dry run: validate without writing ─────────────────────────
      if (dryRun) {
        try {
          db.transaction(() => assertConversationAuthority(db, conversation_authority))();
        } catch (err) {
          if (err instanceof ConversationAuthorityError) {
            return fail('CONFLICT', err.message, { details: { ...err.state } });
          }
          throw err;
        }
        const { claimsByType, globalFields } = loadSchemaContext(db, types);
        const validation = validateProposedState(fields, types, claimsByType, globalFields);
        const conflict = existing
          ? `File path "${filePath}" already exists (node: ${existing.title})`
          : diskConflict ? `File "${filePath}" already exists on disk` : undefined;
        const allIssues = [...validation.issues, ...extraIssues];
        return ok(
          {
            dry_run: true,
            would_create: {
              file_path: filePath,
              title: titleFromFilename(filePath),
              types,
              coerced_state: validation.coerced_state,
              fixable: buildFixable(validation.issues, validation.effective_fields),
              orphan_fields: validation.orphan_fields,
              ...(conflict ? { conflict } : {}),
            },
          },
          [...allIssues.map(adaptIssue), ...buildReferenceWarnings(collectReferenceDiagnostics(db, null, validatedReferenceFields(validation), body, {}, { file_path: filePath, title: titleFromFilename(filePath), types }))],
        );
      }

      // Non-dry-run: reject conflicts
      if (existing) {
        return fail('INVALID_PARAMS', `File path "${filePath}" already exists (node: ${existing.title})`);
      }
      if (diskConflict) {
        return fail('INVALID_PARAMS', `File "${filePath}" already exists on disk`);
      }

      // ── Undo operation setup ────────────────────────────────────────
      // Dry-run path returned above, so we're always on the live-write path
      // here and must always create an operation.
      const operation_id = createOperation(db, {
        source_tool: 'create-node',
        description: `create-node: '${title}'`,
      });

      try {
        const result = executeMutation(db, writeLock, vaultPath, {
          source: 'tool',
          node_id: null,
          file_path: filePath,
          title,
          types,
          fields,
          body,
          conversationAuthority: conversation_authority,
        }, syncLogger, { operation_id });

        // T0.3: tool writes don't fire a watcher event, so enqueue the node for
        // (re-)embedding here. enqueue is fire-and-forget and the indexer
        // self-drains; a hash-match is a cheap no-op.
        embeddingIndexer?.enqueue({ node_id: result.node_id, source_type: 'node' });
        for (const repairedId of result.links_repaired ?? []) {
          embeddingIndexer?.enqueue({ node_id: repairedId, source_type: 'node' });
        }

        return ok(
          {
            node_id: result.node_id,
            file_path: result.file_path,
            title: titleFromFilename(result.file_path),
            types,
            coerced_state: result.validation.coerced_state,
            orphan_fields: result.validation.orphan_fields,
          },
          [...[...result.validation.issues, ...extraIssues].map(adaptIssue), ...buildReferenceWarnings(result.referenceDiagnostics)],
        );
      } catch (err) {
        if (err instanceof ConversationAuthorityError) {
          return fail('CONFLICT', err.message, { details: { ...err.state } });
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
        finalizeOperation(db, operation_id);
      }
    },
  );
}

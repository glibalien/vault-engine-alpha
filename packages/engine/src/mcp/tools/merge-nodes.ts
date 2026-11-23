import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  MERGED_HEADING, MERGE_LIMITS, MergeError, assertFilesAsIndexed, planMerge, removeMergedFiles, runMerge,
  type MergeDeps, type MergePlan,
} from '../../merge/service.js';
import { ContentHashMismatchError, StaleNodeError, repairInboundLinks } from '../../pipeline/execute.js';
import { PipelineError } from '../../pipeline/types.js';
import { buildReferenceWarnings } from '../../resolver/diagnostics.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import { createOperation, discardOperation, finalizeOperation } from '../../undo/operation.js';
import { buildFixable } from '../../validation/fixable.js';
import { buildContentHashMismatchDetails, buildContentHashMismatchEnvelope } from './content-hash-helpers.js';
import { fieldRecordSchema } from '../field-record-schema.js';
import { adaptIssue, fail, ok, type Issue } from './errors.js';
import { buildStaleNodeEnvelope } from './stale-helpers.js';

export const mergeNodesRequestSchema = z.strictObject({
  keep: z.string().min(1).describe('Id of the note to keep.'),
  merge: z.array(z.string().min(1)).min(1).max(MERGE_LIMITS.maxMerged)
    .describe(`Ids of the notes to fold into it and remove (at most ${MERGE_LIMITS.maxMerged}).`),
  // Field names are data: `fieldRecordSchema` keeps a key such as `__proto__`, which a plain record drops.
  set_fields: fieldRecordSchema(z.unknown()).optional()
    .describe('Field values for the merged note: the answer to a conflict, or any other change. null removes a field.'),
  body: z.string().optional().describe('The merged note\'s text, in place of the notes\' texts joined.'),
  keep_titles_as_aliases: z.boolean().optional()
    .describe('false: do not add the merged notes\' titles to the kept note\'s aliases (default true).'),
  dry_run: z.boolean().optional().describe('Preview only (default true). Pass false to merge.'),
});

const DESCRIPTION =
  'Merge notes: keep one note and fold one or more others into it. The others are removed, and every link to them, in a note\'s text or in a field, is rewritten to name the kept note. '
  + 'Use it for two notes about the same person or company, or for the copies find-duplicate-nodes lists. Previews by default: pass dry_run: false to merge. Show the user the preview and merge only after they say yes. '
  + 'Fields: the kept note keeps its own values. A field only a merged note holds is carried over (fields.carried), and list fields are combined (fields.combined). Where both hold different values the kept note\'s stays, and fields.conflicts shows both: pass set_fields to choose another value. '
  + `Text: each merged note's text is added to the kept note under a "## ${MERGED_HEADING} <title>" heading, unless it is the same text or empty; pass body to supply the merged text yourself. `
  + 'Kinds: the merged note has every kind its notes had (types_added). '
  + 'Names: each merged note\'s title is added to the kept note\'s aliases, so the old name still finds it; keep_titles_as_aliases: false leaves them out. '
  + 'Links: links.notes is how many other notes are rewritten, and links.written_as how the kept note is named in them: its title, or its vault path when another note shares the title. A link to a heading keeps its heading, and a field value is rewritten only where it is a link. files_kept lists a merged note\'s file that was saved while the merge ran and was therefore not removed, and links.fields_left_alone a linking note\'s field that was not rewritten because its file holds text the Engine did not take. '
  + 'Also moved to the kept note (moved): memories drawn from or scoped to a merged note, and boards, conversations and transcripts linked to one. '
  + 'The whole merge is one undo: the result\'s operation_id goes to undo-operations, which restores the removed notes, the kept note and every rewritten link. Undo does not move memories, boards, conversations or transcripts back. '
  + 'Refused: a wiki page, a settings note, the memory note or the journal as either side; a merged note whose file holds a value the Engine did not take because it fails its field\'s rules (correct or clear it first); and any merge while one of its notes, or a note that links to them, has an edit the Engine has not read yet or has lost its file (CONTENT_HASH_MISMATCH: try again in a few seconds). '
  + 'A merge that a field value would make invalid is refused whole with VALIDATION_FAILED, naming the note and the field; nothing is changed.';

interface MergeToolDeps extends MergeDeps {
  settingsDir?: string;
  embeddingIndexer?: EmbeddingIndexer;
}

/** A refused write, as the tool reports it. */
function refusal(db: Database.Database, error: unknown) {
  if (error instanceof ContentHashMismatchError) return buildContentHashMismatchEnvelope(db, error);
  if (error instanceof StaleNodeError) return buildStaleNodeEnvelope(db, error);
  if (error instanceof PipelineError) {
    const note = (error as PipelineError & { node_file_path?: string }).node_file_path;
    if (!error.validation) return fail('VALIDATION_FAILED', error.message, note === undefined ? {} : { details: { node_file_path: note } });
    const errors = error.validation.issues.filter(issue => issue.severity === 'error').length;
    return fail('VALIDATION_FAILED', `Validation failed with ${errors} error(s)${note === undefined ? '' : ` in ${note}`}. Nothing was changed.`, {
      details: {
        ...(note === undefined ? {} : { node_file_path: note }),
        issues: error.validation.issues.filter(issue => issue.severity === 'error').map(adaptIssue),
        fixable: buildFixable(error.validation.issues, error.validation.effective_fields),
      },
    });
  }
  return fail('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
}

function conflictWarnings(plan: MergePlan): Issue[] {
  const warnings: Issue[] = [];
  const open = plan.report.fields.conflicts.filter(conflict => conflict.resolved_by === 'kept');
  if (open.length > 0) {
    warnings.push({
      code: 'MERGE_CONFLICT', severity: 'warning',
      message: `${open.length} field${open.length === 1 ? '' : 's'} differ between the notes (${open.map(conflict => conflict.field).join(', ')}). The kept note's value stays; set_fields chooses another.`,
    });
  }
  const left = plan.report.links.fields_left_alone;
  if (left.length > 0) {
    warnings.push({
      code: 'PENDING_REFERENCES', severity: 'warning',
      message: `${left.length} field${left.length === 1 ? ' links' : 's link'} to a merged note and ${left.length === 1 ? 'is' : 'are'} left as written, because the note's file holds text there that the Engine did not take (${left.slice(0, 5).map(entry => `${entry.field} in ${entry.path}`).join('; ')}). Correct the value in the note; its stored link is not repointed.`,
      details: { fields_left_alone: left },
    });
  }
  return warnings;
}

export function registerMergeNodes(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  settingsDir?: string,
): void {
  const deps: MergeToolDeps = {
    db, writeLock, vaultPath,
    ...(syncLogger === undefined ? {} : { syncLogger }),
    ...(embeddingIndexer === undefined ? {} : { embeddingIndexer }),
    ...(settingsDir === undefined ? {} : { settingsDir }),
  };
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(mergeNodesRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'merge-nodes',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) => {
      const parsed = mergeNodesRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      const { dry_run: dryRunParam, ...request } = parsed.data;
      const dryRun = dryRunParam !== false;

      let plan: MergePlan;
      try {
        plan = planMerge(db, vaultPath, request, deps.settingsDir);
      } catch (error) {
        if (error instanceof MergeError) return fail(error.code, error.message, error.details === undefined ? {} : { details: error.details });
        return refusal(db, error);
      }
      try {
        assertFilesAsIndexed(vaultPath, plan);
      } catch (error) {
        if (!(error instanceof ContentHashMismatchError)) return refusal(db, error);
        const path = [plan.kept, ...plan.merged, ...plan.sourceWrites.map(write => write.note)].find(note => note.id === error.nodeId)?.file_path ?? error.nodeId;
        const what = error.currentHash === null
          ? `The file of "${path}" is missing. A merge works from what the Engine has read, and will not go on without the file. If the note was deleted, try again in a few seconds; if not, put its file back.`
          : `"${path}" has an edit the Engine has not read yet. A merge works from what the Engine has read, so that text would be lost. Try again in a few seconds.`;
        return fail('CONTENT_HASH_MISMATCH', what, {
          details: { node_file_path: path, ...buildContentHashMismatchDetails(db, error) },
        });
      }

      if (dryRun) {
        try {
          const run = runMerge(deps, plan, { dryRun: true });
          return ok({ dry_run: true, ...plan.report }, [...conflictWarnings(plan), ...buildReferenceWarnings(run.referenceDiagnostics)]);
        } catch (error) {
          return refusal(db, error);
        }
      }

      const operationId = createOperation(db, {
        source_tool: 'merge-nodes',
        description: `merge-nodes: ${plan.merged.length} note${plan.merged.length === 1 ? '' : 's'} into '${plan.kept.title}'`,
      });
      const fsUndos: Array<() => void> = [];
      let committed = false;
      try {
        const run = runMerge(deps, plan, { dryRun: false, operationId, fsRollback: { push: undo => fsUndos.push(undo) } });
        committed = true;
        const warnings: Issue[] = [...conflictWarnings(plan), ...buildReferenceWarnings(run.referenceDiagnostics)];
        const keptFiles = removeMergedFiles(deps, plan);
        for (const file of keptFiles) {
          warnings.push({
            code: 'UNDO_FILE_KEPT', severity: 'warning',
            message: file.why === 'changed'
              ? `${file.path} was saved while the merge ran, so its file was kept: it holds text the merge did not see. The note itself is merged, and the Engine will read the file back as a new note. Compare it with the kept note, then merge it again or delete it.`
              : file.why === 'kept_note_missing'
                ? `The kept note's file went missing while the merge ran, so ${file.path} was not removed: it may be the only copy left. Undo this merge with undo-operations.`
                : `The merged note's file ${file.path} could not be removed (${file.error}). Its note is merged and gone from the vault's index; remove the file by hand, or it will be read back as a new note.`,
          });
        }
        // A link that named a merged note only up to its spelling was never bound to it, so it was
        // not rewritten above. The kept note answers to that name now, by its new alias: re-save
        // such notes as a create or rename does. Best-effort, and part of the same undo.
        const repaired = repairInboundLinks(db, writeLock, vaultPath, plan.kept.id, syncLogger, { operation_id: operationId });
        // The removed notes leave the search index, and the rewritten ones are embedded again.
        for (const note of plan.merged) deps.embeddingIndexer?.removeNode(note.id);
        for (const id of new Set([...run.changedNodeIds, ...repaired])) deps.embeddingIndexer?.enqueue({ node_id: id, source_type: 'node' });
        return ok({ dry_run: false, operation_id: operationId, ...plan.report, ...(keptFiles.length === 0 ? {} : { files_kept: keptFiles.map(file => file.path) }) }, warnings);
      } catch (error) {
        if (!committed) {
          for (let i = fsUndos.length - 1; i >= 0; i--) {
            try {
              fsUndos[i]!();
            } catch (undoError) {
              console.error(`[merge-nodes] fs rollback failed: ${undoError instanceof Error ? undoError.message : String(undoError)}`);
            }
          }
        }
        return refusal(db, error);
      } finally {
        if (committed) finalizeOperation(db, operationId);
        else discardOperation(db, operationId);
      }
    },
  );
}

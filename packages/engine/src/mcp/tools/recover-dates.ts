import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DATE_LIMITS, DateRecoveryError, rememberOrders, scanDates, writeDates, type DateProposal } from '../../dates/service.js';
import type { EmbeddingIndexer } from '../../search/indexer.js';
import type { SyncLogger } from '../../sync/sync-logger.js';
import type { WriteLockManager } from '../../sync/write-lock.js';
import { createOperation, discardOperation, finalizeOperation } from '../../undo/operation.js';
import { fail, ok } from './errors.js';

/** Skipped notes named in a result. */
const SHOWN_SKIPPED = 20;

export const recoverDatesRequestSchema = z.strictObject({
  types: z.array(z.string().min(1)).min(1).optional().describe('Only notes of these kinds.'),
  path_prefix: z.string().min(1).optional().describe('Only notes whose vault path starts with this, e.g. a folder.'),
  node_ids: z.array(z.string().min(1)).min(1).max(DATE_LIMITS.maxWrites).optional()
    .describe('Only these notes: for writing the unsure dates you have checked, with include_unsure.'),
  include_unsure: z.boolean().optional().describe('With dry_run: false, also write the unsure dates in scope (default false).'),
  use_file_time: z.boolean().optional()
    .describe('Also propose the file\'s time for a note that holds no date at all. Always unsure: an export usually resets file times.'),
  only: z.enum(['sure', 'unsure']).optional().describe('List only the sure or only the unsure proposals.'),
  limit: z.number().int().min(1).max(DATE_LIMITS.maxPage).optional().describe(`Proposals per page (default ${DATE_LIMITS.defaultPage}).`),
  offset: z.number().int().min(0).optional().describe('Proposals to skip.'),
  dry_run: z.boolean().optional().describe('Preview only (default true). Pass false to write.'),
});

const DESCRIPTION =
  'Find a date for notes that have none the system can read, from what each note itself holds, and write it to the vault\'s date field. Previews by default: pass dry_run: false to write. '
  + 'A note\'s date is read from the date field of the vault map, or else from a YYYY-MM-DD day in its title. Exported notes often have neither, though the date is there in another form. '
  + 'A proposal comes, in this order, from: the date field\'s own text written another way; another frontmatter field named for the note\'s date (meeting date, when, start) or for when it was made (created), but not one about something else (due date, release date); the title in another form (2021_03_04, 4 Mar 2021); the first lines of the text (a "Date: ..." line, or a line that is only a date); a field named for the last edit; and, only with use_file_time, the file\'s time. '
  + 'Each proposal says date, from, field or label, where (the text it was read from), sure and writable. A date is sure when it is written in a clear form in the frontmatter or the title. It is unsure, with doubts saying why, when day and month could be either way round (03/04/2021), the year has two digits, it is the first day of a span (March 4-6, 2021), it comes from a line of the text, a last-edit field or the file time, or writing it would replace what the date field holds (replaces): other text, words beside the date, a list, a link. It is unsure too when the note states two different days (sources_disagree), as when an export\'s created is the export day and a "Date:" line in the text says when the note was: also lists the other days, and the user says which is right. Where that text is in the note\'s file alone because the field refused it (file_only_text), it is replaced only when asked like any other, and undo puts it back. An either-way date is read by the order the other dates of the same field show; with nothing to go by, date is null and readings gives both. '
  + 'A run writes the sure dates. Show the user the unsure ones, and write those they confirm with include_unsure: true and node_ids naming them. '
  + `It writes at most ${DATE_LIMITS.maxWrites} notes per call: remaining says how many it did not get to, and calling again goes on from there. One run is one undo: the result's operation_id goes to undo-operations. A note that cannot be written is skipped with the reason, and the run goes on to the next. `
  + 'scope counts the notes read, those with no date (undated), and of those the sure, unsure and unreadable (no reading, so not writable) proposals and the notes that hold no date at all (none). '
  + 'Only the user\'s notes are read: the suite\'s own notes, the settings folder and wiki pages are left out. Dates are read in numbers and in English month names.';

function shape(proposals: readonly DateProposal[]) {
  const sure = proposals.filter(proposal => proposal.sure);
  const unsure = proposals.filter(proposal => !proposal.sure && proposal.writable);
  const unreadable = proposals.filter(proposal => proposal.date === null).length;
  return { sure, unsure, unreadable };
}

export function registerRecoverDates(
  server: McpServer,
  db: Database.Database,
  writeLock: WriteLockManager,
  vaultPath: string,
  syncLogger?: SyncLogger,
  embeddingIndexer?: EmbeddingIndexer,
  settingsDir?: string,
): void {
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(recoverDatesRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'recover-dates',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const parsed = recoverDatesRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      const { types, path_prefix: pathPrefix, node_ids: nodeIds, include_unsure: includeUnsure, use_file_time: useFileTime, only, limit, offset = 0, dry_run: dryRunParam } = parsed.data;
      const dryRun = dryRunParam !== false;
      let scan;
      try {
        scan = scanDates(db, {
          ...(types === undefined ? {} : { types }),
          ...(pathPrefix === undefined ? {} : { path_prefix: pathPrefix }),
          ...(nodeIds === undefined ? {} : { node_ids: nodeIds }),
          ...(useFileTime === undefined ? {} : { use_file_time: useFileTime }),
        }, { vaultPath, ...(settingsDir === undefined ? {} : { settingsDir }) });
      } catch (error) {
        if (error instanceof DateRecoveryError) return fail(error.code, error.message, error.details === undefined ? {} : { details: error.details });
        return fail('INTERNAL_ERROR', 'Unable to read the notes\' dates.');
      }
      const { sure, unsure, unreadable } = shape(scan.proposals);
      const scope = { notes: scan.notes, undated: scan.undated, sure: sure.length, unsure: unsure.length, unreadable, none: scan.none };
      const toWrite = includeUnsure === true ? [...sure, ...unsure] : sure;

      if (dryRun) {
        const listed = only === 'sure' ? sure : only === 'unsure' ? scan.proposals.filter(proposal => !proposal.sure) : scan.proposals;
        return ok({
          dry_run: true,
          date_field: scan.dateField,
          scope,
          would_write: toWrite.length,
          total: listed.length,
          offset,
          proposals: listed.slice(offset, offset + (limit ?? DATE_LIMITS.defaultPage)),
        });
      }

      if (toWrite.length === 0) {
        return ok({ dry_run: false, date_field: scan.dateField, scope, written: 0, skipped_count: 0, skipped: [], remaining: 0 });
      }
      // Writing a date over `25/03/2021` removes what told how `03/04/2021` beside it reads.
      rememberOrders(db, scan.learned);
      const operationId = createOperation(db, {
        source_tool: 'recover-dates',
        description: `recover-dates: up to ${Math.min(toWrite.length, DATE_LIMITS.maxWrites)} note${toWrite.length === 1 ? '' : 's'} (${scan.dateField})`,
      });
      let written = 0;
      try {
        const result = writeDates({ db, writeLock, vaultPath, ...(syncLogger === undefined ? {} : { syncLogger }) }, scan.dateField, toWrite, operationId);
        written = result.written.length;
        for (const id of result.written) embeddingIndexer?.enqueue({ node_id: id, source_type: 'node' });
        return ok({
          dry_run: false,
          ...(written > 0 ? { operation_id: operationId } : {}),
          date_field: scan.dateField,
          scope,
          written,
          skipped_count: result.skipped.length,
          skipped: result.skipped.slice(0, SHOWN_SKIPPED),
          remaining: toWrite.length - result.attempted,
        });
      } finally {
        if (written > 0) finalizeOperation(db, operationId);
        else discardOperation(db, operationId);
      }
    },
  );
}

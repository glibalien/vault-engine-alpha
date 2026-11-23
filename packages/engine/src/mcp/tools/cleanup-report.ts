import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CleanupError, cleanupReport, cleanupRowNotes, CLEANUP_LIMITS } from '../../cleanup/report.js';
import { fail, ok } from './errors.js';

export const cleanupReportRequestSchema = z.strictObject({
  row: z.string().min(1).optional()
    .describe('List the notes of this one row (its id) instead of the report; page with limit and offset.'),
  limit: z.number().int().min(1).max(CLEANUP_LIMITS.maxPage).optional()
    .describe(`row: page size (default ${CLEANUP_LIMITS.defaultPage}).`),
  offset: z.number().int().min(0).optional().describe('row: notes to skip.'),
  examples: z.number().int().min(1).max(CLEANUP_LIMITS.maxExamples).optional()
    .describe(`Examples per row of the report (default ${CLEANUP_LIMITS.defaultExamples}).`),
});

const DESCRIPTION =
  'List what is still unorganized in the vault, most notes affected first. Read-only. '
  + 'Each row is one clean-up: its title, notes (how many notes it affects) out_of (how many it looked at), why it matters, examples, and next: calls that start on it, written with this vault\'s own kinds and fields (replace any <placeholder>). '
  + 'It checks: notes with no kind; tasks and projects with no status; meetings with no people; statuses the vault map gives no meaning; meetings and daily notes with no readable date; fields no kind of their note claims; links to notes that do not exist; and notes with the same text as another note. '
  + 'An example is a note ({id, title, path}) or a value with the notes that carry it ({value, notes}): a field name, a status, a missing note\'s name. '
  + 'Pass row (a row\'s id) to list exactly the notes that row counts, newest first; their ids go to query-nodes or update-node as node_ids. '
  + 'guide is the steps for working through the report with the user, in order: follow it. Work one row at a time, then call this again: a row that was fixed is smaller, or has moved to clear. '
  + 'not_checked lists checks that could not run because the vault map (the vault settings domain) names no such kind or field, each with the setting that turns it on. '
  + 'Only the user\'s notes are counted: the suite\'s own notes, the settings folder and wiki pages are left out. '
  + `Counts are computed on each call and nothing is stored. Caps: ${CLEANUP_LIMITS.maxExamples} examples, ${CLEANUP_LIMITS.maxPage} notes per page. It scans the whole vault, so call it on demand, not routinely.`;

export function registerCleanupReport(server: McpServer, db: Database.Database, settingsDir?: string): void {
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(cleanupReportRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'cleanup-report',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) => {
      const parsed = cleanupReportRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      const { row, limit, offset, examples } = parsed.data;
      const folder = settingsDir === undefined ? {} : { settingsDir };
      try {
        if (row !== undefined) {
          if (examples !== undefined) return fail('INVALID_PARAMS', 'examples belongs to the report; a row listing takes limit and offset.');
          return ok(cleanupRowNotes(db, row, {
            ...folder,
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          }));
        }
        if (limit !== undefined || offset !== undefined) return fail('INVALID_PARAMS', 'limit and offset page one row; pass row with them.');
        return ok(cleanupReport(db, { ...folder, ...(examples === undefined ? {} : { examples }) }));
      } catch (error) {
        if (error instanceof CleanupError) return fail(error.code, error.message);
        return fail('INTERNAL_ERROR', 'Unable to build the clean-up report.');
      }
    },
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DUPLICATE_LIMITS, DuplicateError, findDuplicates } from '../../duplicates/service.js';
import { fail, ok, type Issue } from './errors.js';

export const findDuplicateNodesRequestSchema = z.strictObject({
  types: z.array(z.string().min(1)).min(1).optional()
    .describe('Only notes of these types. Omit for every note of the user\'s except transcripts and daily notes, which are alike by design.'),
  path_prefix: z.string().min(1).optional().describe('Only notes whose vault path starts with this, e.g. a folder.'),
  min_similarity: z.number().min(DUPLICATE_LIMITS.minSimilarity).max(1).optional()
    .describe(`How alike two notes must be to count as near duplicates: the share of their three-word runs they have in common (default ${DUPLICATE_LIMITS.defaultSimilarity}).`),
  exact_only: z.boolean().optional().describe('true: only notes with the same body. Faster on a large vault.'),
  limit: z.number().int().min(1).max(DUPLICATE_LIMITS.maxGroups).optional()
    .describe(`Groups per page (default ${DUPLICATE_LIMITS.defaultGroups}).`),
  offset: z.number().int().min(0).optional().describe('Groups to skip.'),
});

const DESCRIPTION =
  'List notes that are copies or near copies of each other, in groups. Read-only. '
  + 'A vault moved from app to app often holds a note twice: exported twice, or an old copy beside an edited one. '
  + 'Exact groups hold notes with the same body, whatever their titles and folders. Near groups hold notes whose text is nearly the same: similarity is the share of three-word runs two notes have in common, counted on words alone, so the same text in another app\'s formatting is still the same text. A near group\'s similarity is the lowest among the pairs that tie it together. '
  + 'Each note comes with its title, path, types, word count, when its file last changed and when it was first indexed, and how many notes link to it and from it, so you can tell which copy is fuller and which one other notes point at; the most linked-to, then the longest, is listed first. Notes of a group with the same body_hash have the same body. get-node reads a note in full. '
  + 'It compares text only and decides nothing: two meeting notes from one template can score high and both be wanted. Show the user the groups and let them choose; then merge-nodes folds the other copies into the one to keep: their fields and text are carried over, every link to them is repointed, and it is one undo. '
  + 'Compared: the user\'s own notes, without wiki pages, the settings folder, and, unless types names them, transcripts and daily notes. A body under 24 characters is never an exact copy, and a note under 20 words is not compared for near copies. '
  + `Caps: ${DUPLICATE_LIMITS.maxNotes.toLocaleString('en-US')} notes read, ${DUPLICATE_LIMITS.maxGroups} groups per page. It reads every note in scope on each call: call it on demand, not routinely.`;

export function registerFindDuplicateNodes(server: McpServer, db: Database.Database, settingsDir?: string): void {
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(findDuplicateNodesRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'find-duplicate-nodes',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const parsed = findDuplicateNodesRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      try {
        const result = findDuplicates(db, parsed.data, settingsDir === undefined ? {} : { settingsDir });
        const warnings: Issue[] = [];
        if (result.scope.truncated) {
          warnings.push({
            code: 'RESULT_TRUNCATED', severity: 'warning',
            message: `More than ${DUPLICATE_LIMITS.maxNotes.toLocaleString('en-US')} notes are in scope; only the first ${DUPLICATE_LIMITS.maxNotes.toLocaleString('en-US')} by id were compared. Narrow it with path_prefix or types.`,
          });
        }
        if (result.scope.near_incomplete) {
          warnings.push({
            code: 'RESULT_TRUNCATED', severity: 'warning',
            message: 'The search for near duplicates stopped at its limit of pairs to compare, so some near groups may be missing. Exact groups are complete. Narrow it with path_prefix or types.',
          });
        }
        return ok(result, warnings);
      } catch (error) {
        if (error instanceof DuplicateError) {
          return fail(error.code, error.message, error.details === undefined ? {} : { details: error.details });
        }
        return fail('INTERNAL_ERROR', 'Unable to compare notes.');
      }
    },
  );
}

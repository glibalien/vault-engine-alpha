import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { TAG_LIMITS, TagError, listTags } from '../../tags/service.js';
import { fail, ok } from './errors.js';

export const listInlineTagsRequestSchema = z.strictObject({
  tag: z.string().min(1).optional()
    .describe('List the notes that carry this one tag instead of the tags; page with limit and offset. With or without the #.'),
  prefix: z.string().min(1).optional().describe('Only tags starting with this, e.g. "project/".'),
  min_notes: z.number().int().min(1).optional().describe('Only tags at least this many notes carry (default 1).'),
  path_prefix: z.string().min(1).optional().describe('Only notes whose vault path starts with this, e.g. a folder.'),
  untyped_only: z.boolean().optional().describe('true: only notes with no kind.'),
  limit: z.number().int().min(1).max(TAG_LIMITS.maxNotes).optional()
    .describe(`Tags per page (default ${TAG_LIMITS.defaultTags}, at most ${TAG_LIMITS.maxTags}), or with tag, notes per page (default ${TAG_LIMITS.defaultNotes}).`),
  offset: z.number().int().min(0).optional().describe('Tags, or with tag notes, to skip.'),
});

const DESCRIPTION =
  'List the #tags written in notes\' text, most notes first, with the notes that carry each. Read-only. '
  + 'Some apps mark what a note is with a #tag in its text (#meeting, #recipe, #project/alpha). Nothing else reads those, so a query cannot find the notes of a tag: this can. '
  + 'Each tag comes with notes (how many carry it), inline (in their text), in_field (in the tags frontmatter field, which is counted as the same tag), untyped (with no kind), the kinds those notes have, and the newest notes. '
  + 'Pass tag to list exactly the notes of one tag, newest first, each with its kinds and where it holds the tag. Their ids go to update-node as query: { node_ids } with add_types (the tag becomes a kind) or set_fields (it becomes a field\'s value); update-node previews until dry_run is false, and takes at most 500 ids a call. Agree the mapping with the user first. '
  + 'The #tag text stays in the note: nothing here changes a note. '
  + 'A tag is read as Obsidian reads it: # at the start of a line or after a space, then letters, digits, _, - and /, not all digits. A heading (# Title), a link to a heading, a URL\'s fragment and anything in code are not tags, and letter case does not matter. A nested tag counts for the tags it is nested under: #project/alpha is also one of the notes of project, and nested_only says how many notes carry a tag only that way. '
  + 'Only the user\'s notes are read: the suite\'s own notes, the settings folder and wiki pages are left out. '
  + `Caps: ${TAG_LIMITS.maxTags} tags or ${TAG_LIMITS.maxNotes} notes per page. Nothing is stored; each call reads every note in scope.`;

export function registerListInlineTags(server: McpServer, db: Database.Database, settingsDir?: string): void {
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(listInlineTagsRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'list-inline-tags',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const parsed = listInlineTagsRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      const request = parsed.data;
      if (request.tag === undefined && request.limit !== undefined && request.limit > TAG_LIMITS.maxTags) {
        return fail('INVALID_PARAMS', `limit: at most ${TAG_LIMITS.maxTags} tags per page.`);
      }
      if (request.tag !== undefined && (request.prefix !== undefined || request.min_notes !== undefined)) {
        return fail('INVALID_PARAMS', 'prefix and min_notes narrow the list of tags; a tag\'s notes take limit and offset.');
      }
      try {
        return ok(listTags(db, request, settingsDir === undefined ? {} : { settingsDir }));
      } catch (error) {
        if (error instanceof TagError) return fail(error.code, error.message);
        return fail('INTERNAL_ERROR', 'Unable to list the tags.');
      }
    },
  );
}

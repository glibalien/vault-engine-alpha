import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { MISSING_LIMITS, MissingNotesError, findMissingNotes } from '../../missing-notes/service.js';
import { fail, ok } from './errors.js';

export const findMissingNodesRequestSchema = z.strictObject({
  fields: z.array(z.string().min(1)).min(1).optional()
    .describe('Only names written in one of these fields, as a link or as plain text. E.g. the people field, for the people with no note.'),
  min_notes: z.number().int().min(1).optional().describe('Only names that at least this many notes name (default 1).'),
  limit: z.number().int().min(1).max(MISSING_LIMITS.maxNames).optional().describe(`Names per page (default ${MISSING_LIMITS.defaultNames}).`),
  offset: z.number().int().min(0).optional().describe('Names to skip.'),
});

const DESCRIPTION =
  'List the names that notes mention but that have no note of their own, most-named first. Read-only. '
  + 'In a pile of exported notes, people and companies are mostly names: this says which of them enough notes name to deserve a note. '
  + 'A name is read from two places: a link that resolves to nothing, in a note\'s text or in a field; and plain text in the vault map\'s people field or company field (Dana Whitfield where a link would be [[Dana Whitfield]]). Names in a note\'s running text are not read. '
  + 'Each name comes with notes (how many notes name it), body_links (how many of them link to it from their text), fields (per field: notes naming it there as a link, and as plain_text), other_spellings, the newest notes that name it, likely_type (the kind its note would be, when the fields that name it say so) and create: create-node arguments for its note. batch-mutate creates several at once. When create_note is present, create leaves the kind out, because the vault has no such kind yet or because the filename template of that kind would give the note another name: follow the note. When existing_note is present, a note already answers to the name by an alias or a near spelling and create is left out: rewrite the links and values to that note instead. Agree the names and their kind with the user before creating notes. '
  + 'Once a name\'s note exists, links to it resolve. A plain-text value stays plain text: update-node can rewrite the field value as a link. scope.plain_text_fields counts, per field, the plain names with no note (missing, all listed) and the plain names a note already answers to (with_a_note, not listed). '
  + 'A name written with its folder (People/Dana Whitfield) is listed apart from the bare name: create that one first, in its folder, and the bare name is answered too. '
  + 'To find every note that names one: query-nodes with references: { target: <a spelling> } for links, or fields: { <field>: { contains: <name> } } for plain text. '
  + 'A name counts as missing only when no note of any kind answers to it, so a link left unresolved because two notes share its name, or because the note is of another kind than the field takes, is not listed. A people field\'s single text value is split on commas and semicolons, unless it is one link or a note answers to it whole; list items and company values are taken whole. '
  + 'Only the user\'s notes are read: the suite\'s own notes, the settings folder and wiki pages are left out. '
  + `Caps: ${MISSING_LIMITS.maxNames} names per page, ${MISSING_LIMITS.examples} notes and ${MISSING_LIMITS.spellings} other spellings per name. Nothing is stored; each call reads every link.`;

export function registerFindMissingNodes(server: McpServer, db: Database.Database, settingsDir?: string): void {
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(findMissingNodesRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'find-missing-nodes',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const parsed = findMissingNodesRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      try {
        return ok(findMissingNotes(db, parsed.data, settingsDir === undefined ? {} : { settingsDir }));
      } catch (error) {
        if (error instanceof MissingNotesError) {
          return fail(error.code, error.message, error.details === undefined ? {} : { details: error.details });
        }
        return fail('INTERNAL_ERROR', 'Unable to list the missing names.');
      }
    },
  );
}

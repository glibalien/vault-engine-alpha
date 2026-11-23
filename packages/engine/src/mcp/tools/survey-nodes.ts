import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { SurveyError, surveyMembers, surveyNodes, SURVEY_LIMITS } from '../../survey/service.js';
import { fail, ok, type Issue } from './errors.js';

const groupRef = z.strictObject({
  survey_id: z.string().min(1).describe('survey_id from an earlier survey-nodes result.'),
  group: z.number().int().min(0).describe('Group number in that survey; 0 is the ungrouped rest.'),
}).meta({ id: 'SurveyGroupRef' });

export const surveyNodesRequestSchema = z.strictObject({
  types: z.array(z.string().min(1)).min(1).optional()
    .describe('Look for sub-groups inside these types. Omit to survey the notes that have no type.'),
  path_prefix: z.string().min(1).optional().describe('Only notes whose vault path starts with this, e.g. a folder.'),
  within: groupRef.optional().describe('Survey one group of an earlier survey again, to split it further.'),
  members_of: groupRef.optional()
    .describe('List the notes of one group of an earlier survey instead of surveying; page with limit and offset.'),
  max_groups: z.number().int().min(2).max(SURVEY_LIMITS.maxGroups).optional()
    .describe(`Most groups to form (default ${SURVEY_LIMITS.defaultGroups}).`),
  samples: z.number().int().min(1).max(SURVEY_LIMITS.maxSamples).optional()
    .describe(`Sample notes per group (default ${SURVEY_LIMITS.defaultSamples}).`),
  limit: z.number().int().min(1).max(SURVEY_LIMITS.maxMemberPage).optional()
    .describe(`members_of page size (default ${SURVEY_LIMITS.defaultMemberPage}).`),
  offset: z.number().int().min(0).optional().describe('members_of: notes to skip.'),
});

const DESCRIPTION =
  'Group notes by similarity to find the kinds hiding in untyped notes. Read-only. '
  + 'With no arguments it surveys every note that has no type; types looks for sub-groups inside those types, path_prefix limits it to a folder, and within splits one group of an earlier survey. '
  + 'Each group has a note count, cohesion (0–1: how alike its notes are), its most typical notes as samples, and what its notes share: folders, title patterns (such as "<date> …"), "Label: value" lines, headings and frontmatter fields, each with the share of the group that has it. '
  + 'Use the samples and shared features to name a kind and its fields; get-node reads a sample in full. Group 0 is the rest: notes in clusters too small to report. '
  + 'It always forms up to max_groups groups, so one kind is often split across several (by the app it was exported from, or how it is written): treat groups with the same shared features as one kind, using each group\'s nearest (its most similar other group) as a hint. Ask for fewer groups with max_groups, or split a mixed group with within. '
  + 'To act on a group, page its note ids with members_of and pass them as node_ids to query-nodes or to update-node (add_types, set_fields). '
  + 'Groups come from the search index\'s stored embeddings, which include each note\'s title and folder, and the same notes always give the same groups. Notes not embedded yet are counted in scope.not_indexed and left out. '
  + `Surveys are held in memory (the last ${SURVEY_LIMITS.storedSurveys}, lost on restart); NOT_FOUND for a survey_id means run the survey again. `
  + `Caps: ${SURVEY_LIMITS.maxNotes.toLocaleString('en-US')} notes, ${SURVEY_LIMITS.maxGroups} groups, ${SURVEY_LIMITS.maxSamples} samples, ${SURVEY_LIMITS.maxMemberPage} members per page. Proportional to the notes in scope: call it on demand, not routinely.`;

export function registerSurveyNodes(server: McpServer, db: Database.Database, settingsDir?: string): void {
  // The group reference is the one repeated sub-schema. Its id makes it a single definition
  // that `within` and `members_of` reference; `reused: 'ref'` would also hoist every described
  // property into a definition of its own.
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(surveyNodesRequestSchema, { io: 'input', target: 'draft-7' });
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'survey-nodes',
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
      const parsed = surveyNodesRequestSchema.safeParse(args);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        return fail('INVALID_PARAMS', `${where}${first?.message ?? 'invalid arguments'}`);
      }
      const { members_of: membersOf, limit, offset, ...request } = parsed.data;
      try {
        if (membersOf) {
          if (request.types || request.path_prefix || request.within || request.max_groups !== undefined || request.samples !== undefined) {
            return fail('INVALID_PARAMS', 'members_of lists one earlier group; it takes only limit and offset.');
          }
          return ok(surveyMembers(db, membersOf, {
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          }));
        }
        if (limit !== undefined || offset !== undefined) {
          return fail('INVALID_PARAMS', 'limit and offset page members_of; a survey takes max_groups and samples.');
        }
        const result = surveyNodes(db, request, settingsDir === undefined ? {} : { settingsDir });
        const warnings: Issue[] = result.scope.truncated
          ? [{
            code: 'RESULT_TRUNCATED',
            severity: 'warning',
            message: `More than ${SURVEY_LIMITS.maxNotes.toLocaleString('en-US')} notes are in scope; only the first ${SURVEY_LIMITS.maxNotes.toLocaleString('en-US')} by id were surveyed. Narrow it with path_prefix or types.`,
          }]
          : [];
        return ok(result, warnings);
      } catch (error) {
        if (error instanceof SurveyError) {
          return fail(error.code, error.message, error.details === undefined ? {} : { details: error.details });
        }
        return fail('INTERNAL_ERROR', 'Unable to survey notes.');
      }
    },
  );
}

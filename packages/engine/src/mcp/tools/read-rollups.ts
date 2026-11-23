import { ClassificationError } from '../../classification/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  readRollupsRequestSchema, rollupFieldsDescription, rollupFilterDescription, rollupFilterExample,
} from '../../rollups/compile.js';
import { DEFAULT_EXAMPLE_NAMES, exampleNamesFor, replaceDescriptions } from '../example-names.js';
import { readRollups } from '../../rollups/service.js';
import { RollupError } from '../../rollups/definitions.js';
import { SummaryError } from '../../summaries/errors.js';
import { fail } from './errors.js';
export function registerReadRollups(
  server: McpServer,
  db: Database.Database,
): void {
  const names = exampleNamesFor(db);
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(
    readRollupsRequestSchema,
    { io: 'input', target: 'draft-7', reused: 'ref' },
  );
  replaceDescriptions(advertised, new Map([
    [rollupFieldsDescription(DEFAULT_EXAMPLE_NAMES), rollupFieldsDescription(names)],
    [rollupFilterDescription(DEFAULT_EXAMPLE_NAMES), rollupFilterDescription(names)],
  ]));
  // Preserve domain validation envelopes through the SDK argument boundary.
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'read-rollups',
    {
      description:
        'Read live, schema-owned saved rollups and inverse relation lookups. Discover names with describe-schema include=[relationship_views]. Supply schema and selected rollups or relations; parent filters intersect the owning type. '
        + `Put typed field predicates under filter.fields, e.g. filter:${rollupFilterExample(names)}. `
        + 'Sort by id, title, or use sort:{by:"rollup",name:"selected_rollup_name",order:"desc"} before pagination; multiple rollups can be selected. Related items already include id, title, file_path and version. '
        + `relations[].fields selects additional scalar typed global fields (e.g. ${names.taskStatus}, ${names.due}); `
        + 'discover fields with describe-schema or list-global-fields. Caps: 8 metrics, 4 compiled relation descriptors, 100 parents/page, 10 lookup items, 1 MiB response. Definitions and source values share one read snapshot. Percentages expose numerator/denominator details; empty denominators are null. Date windows use inclusive from_days/exclusive to_days and require evaluation_context.time_zone, with optional as_of instant (calendar anchor, not historical data). Discover requires_evaluation_context on definitions. Values are computed, never editable node fields.',
      inputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        return readRollups(db, args);
      } catch (error) {
            if (error instanceof ClassificationError) return fail(error.code,error.message,{details:error.details as Record<string,unknown>});
        if (error instanceof RollupError || error instanceof SummaryError)
          return fail(error.code, error.message, { details: error.details });
        return fail('INTERNAL_ERROR', 'Unable to read saved rollups.');
      }
    },
  );
}

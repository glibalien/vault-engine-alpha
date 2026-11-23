import { ClassificationError } from '../../classification/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { summaryRequestSchema } from '../../summaries/input.js';
import { summarizeNodes } from '../../summaries/service.js';
import { SummaryError } from '../../summaries/errors.js';
import { fail } from './errors.js';
import { exampleNamesFor, type ExampleNames } from '../example-names.js';
/**
 * The relation example in the vault's own kinds (placeholders where the vault map says none).
 * It names no link field: the map designates none, and a project's tasks may link to it
 * through any reference field.
 */
function relationExample(n: ExampleNames): string {
    const task = JSON.stringify(n.task);
    const project = JSON.stringify(n.project);
    return `E.g. with ${project} parents, an incoming relation through the field that links ${task} nodes to them summarizes those per parent; with ${task} parents, an outgoing one looks up their ${project} nodes.`;
}
export function registerSummarizeNodes(server: McpServer, db: Database.Database): void {
    const { $schema: _dialect, ...advertised } = z.toJSONSchema(summaryRequestSchema, { io: 'input', target: 'draft-7', reused: 'ref' });
    // Preserve object arguments for domain validation, rather than letting the SDK
    // replace INVALID_PARAMS envelopes with its own pre-handler validation errors.
    // The SDK's protocol parser already drops an own top-level __proto__ key;
    // ordinary unknown keys survive for domain validation. Nested field records
    // remain untouched here and preserve arbitrary names in fieldRecordSchema.
    const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
    server.registerTool('summarize-nodes', {
        description: 'Read-only exact per-node summaries through a structured reference field. Select parents with filter and 1–4 named relations (as, direction, field, filter). Each relation requests count/min/max/percentage metrics and/or bounded scalar lookups. ' + relationExample(exampleNamesFor(db)) + ' Count distinct related nodes per parent; aggregate and sort before pagination. Date min/max requires date_mode=calendar_date and compares written calendar dates, not instants. Defaults: 50 parents; lookup 5 items; caps: 100 parents/page, 10,000 parents, 100,000 raw relationship rows across descriptors, 1 MiB response. Unresolved warnings are vault-wide per field. Percentage matching_filter selects a subset of the eligible relation; empty denominators return null with component counts. Relative date_window predicates use inclusive from_days and exclusive to_days; supply evaluation_context.time_zone and optionally an RFC3339 as_of instant. as_of anchors calendar comparison only, not historical source data. No stored fields or files are changed.',
        inputSchema, annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    }, (args) => {
        try {
            return summarizeNodes(db, args);
        }
        catch (error) {
            if (error instanceof ClassificationError) return fail(error.code,error.message,{details:error.details as Record<string,unknown>});
            if (error instanceof SummaryError)
                return fail(error.code, error.message, { details: error.details });
            return fail('INTERNAL_ERROR', 'Unable to compute node summaries.');
        }
    });
}

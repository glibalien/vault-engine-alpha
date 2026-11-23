import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  traversalRequestSchema,
  TraversalError,
} from '../../traversal/input.js';
import { traverseNodes } from '../../traversal/service.js';
import { SummaryError } from '../../summaries/errors.js';
import { fail } from './errors.js';
export function registerTraverseNodes(
  server: McpServer,
  db: Database.Database,
): void {
  const { $schema: _dialect, ...advertised } = z.toJSONSchema(
    traversalRequestSchema,
    { io: 'input', target: 'draft-7' },
  );
  const inputSchema = z.object({}).catchall(z.unknown()).meta(advertised);
  server.registerTool(
    'traverse-nodes',
    {
      description:
        'Read a dependency graph from one exact root_id through one structured reference field. direction=outgoing follows dependencies; incoming follows dependents. Returns shortest hop depths, original-direction edges, observed cyclic components and optional scalar include_fields. max_depth defaults to 4 (1–8); boundary nodes are returned but NOT expanded, so a limited graph cannot prove global acyclicity. Completed nodes are traversed too; edges do not determine status. Caps: 500 nodes, 2000 edges, 10000 raw rows, 1 MiB output; capacity overflow fails without partial data. No writes, prose links, predicates or pagination.',
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
        return traverseNodes(db, args);
      } catch (error) {
        if (error instanceof TraversalError || error instanceof SummaryError)
          return fail(error.code, error.message, { details: error.details });
        return fail('INTERNAL_ERROR', 'Unable to traverse nodes.');
      }
    },
  );
}

import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { classifyNodes } from '../../classification/read.js';
import { ClassificationError } from '../../classification/types.js';
import { ok, fail } from './errors.js';
const inputSchema = z.object({schema:z.string().min(1),field:z.string().min(1),node_ids:z.array(z.string().min(1)).min(1).max(200).refine(ids=>new Set(ids).size===ids.length)}).strict();
export function registerClassifyNodes(server: McpServer, db: Database.Database): void {
  server.tool('classify-nodes', 'Classify 1–200 distinct nodes in one explicit schema/enum-field context. Returns overlapping groups or an explicit unclassified reason; never changes values.', inputSchema.shape, async raw => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return fail('INVALID_PARAMS','Expected schema, field and 1–200 distinct node IDs.');
    try {
      const result = ok(classifyNodes(db,parsed.data));
      if (Buffer.byteLength(result.content[0].text) > 262144) return fail('CLASSIFICATION_LIMIT_EXCEEDED','Classification envelope exceeds 256 KiB. Request fewer nodes.');
      return result;
    } catch(error) {
      if (error instanceof ClassificationError) return fail(error.code,error.message,{details:error.details as Record<string,unknown>});
      return fail('INTERNAL_ERROR',error instanceof Error ? error.message : String(error));
    }
  });
}

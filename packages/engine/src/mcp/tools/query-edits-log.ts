import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ok, type Issue } from './errors.js';

const paramsShape = {
  node_id: z.string().optional().describe('Filter to a single node id'),
  since: z.string().optional().describe('ISO timestamp or relative duration (e.g. "1h", "30m", "7d")'),
  event_types: z.array(z.string()).optional().describe('Filter to specific event types (e.g. value-coerced, value-rejected, merge-conflict, field-defaulted, fields-orphaned)'),
  limit: z.number().default(100).describe('Max rows to return (max 1000)'),
  sort_order: z.enum(['asc', 'desc']).default('desc').describe('Sort by timestamp (default desc — newest first, the forensic default)'),
};

function parseRelativeTime(since: string): number | null {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
  return Date.now() - ms;
}

/**
 * A row's details as an object. Writers store a JSON object, but some rows hold
 * plain text (a `file-indexed` row's file path, an `index-error` or older
 * `reconciler-error` row's `<path>: <message>`) or JSON that is not an object.
 * Those come back as `{ text }` with the stored text unchanged, so one such row
 * does not fail the whole query (#512).
 */
export function parseEditsLogDetails(stored: string | null): Record<string, unknown> {
  if (stored === null || stored === '') return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain text: returned below.
  }
  return { text: stored };
}

export function registerQueryEditsLog(server: McpServer, db: Database.Database): void {
  server.tool(
    'query-edits-log',
    'Query the edits log — the forensic record of write-pipeline deviations (value coercions, rejected values, merge conflicts, defaulted/orphaned fields, discarded values). Read-only sibling of query-sync-log; keyed on node_id. value-removed discard records are retained forever (charter); other entries age out per EDITS_LOG_RETENTION_DAYS.',
    paramsShape,
    async (params) => {
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (params.node_id) {
        conditions.push('node_id = ?');
        bindings.push(params.node_id);
      }

      if (params.since) {
        let sinceMs = parseRelativeTime(params.since);
        if (sinceMs === null) {
          const parsed = Date.parse(params.since);
          if (!isNaN(parsed)) sinceMs = parsed;
        }
        if (sinceMs !== null) {
          conditions.push('timestamp >= ?');
          bindings.push(sinceMs);
        }
      }

      if (params.event_types && params.event_types.length > 0) {
        const placeholders = params.event_types.map(() => '?').join(',');
        conditions.push(`event_type IN (${placeholders})`);
        bindings.push(...params.event_types);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const order = params.sort_order === 'asc' ? 'ASC' : 'DESC';
      const limit = Math.min(params.limit ?? 100, 1000);

      const sql = `SELECT id, node_id, timestamp, event_type, details FROM edits_log ${where} ORDER BY timestamp ${order}, id ${order} LIMIT ?`;
      bindings.push(limit);

      const rows = db.prepare(sql).all(...bindings) as Array<{
        id: number;
        node_id: string | null;
        timestamp: number;
        event_type: string;
        details: string | null;
      }>;

      const parsed = rows.map(row => ({
        id: row.id,
        timestamp: row.timestamp,
        time: new Date(row.timestamp).toISOString(),
        node_id: row.node_id,
        event_type: row.event_type,
        details: parseEditsLogDetails(row.details),
      }));

      const count = parsed.length;
      const truncated = count === limit;
      const warnings: Issue[] = [];
      if (truncated) {
        warnings.push({
          code: 'RESULT_TRUNCATED',
          severity: 'warning',
          message: `Result truncated at limit (${count} rows)`,
          details: { count, limit },
        });
      }
      return ok({ rows: parsed, count, truncated }, warnings);
    },
  );
}

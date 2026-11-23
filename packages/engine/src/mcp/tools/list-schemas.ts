import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';

interface TypeRow {
  name: string;
  display_name: string | null;
  icon: string | null;
  filename_template: string | null;
  default_directory: string | null;
  has_schema: number;
  node_count: number;
  claim_count: number | null;
}

export function registerListSchemas(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-schemas',
    'Returns every type: each registered schema, including filename_template and default_directory so callers can route nodes to its conventional folder, and each type used on nodes without a schema (has_schema:false). Rows carry node_count and claim_count; schemas with no nodes yet are included.',
    {},
    async () => {
      const rows = db.prepare(`
        WITH names AS (SELECT name FROM schemas UNION SELECT schema_type FROM node_types)
        SELECT n.name, s.display_name, s.icon, s.filename_template, s.default_directory,
               s.name IS NOT NULL AS has_schema,
               (SELECT COUNT(*) FROM node_types nt WHERE nt.schema_type = n.name) AS node_count,
               CASE WHEN s.name IS NOT NULL
                 THEN (SELECT COUNT(*) FROM schema_field_claims c WHERE c.schema_name = n.name)
               END AS claim_count
          FROM names n LEFT JOIN schemas s ON s.name = n.name
         ORDER BY n.name
      `).all() as TypeRow[];

      return ok(rows.map(row => ({ ...row, has_schema: Boolean(row.has_schema) })));
    },
  );
}

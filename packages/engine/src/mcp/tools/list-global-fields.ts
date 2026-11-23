import { listGlobalFields } from '../../global-fields/crud.js';
import { globalClassificationHash } from '../../classification/definitions.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { ok } from './errors.js';

export function registerListGlobalFields(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-global-fields',
    'Returns all global field definitions.',
    {},
    async () => {
      const fields = listGlobalFields(db).map(field=>({name:field.name,field_type:field.field_type,description:field.description,enum_groups:field.enum_groups??null,enum_groups_hash:globalClassificationHash(field),overrides_allowed:{enum_groups:field.overrides_allowed.enum_groups===true}}));

      return ok(fields);
    },
  );
}

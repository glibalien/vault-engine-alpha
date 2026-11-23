import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createTestDb } from '../helpers/db.js';
import type Database from 'better-sqlite3';

const fakeProvider = { name: 'fake', search: async () => [] };
const has = (s: McpServer, name: string) => Boolean((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools[name]);

describe('web tools registration', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('registers fetch-url always and web-search only with a provider', () => {
    db = createTestDb();
    const withProvider = new McpServer({ name: 't', version: '0' });
    registerAllTools(withProvider, db, { webSearchProvider: fakeProvider });
    expect(has(withProvider, 'fetch-url')).toBe(true);
    expect(has(withProvider, 'web-search')).toBe(true);

    const withoutProvider = new McpServer({ name: 't', version: '0' });
    registerAllTools(withoutProvider, db);
    expect(has(withoutProvider, 'fetch-url')).toBe(true);
    expect(has(withoutProvider, 'web-search')).toBe(false);
  });
});

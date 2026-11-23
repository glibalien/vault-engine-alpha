import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb } from '../helpers/db.js';
import { seedSummaryFixture } from '../helpers/summary-fixture.js';
import { seedRollups } from '../helpers/rollup-fixture.js';
import { upgradeForResolvedTargetId } from '../../src/db/migrate.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';

it('discovers and reads rollups and traversal together through the complete MCP registry', async () => {
  const db = createTestDb();
  const server = new McpServer({ name: 'combined-relationships', version: '1' });
  const client = new Client({ name: 'integration-test', version: '1' });
  try {
    upgradeForResolvedTargetId(db);
    seedSummaryFixture(db);
    seedRollups(db);
    registerAllTools(server, db);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['describe-schema', 'read-rollups', 'traverse-nodes']));
    expect(new Set(names).size).toBe(names.length);
    const before = db.serialize();
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    expect(await call('describe-schema', { name: 'project', include: ['relationship_views'] }))
      .toMatchObject({ ok: true, data: { relationship_views: { state: 'valid' } } });
    const rollups = await call('read-rollups', { schema: 'project', rollups: ['open_task_count'] });
    expect(rollups.ok).toBe(true);
    expect(rollups.data.rows.find((row: { node: { id: string } }) => row.node.id === 'P1').rollups.open_task_count).toBe(2);
    const traversal = await call('traverse-nodes', {
      root_id: 'P1', field: 'project', direction: 'incoming', max_depth: 1,
    });
    expect(traversal).toMatchObject({ ok: true, data: { kind: 'node_traversal' } });
    expect(traversal.data.nodes.map((node: { id: string }) => node.id).sort()).toEqual(['P1', 'T1', 'T2', 'T3']);
    expect(db.serialize()).toEqual(before);
  } finally {
    await client.close();
    await server.close();
    db.close();
  }
});

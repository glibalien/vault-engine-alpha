import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { makeSummaryDb, summaryRequest } from '../helpers/summary-fixture.js';
import { registerSummarizeNodes } from '../../src/mcp/tools/summarize-nodes.js';
let db: Database.Database;
let server: McpServer;
let client: Client;
beforeEach(async () => {
    db = makeSummaryDb();
    server = new McpServer({ name: 'summary-test', version: '1' });
    registerSummarizeNodes(server, db);
    client = new Client({ name: 'test-client', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => { await client.close(); await server.close(); db.close(); });
async function call(args: Record<string, unknown>) {
    const r = await client.callTool({ name: 'summarize-nodes', arguments: args });
    return JSON.parse((r.content as Array<{
        text: string;
    }>)[0].text);
}
it('advertises a strict read-only contract and returns the actual computed result', async () => {
    const tool = (await client.listTools()).tools[0];
    expect(tool.name).toBe('summarize-nodes');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.required).toContain('relations');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(tool._meta).toBeUndefined();
    const r = await call(summaryRequest() as unknown as Record<string, unknown>);
    expect(r.ok).toBe(true);
    expect(r.data.rows[1].relations.outstanding_tasks.metrics.count).toBe(3);
});
it('returns argument failures in an INVALID_PARAMS envelope through the SDK', async () => {
    const r = await call({ ...summaryRequest(), extra: true });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' }, warnings: [] });
    expect(r).not.toHaveProperty('data');
});
it('preserves arbitrary nested field names through the SDK parsing boundary', async () => {
    const req = { ...summaryRequest(), filter: { fields: JSON.parse('{"__proto__":{"exists":false}}') } };
    const r = await call(req);
    expect(r.ok).toBe(true);
    expect(r.data.page.total).toBe(9);
    expect(r.data.definitions[0].as).toBe('all_tasks');
});
it('characterizes SDK protocol normalization of a reserved top-level key', async () => {
    const args = JSON.parse(JSON.stringify(summaryRequest()).slice(0, -1) + ',"__proto__":1}');
    const parsed = CallToolRequestSchema.parse({ method: 'tools/call', params: { name: 'summarize-nodes', arguments: args } });
    expect(Object.hasOwn(args, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.params.arguments!, '__proto__')).toBe(false);
    expect((await call(args)).ok).toBe(true);
});

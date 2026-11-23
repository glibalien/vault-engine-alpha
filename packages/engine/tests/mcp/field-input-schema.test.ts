import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createTestDb } from '../helpers/db.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerValidateNode } from '../../src/mcp/tools/validate-node.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { fieldRecordSchema } from '../../src/mcp/field-record-schema.js';

const values = JSON.parse('{"__proto__":"proto","constructor":"ctor","prototype":"type","___proto__":"prefixed","_constructor":"prefixed ctor","_proto__":"proto suffix","field:__proto__":"prefixed proto","field:":"prefix","":"empty"}') as Record<string, unknown>;
const filters = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { eq: value }]));

describe('fieldRecordSchema', () => {
  it('runs value transformations once, including for prototype field names', () => {
    let count = 0;
    const schema = fieldRecordSchema(z.string().transform(value => {
      count++;
      return value.toUpperCase();
    }));
    expect(schema.parse(values)).toEqual(Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, String(value).toUpperCase()]),
    ));
    expect(count).toBe(Object.keys(values).length);
  });

  it('advertises exactly the ordinary record input JSON schema', () => {
    const value = z.object({ exists: z.boolean().optional(), contains: z.string().optional() }).strict();
    const options = { io: 'input', target: 'draft-7' } as const;
    expect(z.toJSONSchema(fieldRecordSchema(value), options))
      .toEqual(z.toJSONSchema(z.record(z.string(), value), options));
  });

  it('restores error paths at every nested record level', () => {
    const schema = fieldRecordSchema(fieldRecordSchema(z.boolean()));
    const input = JSON.parse('{"__proto__":{"field:operator":"invalid"}}');
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['__proto__', 'field:operator']);
    }
  });
});

describe('MCP field input schemas', () => {
  let db: ReturnType<typeof createTestDb>;
  let server: McpServer;
  let registered: Record<string, RegisteredTool>;

  beforeEach(() => {
    db = createTestDb();
    server = new McpServer({ name: 'field-input-test', version: '1.0.0' });
    const lock = new WriteLockManager();
    registerCreateNode(server, db, lock, '/unused');
    registerUpdateNode(server, db, lock, '/unused');
    registerBatchMutate(server, db, lock, '/unused');
    registerValidateNode(server, db);
    registerQueryNodes(server, db);
    registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  const cases = [
    ['create-node', { title: 'Test', fields: values }, ['fields'], values],
    ['update-node', { node_id: 'test', set_fields: values }, ['set_fields'], values],
    ['validate-node', { proposed: { types: [], fields: values } }, ['proposed', 'fields'], values],
    ['batch-mutate', { operations: [{ op: 'create', params: { title: 'Test', fields: values } }] }, ['operations', 0, 'params', 'fields'], values],
    ['batch-mutate', { operations: [{ op: 'update', params: { node_id: 'test', set_fields: values } }] }, ['operations', 0, 'params', 'set_fields'], values],
    ['query-nodes', { fields: filters }, ['fields'], filters],
    ['query-nodes', { join_filters: [{ target: { fields: filters } }] }, ['join_filters', 0, 'target', 'fields'], filters],
    ['query-nodes', { without_joins: [{ target: { fields: filters } }] }, ['without_joins', 0, 'target', 'fields'], filters],
    ['update-node', { query: { fields: filters }, set_fields: values }, ['query', 'fields'], filters],
    ['update-node', { query: { join_filters: [{ target: { fields: filters } }] } }, ['query', 'join_filters', 0, 'target', 'fields'], filters],
    ['update-node', { query: { without_joins: [{ target: { fields: filters } }] } }, ['query', 'without_joins', 0, 'target', 'fields'], filters],
  ] as const;

  it.each(cases)('preserves own field names in %s at %j', (name, input, path, expected) => {
    const schema = registered[name].inputSchema as z.ZodType;
    let result: unknown = schema.parse(input);
    for (const key of path) result = (result as Record<string | number, unknown>)[key];
    expect(result).toEqual(expected);
    expect(Object.hasOwn(result as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.keys(result as object)).toEqual(Object.keys(expected));
  });

  it('does not promote inherited fields into the input map', () => {
    const fields = Object.assign(Object.create({ inherited: 'ignore' }), { own: 'keep' });
    const schema = registered['create-node'].inputSchema as z.ZodType<{ fields: Record<string, unknown> }>;
    expect(schema.parse({ title: 'Test', fields }).fields).toEqual({ own: 'keep' });
  });

  it.each([null, [], 'text', 1, true, new Date(), new Map(), new Set()])('rejects non-record fields %j', fields => {
    const schema = registered['create-node'].inputSchema as z.ZodType;
    expect(schema.safeParse({ title: 'Test', fields }).success).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('validates filter operators for %s', name => {
    const schema = registered['query-nodes'].inputSchema as z.ZodType;
    expect(schema.safeParse({ fields: Object.fromEntries([[name, { exists: 'invalid' }]]) }).success).toBe(false);
    expect(schema.safeParse({ fields: Object.fromEntries([[name, { typo: true }]]) }).success).toBe(false);
  });

  it.each(['status', '__proto__', 'field:status'])('reports the original filter path for %s', name => {
    const schema = registered['query-nodes'].inputSchema as z.ZodType;
    const result = schema.safeParse({ join_filters: [{ target: {
      fields: Object.fromEntries([[name, { exists: 'invalid' }]]),
    } }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['join_filters', 0, 'target', 'fields', name, 'exists']);
    }
  });

  it('preserves fields through the MCP SDK and advertises the unchanged record schema', async () => {
    // Replace only the handler: the real tool registration, schema conversion and
    // SDK argument validation still run before the echo callback sees its input.
    registered['query-nodes'].update({
      callback: async params => ({ content: [{ type: 'text', text: JSON.stringify(params) }] }),
    });
    const client = new Client({ name: 'field-input-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listing = await client.listTools();
      const inputSchema = listing.tools.find(tool => tool.name === 'query-nodes')!.inputSchema;
      const advertised = inputSchema.properties!.fields as Record<string, unknown>;
      expect(advertised.type).toBe('object');
      expect(advertised.additionalProperties).toMatchObject({
        type: 'object',
        properties: { exists: { type: 'boolean' }, contains: { type: 'string' } },
        additionalProperties: false,
      });
      const response = await client.callTool({ name: 'query-nodes', arguments: { fields: filters } });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text).fields).toEqual(filters);
    } finally {
      await client.close();
    }
  });
});

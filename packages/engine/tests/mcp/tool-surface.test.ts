import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createServer } from '../../src/mcp/server.js';
import { SERVICE_ONLY_TOOL_NAMES, type ToolSurface } from '../../src/mcp/tool-surface.js';

// Registration never calls into these collaborators; stubs let every optional tool register.
const stub = new Proxy({}, { get: () => () => undefined }) as never;

function fullyConfiguredServer(surface?: ToolSurface): McpServer {
  return createServer(createTestDb(), {
    writeLock: stub, syncLogger: stub, vaultPath: '/nonexistent-vault', attachmentDir: '/nonexistent-vault/Attachments',
    extractorRegistry: stub, extractionCache: stub, embeddingIndexer: stub, embedder: stub,
    memoryNoteProjection: stub, transcriptStore: stub, webSearchProvider: stub, usageRecorder: stub,
    settingsService: stub, settingsNoteDeps: stub, modelCatalog: stub,
    ...(surface ? { surface } : {}),
  });
}

async function connect(server: McpServer): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'surface-test', version: '0' });
  await client.connect(clientSide);
  return client;
}

async function toolNames(surface?: ToolSurface): Promise<string[]> {
  const client = await connect(fullyConfiguredServer(surface));
  return (await client.listTools()).tools.map(t => t.name).sort();
}

describe('tool surfaces', () => {
  it('names only tools that are actually registered', async () => {
    const full = await toolNames('full');
    expect(SERVICE_ONLY_TOOL_NAMES.filter(name => !full.includes(name))).toEqual([]);
    expect(new Set(SERVICE_ONLY_TOOL_NAMES).size).toBe(SERVICE_ONLY_TOOL_NAMES.length);
  });

  it('defaults to the full surface', async () => {
    expect(await toolNames()).toEqual(await toolNames('full'));
  });

  it('hides exactly the service-only tools from the external surface', async () => {
    const full = await toolNames('full');
    const external = await toolNames('external');
    expect(external).toEqual(full.filter(name => !SERVICE_ONLY_TOOL_NAMES.includes(name)));
    expect(external).toEqual(expect.arrayContaining(['query-nodes', 'get-node', 'update-node', 'create-schema']));
  });

  it('does not serve a hidden tool to an external session', async () => {
    const client = await connect(fullyConfiguredServer('external'));
    const outcome = await client.callTool({ name: 'list-boards', arguments: {} }).then(
      result => JSON.stringify(result),
      (error: unknown) => String(error),
    );
    expect(outcome).toMatch(/list-boards not found/);
    expect(outcome).not.toContain('"boards"');
  });

  it('restores the registration methods after filtering', () => {
    const server = fullyConfiguredServer('external');
    expect(server.tool).toBe(McpServer.prototype.tool);
    expect(server.registerTool).toBe(McpServer.prototype.registerTool);
  });
});

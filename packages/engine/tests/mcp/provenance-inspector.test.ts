import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerProvenance } from '../../src/mcp/tools/provenance.js';
import { inspectionFixture } from '../provenance/inspection-fixture.js';
import { encodeCursor } from '../../src/provenance/inspect.js';
import { clearDerivation } from '../../src/provenance/purge.js';
it('exposes bounded input reads and comparisons through the advertised MCP schema', async () => {
  const { db, inputId, prepared } = inspectionFixture();
  const server = new McpServer({ name: 'test', version: '1' }),
    client = new Client({ name: 'test', version: '1' });
  try {
    registerProvenance(server, db);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({
        name: 'inspect-provenance',
        arguments: args,
      });
      return JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    };
    expect(
      (await call({ select: 'status' })).data.inspection_features,
    ).toContain('input_text_v1');
    expect(
      await call({
        select: 'output',
        output_revision_id: 'output',
        include_comparisons: true,
      }),
    ).toMatchObject({
      ok: true,
      data: { inputs: [{ comparison: 'unchanged' }] },
    });
    const req = {
      select: 'input_text',
      output_revision_id: 'output',
      input_id: inputId,
      max_bytes: 4,
    };
    const first = await call(req);
    expect(first).toMatchObject({
      ok: true,
      data: { segments: [{ text: 'aé' }] },
    });
    db.transaction(() =>
      clearDerivation(
        db,
        prepared.derivation_id,
        'purged',
        new Date().toISOString(),
      ),
    )();
    expect(
      await call({ ...req, cursor: first.data.next_cursor }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        details: { reason: 'PROVENANCE_REVOKED' },
      },
    });
    expect(await call({ ...req, input_id: 'other' })).toMatchObject({
      ok: false,
      error: { details: { reason: 'PROVENANCE_UNAVAILABLE' } },
    });
  } finally {
    await client.close();
    await server.close();
    db.close();
  }
});

it('rejects a legacy node-history cursor over MCP and allows restarting without it', async () => {
  const { db } = inspectionFixture();
  const server = new McpServer({ name: 'test', version: '1' }),
    client = new Client({ name: 'test', version: '1' });
  try {
    registerProvenance(server, db);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'inspect-provenance', arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    const cursor = encodeCursor('node:home', ['2026-09-17T00:00:00Z', 'output']);
    expect(await call({ select: 'node', node_id: 'home', cursor })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS', details: { reason: 'PROVENANCE_LIMIT' } },
    });
    expect(await call({ select: 'node', node_id: 'home' })).toMatchObject({
      ok: true,
      data: { current_provenance: 'captured', outputs: [{ receipt: { output_revision_id: 'output' } }], next_cursor: null },
    });
  } finally {
    await client.close();
    await server.close();
    db.close();
  }
});

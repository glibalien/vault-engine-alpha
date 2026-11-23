/**
 * #285: the board table's list editor reaches update-node `reference_edit` through
 * @vault/query-core's client. Its unit tests use a fake client, so this pins the
 * wire shapes it reads against the real tool handlers: get-node's
 * `metadata.content_hash`, and the commit's top-level `version`,
 * `coerced_state` and `reference_edit.changed`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { makeClient } from '@vault/query-core';
import { referenceEditFixture } from '../helpers/reference-edit.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';

const fixtures: ReturnType<typeof referenceEditFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.cleanup()); });

function setup() {
  const f = referenceEditFixture(); fixtures.push(f);
  const callbacks = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const server = { tool: (name: string, _d: string, _s: unknown, cb: (params: Record<string, unknown>) => Promise<unknown>) => { callbacks.set(name, cb); } } as unknown as McpServer;
  registerUpdateNode(server, f.db, f.writeLock, f.vaultPath, new SyncLogger(f.db));
  registerGetNode(server, f.db);
  const client = makeClient(async ({ name, arguments: args }) => await callbacks.get(name)!(args) as CallToolResult);
  return { ...f, client };
}

describe('query-core editReferenceMember against the real tools', () => {
  it('adds by node id, then removes by stored text with the hash from get-node metadata', async () => {
    const f = setup();
    const before = await f.client.getNode({ node_id: f.taskId });
    if (!before.ok) throw new Error(before.error.message);
    expect(before.data.metadata?.content_hash).toBe(f.source().content_hash);

    const added = await f.client.editReferenceMember({
      node_id: f.taskId,
      reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[1]! } },
      expected_version: before.data.version,
    });
    if (!added.ok) throw new Error(added.error.message);
    expect(added.data.reference_edit.changed).toBe(true);
    expect(added.data.coerced_state.project?.value).toEqual(['P1', 'P2']);
    expect(added.data.version).toBe(before.data.version + 1);
    expect(f.members()).toEqual(['P1', 'P2']);

    const fresh = await f.client.getNode({ node_id: f.taskId });
    if (!fresh.ok) throw new Error(fresh.error.message);
    const removed = await f.client.editReferenceMember({
      node_id: f.taskId,
      reference_edit: { field: 'project', action: 'remove', target: { stored_value: 'P1' } },
      expected_version: added.data.version,
      expected_content_hash: fresh.data.metadata!.content_hash!,
    });
    if (!removed.ok) throw new Error(removed.error.message);
    expect(removed.data.coerced_state.project?.value).toEqual(['P2']);
    expect(f.members()).toEqual(['P2']);
  });

  it('previews an add or a remove without writing, and says whether it would change (bulk link ops)', async () => {
    const f = setup();
    const version = f.source().version;
    const add = await f.client.previewReferenceMember({
      node_id: f.taskId, reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[1]! } }, expected_version: version,
    });
    if (!add.ok) throw new Error(add.error.message);
    expect(add.data).toMatchObject({ dry_run: true, reference_edit: { outcome: 'added', would_change: true } });
    const present = await f.client.previewReferenceMember({
      node_id: f.taskId, reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[0]! } }, expected_version: version,
    });
    if (!present.ok) throw new Error(present.error.message);
    expect(present.data.reference_edit).toMatchObject({ outcome: 'already_present', would_change: false });
    const remove = await f.client.previewReferenceMember({
      node_id: f.taskId, reference_edit: { field: 'project', action: 'remove', target: { node_id: f.projectIds[0]! } }, expected_version: version,
    });
    if (!remove.ok) throw new Error(remove.error.message);
    expect(remove.data.reference_edit).toMatchObject({ outcome: 'removed', would_change: true });
    expect(f.members()).toEqual(['P1']);
    expect(f.source().version).toBe(version);
  });

  it('refuses a stale version with STALE_NODE and changes nothing', async () => {
    const f = setup();
    const before = f.source();
    const stale = await f.client.editReferenceMember({
      node_id: f.taskId,
      reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[1]! } },
      expected_version: before.version + 5,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    expect(f.members()).toEqual(['P1']);
  });

  it('reports an already-present link as unchanged', async () => {
    const f = setup();
    const same = await f.client.editReferenceMember({
      node_id: f.taskId,
      reference_edit: { field: 'project', action: 'add', target: { node_id: f.projectIds[0]! } },
      expected_version: f.source().version,
    });
    if (!same.ok) throw new Error(same.error.message);
    expect(same.data.reference_edit.changed).toBe(false);
    expect(f.members()).toEqual(['P1']);
  });
});

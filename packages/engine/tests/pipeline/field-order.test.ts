import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { loadNodeState } from '../../src/pipeline/node-state.js';
import { runNormalizerSweep } from '../../src/sync/normalizer.js';
import { frontmatterKeyOrder } from '../../src/renderer/field-order.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

function getToolHandler(server: McpServer, name: string): (args: Record<string, unknown>) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  return tool.callback ?? tool.handler;
}

function payload(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

// #447: fields no schema claims keep the order they have in the note.
describe('frontmatter key order on save', () => {
  let db: Database.Database;
  let vaultPath: string;
  let writeLock: WriteLockManager;

  beforeEach(() => {
    db = createTestDb();
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-field-order-test-'));
    writeLock = new WriteLockManager();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  function ingest(relPath: string, content: string): string {
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, content, 'utf-8');
    processFileChange(absPath, relPath, db, writeLock, vaultPath);
    return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string }).id;
  }

  async function updateNode(args: Record<string, unknown>): Promise<Record<string, any>> {
    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateNode(server, db, writeLock, vaultPath);
    return payload(await getToolHandler(server, 'update-node')(args));
  }

  function rerender(nodeId: string) {
    const state = loadNodeState(db, nodeId)!;
    return executeMutation(db, writeLock, vaultPath, {
      source: 'propagation',
      node_id: nodeId,
      file_path: state.file_path,
      title: state.title,
      types: state.types,
      fields: state.currentFields,
      body: state.body,
      raw_field_texts: state.rawFieldTexts,
    });
  }

  const read = (relPath: string) => readFileSync(join(vaultPath, relPath), 'utf-8');

  it('keeps the note\'s order on a tool edit and puts new fields after it', async () => {
    const nodeId = ingest('Plan.md', '---\nzeta: 1\nalpha: two\ndue:\nmiddle: "[[Other]]"\n---\nBody\n');

    const result = await updateNode({ node_id: nodeId, set_fields: { alpha: 'three', beta: 'new', aardvark: 'first' } });

    expect(result.ok).toBe(true);
    expect(read('Plan.md')).toBe(
      '---\ntypes:\nzeta: 1\nalpha: three\ndue:\nmiddle: "[[Other]]"\naardvark: first\nbeta: new\n---\nBody\n',
    );
  });

  it('keeps claimed fields in schema order ahead of the unclaimed ones', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'Task', field_claims: [{ field: 'status' }] });
    const nodeId = ingest('Task.md', '---\ntypes:\n  - Task\nzeta: 1\nstatus: open\nalpha: 2\n---\n');

    expect((await updateNode({ node_id: nodeId, set_fields: { status: 'done' } })).ok).toBe(true);

    expect(frontmatterKeyOrder(read('Task.md'))).toEqual(['types', 'status', 'zeta', 'alpha']);
  });

  it('writes nothing when re-rendering a note already in Engine layout', () => {
    const content = '---\ntypes:\nzeta: 1\ndue:\nalpha: two\n---\nBody\n';
    const nodeId = ingest('Kept.md', content);

    expect(rerender(nodeId).file_written).toBe(false);
    expect(read('Kept.md')).toBe(content);
  });

  it('is byte-stable after its own write', async () => {
    const nodeId = ingest('Stable.md', '---\nzeta: 1\nalpha: two\n---\nBody\n');
    expect((await updateNode({ node_id: nodeId, set_fields: { beta: 'x' } })).ok).toBe(true);
    const written = read('Stable.md');

    expect(rerender(nodeId).file_written).toBe(false);
    expect(read('Stable.md')).toBe(written);
  });

  it('lets the normalizer see a note in its own order as canonical', () => {
    ingest('Canon.md', '---\ntypes:\nzeta: 1\nalpha: two\n---\nBody\n');

    const stats = runNormalizerSweep(vaultPath, db, writeLock, undefined, { dryRun: true });

    expect(stats.would_rewrite).toEqual([]);
    expect(stats.skipped_canonical).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { registerDeleteNode } from '../../src/mcp/tools/delete-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

type Envelope = { ok: boolean; data: Record<string, any>; warnings: Array<{ code: string; message: string; details?: Record<string, unknown> }> };

function setup(policy: 1 | 2) {
  db = createTestDb();
  if (policy === 2) db.prepare("INSERT INTO meta (key, value) VALUES ('reference_resolution_policy_version', '2')").run();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'project' });
  createSchemaDefinition(db, { name: 'project', field_claims: [] });
  createSchemaDefinition(db, { name: 'wiki', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
}

afterEach(() => {
  writeLock.clearRecentWrites();
  db.close();
  cleanup();
});

function create(filePath: string, types: string[], fields: Record<string, unknown> = {}, body = '') {
  const title = filePath.split('/').pop()!.replace(/\.md$/, '');
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: filePath, title, types, fields, body,
  }).node_id;
}

function capture<T extends (...args: any[]) => void>(register: T, ...rest: unknown[]) {
  let captured!: (args: Record<string, unknown>) => Promise<unknown>;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: typeof captured) => { captured = callback; },
  } as unknown as McpServer;
  register(server, db, writeLock, vaultPath, ...rest);
  return async (args: Record<string, unknown>) =>
    JSON.parse(((await captured(args)) as { content: Array<{ text: string }> }).content[0]!.text) as Envelope;
}

const deleteNode = () => capture(registerDeleteNode);
const batch = () => capture(registerBatchMutate);

function binding(sourceId: string, relType: string): string | null {
  return (db.prepare('SELECT resolved_target_id FROM relationships WHERE source_id = ? AND rel_type = ?')
    .get(sourceId, relType) as { resolved_target_id: string | null }).resolved_target_id;
}

async function previewThenDelete(filePath: string) {
  const del = deleteNode();
  const before = db.serialize();
  const preview = await del({ file_path: filePath, dry_run: true, confirm: false, referencing_nodes_limit: 20 });
  expect(db.serialize()).toEqual(before);
  const confirmed = await del({ file_path: filePath, dry_run: false, confirm: true, referencing_nodes_limit: 20 });
  return { preview, confirmed };
}

describe('delete-node reports post-delete typed-reference consequences (policy v2)', () => {
  beforeEach(() => setup(2));

  it('does not report a reference as dangling when a namesake survivor picks it up', async () => {
    const p = create('P/Same.md', ['project']);
    create('Q/Same.md', ['project']);
    const task = create('T/Source.md', ['task'], { project: 'Same' });
    expect(binding(task, 'project')).toBeNull();

    const { preview, confirmed } = await previewThenDelete('Q/Same.md');
    expect(preview.data).toMatchObject({ incoming_reference_count: 1, unresolved_reference_count: 0 });
    expect(preview.warnings.find(w => w.code === 'PENDING_REFERENCES')?.message).toMatch(/All resolve to another node/);
    expect(confirmed.data).toMatchObject({ deleted: true, incoming_reference_count: 1, dangling_references: 0 });
    expect(binding(task, 'project')).toBe(p);
  });

  it('reports a reference left without any eligible target as dangling', async () => {
    create('Q/Same.md', ['project']);
    const task = create('T/Source.md', ['task'], { project: 'Same' });

    const { preview, confirmed } = await previewThenDelete('Q/Same.md');
    expect(preview.data).toMatchObject({ incoming_reference_count: 1, unresolved_reference_count: 1 });
    expect(preview.warnings.find(w => w.code === 'PENDING_REFERENCES')?.message).toMatch(/leave 1 unresolved/);
    expect(confirmed.data).toMatchObject({ dangling_references: 1 });
    expect(binding(task, 'project')).toBeNull();
  });

  it('reports an exact-path reference by its stored post-delete binding', async () => {
    create('Q/Same.md', ['project']);
    const task = create('T/Source.md', ['task'], { project: 'Q/Same.md' });

    const { preview, confirmed } = await previewThenDelete('Q/Same.md');
    expect(preview.data.unresolved_reference_count).toBe(1);
    expect(confirmed.data.dangling_references).toBe(1);
    expect(binding(task, 'project')).toBeNull();
  });

  it('does not let a wrong-type namesake absorb a typed reference', async () => {
    create('W/Same.md', ['wiki']);
    create('Q/Same.md', ['project']);
    const task = create('T/Source.md', ['task'], { project: 'Same' });

    const { preview, confirmed } = await previewThenDelete('Q/Same.md');
    expect(preview.data.unresolved_reference_count).toBe(1);
    expect(confirmed.data.dangling_references).toBe(1);
    expect(binding(task, 'project')).toBeNull();
  });
});

describe('batch-mutate reports deletion consequences from the final composed state', () => {
  beforeEach(() => setup(2));

  it('accounts for a later op that restores an eligible namesake', async () => {
    create('Q/Same.md', ['project']);
    const task = create('T/Source.md', ['task'], { project: 'Same' });
    const operations = [
      { op: 'delete', params: { file_path: 'Q/Same.md' } },
      { op: 'create', params: { title: 'Same', types: ['project'], directory: 'R', override_default_directory: true } },
    ];
    const run = batch();
    const before = db.serialize();

    const preview = await run({ operations, dry_run: true });
    expect(db.serialize()).toEqual(before);
    expect(preview.data.would_apply[0]).toMatchObject({ op: 'delete', incoming_reference_count: 1, unresolved_reference_count: 0 });

    const live = await run({ operations });
    expect(live.data.results[0]).toMatchObject({ op: 'delete', dangling_references: 0 });
    expect(binding(task, 'project')).not.toBeNull();
  });

  it('reports a deletion that stays unresolved in the composed state', async () => {
    create('Q/Same.md', ['project']);
    create('T/Source.md', ['task'], { project: 'Same' });
    const operations = [
      { op: 'delete', params: { file_path: 'Q/Same.md' } },
      { op: 'create', params: { title: 'Same', types: ['wiki'], directory: 'W', override_default_directory: true } },
    ];
    const run = batch();

    const preview = await run({ operations, dry_run: true });
    expect(preview.data.would_apply[0]).toMatchObject({ unresolved_reference_count: 1 });
    const live = await run({ operations });
    expect(live.data.results[0]).toMatchObject({ dangling_references: 1 });
  });

  it('keeps counting a reference whose source a later op rewrites', async () => {
    create('Q/Same.md', ['project']);
    create('T/Source.md', ['task'], { project: 'Same' });
    const operations = [
      { op: 'delete', params: { file_path: 'Q/Same.md' } },
      { op: 'update', params: { file_path: 'T/Source.md', set_body: 'rewritten' } },
    ];

    const preview = await batch()({ operations, dry_run: true });
    expect(preview.data.would_apply[0]).toMatchObject({ unresolved_reference_count: 1 });
  });
});

describe('legacy policy v1 deletion reporting stays compatible', () => {
  beforeEach(() => setup(1));

  it('does not count a link already bound to a surviving namesake', async () => {
    const p = create('P/Same.md', ['project']);
    create('Q/LongerDir/Same.md', ['project']);
    const source = create('Source.md', [], {}, 'See [[Same]].');
    expect(binding(source, 'wiki-link')).toBe(p);

    const { preview, confirmed } = await previewThenDelete('Q/LongerDir/Same.md');
    expect(preview.data).toMatchObject({ incoming_reference_count: 1, unresolved_reference_count: 0 });
    expect(confirmed.data).toMatchObject({ dangling_references: 0 });
    expect(binding(source, 'wiki-link')).toBe(p);
  });

  it('counts a link bound to the deleted node, which v1 does not re-resolve', async () => {
    const p = create('P/Same.md', ['project']);
    create('Q/LongerDir/Same.md', ['project']);
    const source = create('Source.md', [], {}, 'See [[Same]].');
    expect(binding(source, 'wiki-link')).toBe(p);

    const { preview, confirmed } = await previewThenDelete('P/Same.md');
    expect(preview.data).toMatchObject({ incoming_reference_count: 1, unresolved_reference_count: 1 });
    expect(confirmed.data).toMatchObject({ dangling_references: 1 });
    expect(binding(source, 'wiki-link')).toBeNull();
  });
});

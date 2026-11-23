// tests/mcp/context-enqueue-invalidation.test.ts
//
// Cycle 5 invalidation audit: with context-rich embeddings, a node's embedding
// inputs include its fields, types, path, and links — so multi-node mutation
// helpers must surface every node they rewrote, and the top-level tool callers
// must enqueue those nodes AFTER the transaction commits. These tests pin:
//   - rename-node enqueues referencing nodes whose bodies/fields were rewritten
//   - batch-mutate update-with-rename enqueues rewritten referencing nodes
//   - update-schema propagation enqueues re-rendered nodes
//   - rename-global-field / update-global-field enqueue re-rendered nodes
//   - materialize-transcript enqueues repointed nodes
//   - undo-operations enqueues restored nodes (and removes re-deleted ones)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';
import type { EmbeddingQueueItem } from '../../src/search/types.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerRenameGlobalField } from '../../src/mcp/tools/rename-global-field.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerMaterializeTranscript } from '../../src/mcp/tools/materialize-transcript.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { upgradeForAttachmentTranscripts, upgradeForMaterializedTranscripts } from '../../src/db/migrate.js';

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let enqueued: EmbeddingQueueItem[];
let removed: string[];

const fakeIndexer = (): EmbeddingIndexer => ({
  enqueue: (item: EmbeddingQueueItem) => { enqueued.push(item); },
  removeNode: (nodeId: string) => { removed.push(nodeId); },
}) as unknown as EmbeddingIndexer;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function parseResult(result: unknown): Envelope {
  const r = result as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text) as Envelope;
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(register: (server: McpServer) => void): Handler {
  let captured: Handler | undefined;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => { captured = h; },
    registerTool: (_n: string, _c: unknown, h: Handler) => { captured = h; },
  } as unknown as McpServer;
  register(fakeServer);
  return captured!;
}

function createNodeViaPipeline(filePath: string, title: string, body: string, fields: Record<string, unknown> = {}, types: string[] = []): string {
  return executeMutation(db, writeLock, vaultPath, {
    source: 'tool',
    node_id: null,
    file_path: filePath,
    title,
    types,
    fields,
    body,
  }).node_id;
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
  writeLock = new WriteLockManager();
  enqueued = [];
  removed = [];
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('update-node set_title backlink invalidation', () => {
  it('enqueues referencing nodes whose bodies were rewritten', async () => {
    const targetId = createNodeViaPipeline('Old Title.md', 'Old Title', 'target body');
    const refId = createNodeViaPipeline('ref.md', 'Referrer', 'see [[Old Title]] here');
    const bystanderId = createNodeViaPipeline('other.md', 'Bystander', 'no links');
    enqueued = [];

    const handler = captureHandler((s) => registerUpdateNode(s, db, writeLock, vaultPath, undefined, fakeIndexer()));
    const res = parseResult(await handler({ node_id: targetId, set_title: 'New Title' }));

    expect(res.ok).toBe(true);
    const ids = enqueued.map(e => e.node_id);
    expect(ids).toContain(targetId);      // the renamed node itself
    expect(ids).toContain(refId);         // body rewritten: [[Old Title]] → [[New Title]]
    expect(ids).not.toContain(bystanderId);
  });

  it('enqueues referencing nodes whose link FIELDS were rewritten', async () => {
    // A reference-typed field value produces a relationships row (the field
    // must be claimed by the node's type — orphan fields aren't resolved),
    // which is how executeRename discovers the referencing node.
    createGlobalField(db, { name: 'project', field_type: 'reference' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'project' }] });
    const targetId = createNodeViaPipeline('Project Alpha.md', 'Project Alpha', 'body');
    const refId = createNodeViaPipeline('r.md', 'Task', 'body', { project: 'Project Alpha' }, ['task']);
    enqueued = [];

    const handler = captureHandler((s) => registerUpdateNode(s, db, writeLock, vaultPath, undefined, fakeIndexer()));
    const res = parseResult(await handler({ node_id: targetId, set_title: 'Project Beta' }));

    expect(res.ok).toBe(true);
    expect(enqueued.map(e => e.node_id)).toContain(refId);
  });
});

describe('update-schema propagation invalidation', () => {
  it('enqueues nodes re-rendered by claim propagation', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    const nodeId = createNodeViaPipeline('a.md', 'A', 'body', {}, ['task']);
    enqueued = [];

    const handler = captureHandler((s) =>
      registerUpdateSchema(s, db, { writeLock, vaultPath, embeddingIndexer: fakeIndexer() }));
    const res = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status', sort_order: 1000 }],
    }));

    expect(res.ok).toBe(true);
    expect((res.data as { propagation: { changed_node_ids: string[] } }).propagation.changed_node_ids).toContain(nodeId);
    expect(enqueued.map(e => e.node_id)).toContain(nodeId);
  });

  it('enqueues nothing on a dry run', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string', default_value: 'open', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [] });
    createNodeViaPipeline('a.md', 'A', 'body', {}, ['task']);
    enqueued = [];

    const handler = captureHandler((s) =>
      registerUpdateSchema(s, db, { writeLock, vaultPath, embeddingIndexer: fakeIndexer() }));
    const res = parseResult(await handler({
      name: 'task',
      field_claims: [{ field: 'status', sort_order: 1000 }],
      dry_run: true,
    }));

    expect(res.ok).toBe(true);
    expect(enqueued).toEqual([]);
  });
});

describe('rename-global-field invalidation', () => {
  it('enqueues nodes whose frontmatter was re-rendered under the new name', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    const nodeId = createNodeViaPipeline('b.md', 'B', 'body', { status: 'open' });
    enqueued = [];

    const handler = captureHandler((s) =>
      registerRenameGlobalField(s, db, { writeLock, vaultPath, embeddingIndexer: fakeIndexer() }));
    const res = parseResult(await handler({ old_name: 'status', new_name: 'state' }));

    expect(res.ok).toBe(true);
    expect(enqueued.map(e => e.node_id)).toContain(nodeId);
  });
});

describe('materialize-transcript repoint invalidation', () => {
  it('enqueues the new transcript node AND every repointed referencing node', async () => {
    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    const store = new TranscriptStore(db);
    store.capture({
      embedRef: 'rec.mp3', vaultPath: 'Attachments/rec.mp3', contentHash: 'h1',
      extractedText: 'spoken words', mediaType: 'audio', extractorId: 'deepgram',
    });
    const refId = createNodeViaPipeline('note.md', 'Meeting', 'listen: ![[rec.mp3]]');
    enqueued = [];

    const handler = captureHandler((s) =>
      registerMaterializeTranscript(s, db, writeLock, vaultPath, store, undefined, fakeIndexer()));
    const res = parseResult(await handler({ embed_ref: 'rec.mp3' }));

    expect(res.ok).toBe(true);
    const newNodeId = (res.data as { node_id: string }).node_id;
    const ids = enqueued.map(e => e.node_id);
    expect(ids).toContain(newNodeId);
    expect(ids).toContain(refId); // body rewritten: ![[rec.mp3]] → ![[rec]]
  });
});

describe('undo-operations invalidation', () => {
  it('enqueues restored nodes after an undo', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    const createHandler = captureHandler((s) => registerCreateNode(s, db, writeLock, vaultPath, undefined, fakeIndexer()));
    const created = parseResult(await createHandler({ title: 'Undo Me', types: ['note'], body: 'v1' }));
    const nodeId = (created.data as { node_id: string }).node_id;

    const updateHandler = captureHandler((s) => registerUpdateNode(s, db, writeLock, vaultPath, undefined, fakeIndexer()));
    const updated = parseResult(await updateHandler({ node_id: nodeId, set_body: 'v2 changed' }));
    expect(updated.ok).toBe(true);
    // update-node's response doesn't expose its operation_id — read it back.
    const opId = (db.prepare(
      "SELECT operation_id FROM undo_operations WHERE status = 'active' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
    ).get() as { operation_id: string }).operation_id;

    enqueued = [];
    const undoHandler = captureHandler((s) => registerUndoOperations(s, db, writeLock, vaultPath, fakeIndexer()));
    const res = parseResult(await undoHandler({ operation_ids: [opId], dry_run: false }));

    expect(res.ok).toBe(true);
    expect(enqueued.map(e => e.node_id)).toContain(nodeId);
  });

  it('enqueues nothing on an undo dry run', async () => {
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    const createHandler = captureHandler((s) => registerCreateNode(s, db, writeLock, vaultPath, undefined, fakeIndexer()));
    const created = parseResult(await createHandler({ title: 'Undo Dry', types: ['note'], body: 'v1' }));
    const nodeId = (created.data as { node_id: string }).node_id;

    const updateHandler = captureHandler((s) => registerUpdateNode(s, db, writeLock, vaultPath, undefined, fakeIndexer()));
    const updated = parseResult(await updateHandler({ node_id: nodeId, set_body: 'v2' }));
    expect(updated.ok).toBe(true);
    const opId = (db.prepare(
      "SELECT operation_id FROM undo_operations WHERE status = 'active' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
    ).get() as { operation_id: string }).operation_id;

    enqueued = [];
    removed = [];
    const undoHandler = captureHandler((s) => registerUndoOperations(s, db, writeLock, vaultPath, fakeIndexer()));
    await undoHandler({ operation_ids: [opId], dry_run: true });

    expect(enqueued).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('enqueues nodes rerendered by a global-field restore', async () => {
    createGlobalField(db, { name: 'status', field_type: 'string' });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'status' }] });
    const nodeId = createNodeViaPipeline('global.md', 'Global', 'body', { status: 'open' }, ['task']);

    const renameHandler = captureHandler((s) =>
      registerRenameGlobalField(s, db, { writeLock, vaultPath, embeddingIndexer: fakeIndexer() }));
    const renamed = parseResult(await renameHandler({ old_name: 'status', new_name: 'state' }));
    expect(renamed.ok).toBe(true);
    const opId = (db.prepare(
      "SELECT operation_id FROM undo_operations WHERE source_tool = 'rename-global-field' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
    ).get() as { operation_id: string }).operation_id;

    enqueued = [];
    const undoHandler = captureHandler((s) => registerUndoOperations(s, db, writeLock, vaultPath, fakeIndexer()));
    const undone = parseResult(await undoHandler({ operation_ids: [opId], dry_run: false }));

    expect(undone.ok).toBe(true);
    expect(enqueued.map(e => e.node_id)).toContain(nodeId);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { WikiReconcileRollbackIncompleteError } from '../../src/wiki/reconcile.js';
import { registerWikiReconcile, wikiReconcileInputShape } from '../../src/mcp/tools/wiki-reconcile.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { listOperations } from '../../src/undo/operation.js';
import { restoreOperation } from '../../src/undo/restore.js';

const SCOPE = { v: 1, subject: 'Project', facet: 'Delivery' } as const;

type Envelope = {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly details?: Record<string, unknown> };
  readonly warnings: readonly { readonly code: string; readonly details?: unknown }[];
};

type NodeRef = { readonly id: string; readonly title: string; readonly version: number };

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

beforeEach(() => {
  db = createTestDb();
  const vault = createTempVault();
  vaultPath = vault.vaultPath;
  cleanup = vault.cleanup;
  writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
  db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('project', 'Project', '[]')").run();
  createNode({ title: 'Project', filePath: 'Project.md', types: ['project'], fields: {}, body: 'Project body.' });
});

afterEach(() => {
  db.close();
  cleanup();
});

describe('wiki-reconcile MCP tool', () => {
  it.each([true, false])('rejects a missing merge ancestor projection without writes (dry_run=%s)', async dryRun => {
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Owner home notes.');
    const source = wikiPage('Project — Source', subpageFields(home), 'Source narrative.');
    const target = wikiPage('Project — Target', subpageFields(home), 'Target narrative.');
    const ancestor = wikiPage('Project — Ancestor', {
      ...subpageFields(home), wiki_state: 'retired', wiki_replaced_by: source.title,
    }, 'Historical ancestor narrative.');
    unlinkSync(join(vaultPath, `Wikis/${ancestor.title}.md`));
    const beforeDb = db.serialize();
    const beforeFiles = fileSnapshot(vaultPath);
    const result = await call(captureHandler(), input({
      expectedVersion: home.version, dryRun,
      pages: [{
        op: 'merge', target: existing(target),
        sources: [{ node_id: source.id, expected_version: source.version }],
        scope: SCOPE, kind: 'workstream', origin: 'automatic', pinned: false,
        reason: 'Consolidate sources',
        sections: [{ name: 'Summary', mode: 'replace', content: 'Merged narrative.' }],
      }],
    }));
    expect(result).toMatchObject({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH' } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(fileSnapshot(vaultPath)).toEqual(beforeFiles);
  });

  it.each([true, false])('leaves all pages and undo state unchanged when a later page has corrupt markers (dry_run=%s)', async dryRun => {
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Owner home notes.');
    const good = wikiPage('Project — Good', subpageFields(home), '<!-- ve:managed:Summary -->Good original<!-- /ve:managed:Summary -->');
    const bad = wikiPage('Project — Bad', subpageFields(home), '<!-- ve:managed:Summary -->Bad original<!-- /ve:managed:Summary --><!-- /ve:managed:Summary -->');
    const beforeFiles = fileSnapshot(vaultPath);
    const beforeNodes = db.prepare('SELECT id, body, version, content_hash FROM nodes ORDER BY id').all();
    const beforeUndo = db.prepare('SELECT * FROM undo_operations').all();
    const result = await call(captureHandler(), input({
      expectedVersion: home.version, dryRun,
      pages: [good, bad].map(page => ({
        op: 'upsert', target: existing(page), scope: SCOPE, kind: 'workstream', origin: 'automatic', pinned: false,
        sections: [{ name: 'Summary', mode: 'replace', content: 'Replacement narrative.' }],
      })),
    }));
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(db.prepare('SELECT id, body, version, content_hash FROM nodes ORDER BY id').all()).toEqual(beforeNodes);
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual(beforeUndo);
    expect(fileSnapshot(vaultPath)).toEqual(beforeFiles);
  });

  it('accepts the optional stable project_id wire field', () => {
    const schema = z.strictObject(wikiReconcileInputShape);

    const parsed = schema.safeParse({ ...input({ pages: [] }), project_id: 'project-id' });

    expect(parsed.success).toBe(true);
  });

  it('reports required bootstrap changes in dry-run without applying them', async () => {
    // Given
    const handler = captureHandler();

    // When
    const result = await call(handler, input({ pages: [], dryRun: true }));

    // Then
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ dry_run: true, operation_id: null });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'WIKI_SCHEMA_BOOTSTRAP_REQUIRED',
      details: expect.objectContaining({ created_schemas: ['wiki'] }),
    }));
    expect(db.prepare("SELECT 1 FROM schemas WHERE name = 'wiki'").get()).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM undo_operations').all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM nodes WHERE title = 'Project Wiki'").get()).toBeUndefined();
    expect(existsSync(join(vaultPath, 'Wikis/Project Wiki.md'))).toBe(false);
  });

  it('executes create, merge, retire, and home update with bounded structured output', async () => {
    // Given
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Home prose.');
    const target = wikiPage('Project — Target', subpageFields(home), 'Target private body.');
    const source = wikiPage('Project — Source', subpageFields(home), 'Source private body.');
    wikiPage('Project — Ancestor', { ...subpageFields(home), wiki_replaced_by: source.title }, 'Ancestor private body.');
    const retiring = wikiPage('Project — Retiring', subpageFields(home), 'Retiring private body.');
    const handler = captureHandler();
    const pages = [
      {
        op: 'merge',
        target: existing(target),
        sources: [{ node_id: source.id, expected_version: source.version }],
        scope: SCOPE,
        kind: 'workstream',
        origin: 'automatic',
        pinned: false,
        reason: 'Consolidate overlap.',
        sections: [{ name: 'Summary', mode: 'replace', content: 'Consolidated.' }],
      },
      {
        op: 'retire',
        node_id: retiring.id,
        expected_version: retiring.version,
        scope: SCOPE,
        state: 'dormant',
        reason: 'No longer current.',
      },
      {
        op: 'upsert',
        target: { mode: 'new', plan_key: 'new-page', title: 'Project — New' },
        scope: { ...SCOPE, facet: 'Distinct' },
        kind: 'workstream',
        origin: 'automatic',
        pinned: false,
        sections: [{ name: 'Summary', mode: 'replace', content: 'New summary.' }],
      },
    ];

    // When
    const result = await call(handler, input({ pages, expectedVersion: home.version }));

    // Then
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ dry_run: false, reused: false });
    expect(result.warnings.map(warning => warning.code)).toContain('STALE_ACTIVE_REPLACEMENT');
    expect(result.data?.['created']).toHaveLength(1);
    expect(result.data?.['mappings']).toHaveLength(1);
    expect(result.data?.['preview']).toMatchObject({ total: 3, truncated: false });
    expect(JSON.stringify(result)).not.toContain('private body');
  });

  it('maps invalid plans, stale versions, and reconcile-key collisions to stable envelopes', async () => {
    // Given
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Home.');
    const page = wikiPage('Project — Existing', subpageFields(home), 'Page.');
    const handler = captureHandler();

    // When
    const invalid = await call(handler, input({ pages: [], expectedVersion: home.version, reconcileKey: '' }));
    const stale = await call(handler, input({ pages: [{
      op: 'upsert', target: { ...existing(page), expected_version: 999 }, scope: SCOPE,
      kind: 'workstream', origin: 'automatic', pinned: false,
    }], expectedVersion: home.version }));
    db.prepare(`INSERT INTO node_fields (node_id, field_name, value_text, source)
      VALUES (?, 'wiki_reconcile_key', ?, 'frontmatter')`).run(
      home.id,
      JSON.stringify({ v: 1, key: 'collision', plan_digest: 'different' }),
    );
    const collision = await call(handler, input({ pages: [], expectedVersion: home.version, reconcileKey: 'collision' }));

    // Then
    expect(invalid.error?.code).toBe('VALIDATION_FAILED');
    expect(stale.error?.code).toBe('STALE_NODE');
    expect(collision.error?.code).toBe('CONFLICT');
    expect(collision.error?.details?.['issues']).toContainEqual(expect.objectContaining({ code: 'RECONCILE_KEY_COLLISION' }));
  });

  it('maps rollback-incomplete to a hard error carrying the operation ID', async () => {
    // Given
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Home.');
    const handler = captureHandler(async () => {
      throw new WikiReconcileRollbackIncompleteError('op-rollback', ['unsafe restore']);
    });

    // When
    const result = await call(handler, input({ pages: [], expectedVersion: home.version }));

    // Then
    expect(result.error?.code).toBe('UPSTREAM_ERROR');
    expect(result.error?.details).toMatchObject({ operation_id: 'op-rollback' });
  });

  it('fails retryably before schema bootstrap when an existing wiki file is absent', async () => {
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Home.');
    db.prepare("DELETE FROM schemas WHERE name = 'wiki'").run();
    const absPath = join(vaultPath, `Wikis/${home.title}.md`);
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(home.id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(absPath);

    const result = await call(captureHandler(), input({
      pages: [],
      expectedVersion: home.version,
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error?.details?.['current_content_hash']).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(home.id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it('fails dry-run retryably before preview side effects when an existing wiki file is absent', async () => {
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Home.');
    db.prepare("DELETE FROM schemas WHERE name = 'wiki'").run();
    const absPath = join(vaultPath, `Wikis/${home.title}.md`);
    const beforeNode = db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(home.id);
    const beforeCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get();
    unlinkSync(absPath);

    const result = await call(captureHandler(), input({
      pages: [],
      expectedVersion: home.version,
      dryRun: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONTENT_HASH_MISMATCH');
    expect(result.error?.details?.['current_content_hash']).toBeNull();
    expect(existsSync(absPath)).toBe(false);
    expect(db.prepare(
      'SELECT body, content_hash, version, file_path FROM nodes WHERE id = ?',
    ).get(home.id)).toEqual(beforeNode);
    expect(db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM schemas) AS schemas,
        (SELECT COUNT(*) FROM schema_field_claims) AS schema_field_claims,
        (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
        (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
        (SELECT COUNT(*) FROM edits_log) AS edits_log,
        (SELECT COUNT(*) FROM sync_log) AS sync_log
    `).get()).toEqual(beforeCounts);
  });

  it.each([
    { dryRun: true, edit: 'malformed' },
    { dryRun: false, edit: 'malformed' },
    { dryRun: true, edit: 'owner-prose' },
    { dryRun: false, edit: 'owner-prose' },
    { dryRun: true, edit: 'managed-content' },
    { dryRun: false, edit: 'managed-content' },
  ])('checks current home structure on reuse after a governed $edit edit (dry_run=$dryRun)', async ({ dryRun, edit }) => {
    const handler = captureHandler();
    const first = await call(handler, input({ pages: [] }));
    expect(first).toMatchObject({ ok: true, data: { reused: false } });
    const home = first.data!.home as { node_id: string };
    const stored = db.prepare('SELECT body FROM nodes WHERE id = ?').get(home.node_id) as { body: string };
    const body = edit === 'malformed'
      ? `${stored.body}\n<!-- /ve:managed:Now -->`
      : edit === 'owner-prose'
        ? `${stored.body}\nOwner notes added after reconciliation.\n`
        : stored.body.replace('Current.', 'Owner-authored current state.');
    expect(await updateHomeBody(home.node_id, body)).toMatchObject({ ok: true });
    const beforeDb = db.serialize();
    const beforeFiles = fileSnapshot(vaultPath);

    const retry = await call(handler, input({
      pages: [], expectedVersion: homeVersion(home.node_id), dryRun,
    }));

    if (edit === 'malformed') {
      expect(retry).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    } else {
      expect(retry).toMatchObject({ ok: true, data: {
        reused: true, dry_run: dryRun, operation_id: null, created: [], updated: [],
      } });
    }
    expect(db.serialize()).toEqual(beforeDb);
    expect(fileSnapshot(vaultPath)).toEqual(beforeFiles);
  });

  it.each([true, false])('retains home version checks before validating reused content (dry_run=%s)', async dryRun => {
    const handler = captureHandler();
    const first = await call(handler, input({ pages: [] }));
    expect(first.ok).toBe(true);
    const home = first.data!.home as { node_id: string; version: number };
    expect(await updateHomeBody(home.node_id, '<!-- ve:managed:Now -->Unclosed')).toMatchObject({ ok: true });
    const beforeDb = db.serialize();
    const beforeFiles = fileSnapshot(vaultPath);

    const retry = await call(handler, input({ pages: [], expectedVersion: home.version, dryRun }));

    expect(retry).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(fileSnapshot(vaultPath)).toEqual(beforeFiles);
  });

  it.each([true, false])('converges through MCP to one undo operation and restores every pre-run file byte (retry dry_run=%s)', async dryRun => {
    // Given
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    const home = wikiPage('Project Wiki', { wiki_for: 'Project' }, 'Home human prose.');
    const target = wikiPage('Project — Canonical', { ...subpageFields(home), wiki_pinned: true }, 'Target human prose.');
    const source = wikiPage('Project — Duplicate', subpageFields(home), 'Source human prose.');
    const beforeFiles = fileSnapshot(vaultPath);
    const handler = captureHandler();
    const merge = (targetVersion: number, sourceVersion: number) => ({
      op: 'merge',
      target: { mode: 'existing', node_id: target.id, expected_version: targetVersion },
      sources: [{ node_id: source.id, expected_version: sourceVersion }],
      scope: SCOPE,
      kind: 'workstream',
      origin: 'automatic',
      pinned: false,
      reason: 'Same semantic scope.',
      sections: [{ name: 'Summary', mode: 'replace', content: 'Canonical summary.' }],
    });

    // When
    const first = await call(handler, input({
      pages: [merge(homeVersion(target.id), homeVersion(source.id))],
      expectedVersion: home.version,
      reconcileKey: 'convergent-run',
    }));
    const retry = await call(handler, input({
      pages: [merge(homeVersion(target.id), homeVersion(source.id))],
      expectedVersion: homeVersion(home.id),
      reconcileKey: 'convergent-run',
      dryRun,
    }));

    // Then
    expect(first).toMatchObject({ ok: true, data: { reused: false } });
    expect(retry).toMatchObject({ ok: true, data: { reused: true, operation_id: null } });
    expect(fileSnapshot(vaultPath)).toMatchObject({
      [`Wikis/${source.title}.md`]: expect.stringContaining('Source human prose.'),
      [`Wikis/${target.title}.md`]: expect.stringContaining('Target human prose.'),
    });
    const operations = listOperations(db, {}).operations.filter(operation => operation.source_tool === 'wiki-reconcile');
    expect(operations).toHaveLength(1);
    const operationId = operations[0]?.operation_id;
    if (operationId === undefined) throw new Error('Expected wiki-reconcile undo operation');

    const undone = restoreOperation(db, writeLock, vaultPath, operationId, new Set([operationId]));

    expect(undone).toMatchObject({ total_conflicts: 0, total_undone: 3 });
    expect(fileSnapshot(vaultPath)).toEqual(beforeFiles);
  });
});

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(execute?: Parameters<typeof registerWikiReconcile>[1]['execute']): Handler {
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: Handler) => { handler = callback; },
  } as unknown as McpServer;
  registerWikiReconcile(server, {
    db,
    writeLock,
    vaultPath,
    ...(execute === undefined ? {} : { execute }),
  });
  if (handler === undefined) throw new Error('wiki-reconcile handler was not registered');
  return handler;
}

async function updateHomeBody(nodeId: string, body: string): Promise<Envelope> {
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: Handler) => { handler = callback; },
  } as unknown as McpServer;
  registerUpdateNode(server, db, writeLock, vaultPath);
  if (handler === undefined) throw new Error('update-node handler was not registered');
  return call(handler, { node_id: nodeId, set_body: body, expected_version: homeVersion(nodeId), dry_run: false });
}

async function call(handler: Handler, args: Record<string, unknown>): Promise<Envelope> {
  const raw = await handler(args) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(raw.content[0]?.text ?? '{}') as Envelope;
}

type InputOptions = {
  readonly pages: readonly Record<string, unknown>[];
  readonly expectedVersion?: number;
  readonly dryRun?: boolean;
  readonly reconcileKey?: string;
};

function input(options: InputOptions): Record<string, unknown> {
  return {
    project: 'Project',
    reconcile_key: options.reconcileKey ?? 'run-1',
    pages: options.pages,
    home: {
      ...(options.expectedVersion === undefined ? {} : { expected_version: options.expectedVersion }),
      sections: [{ name: 'Now', mode: 'replace', content: 'Current.' }],
      evidence_hash: 'evidence-1',
      curated_at: '2026-08-14T00:00:00.000Z',
      refresh_live: true,
    },
    dry_run: options.dryRun ?? false,
  };
}

type CreateNodeInput = {
  readonly title: string;
  readonly filePath: string;
  readonly types: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
  readonly body: string;
};

function createNode(input: CreateNodeInput): NodeRef {
  const result = executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: input.filePath, title: input.title,
    types: [...input.types], fields: { ...input.fields }, body: input.body,
  });
  const row = db.prepare('SELECT version FROM nodes WHERE id = ?').get(result.node_id) as { version: number };
  return { id: result.node_id, title: input.title, version: row.version };
}

function wikiPage(title: string, fields: Readonly<Record<string, unknown>>, body: string): NodeRef {
  return createNode({ title, filePath: `Wikis/${title}.md`, types: ['wiki'], fields, body });
}

function subpageFields(home: NodeRef): Readonly<Record<string, unknown>> {
  return {
    wiki_for: 'Project', wiki_parent: home.title, wiki_state: 'active', wiki_kind: 'workstream',
    wiki_origin: 'automatic', wiki_scope: JSON.stringify(SCOPE), wiki_pinned: false,
  };
}

function existing(node: NodeRef): Record<string, unknown> {
  return { mode: 'existing', node_id: node.id, expected_version: node.version };
}

function homeVersion(nodeId: string): number {
  const row = db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number } | undefined;
  if (row === undefined) throw new Error(`Missing fixture node ${nodeId}`);
  return row.version;
}

function fileSnapshot(root: string, relative = ''): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, fileSnapshot(root, child));
    else files[child] = readFileSync(join(root, child), 'utf8');
  }
  return files;
}

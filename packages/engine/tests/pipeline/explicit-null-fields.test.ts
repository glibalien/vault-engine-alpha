import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerValidateNode } from '../../src/mcp/tools/validate-node.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';

function getToolHandler(server: McpServer, name: string): (args: Record<string, unknown>) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ?? tool.handler;
}

function payload(result: unknown): Record<string, any> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe('explicit YAML null fields', () => {
  let db: Database.Database;
  let vaultPath: string;
  let writeLock: WriteLockManager;

  function ingestExplicitNull(): string {
    const relPath = 'Project.md';
    const absPath = join(vaultPath, relPath);
    writeFileSync(absPath, '---\ntypes: [Project]\ncontext:\n---\nBody', 'utf-8');
    processFileChange(absPath, relPath, db, writeLock, vaultPath);
    return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string }).id;
  }

  function markerNames(nodeId: string): string[] {
    return (db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(nodeId) as Array<{ field_name: string }>).map(row => row.field_name);
  }

  async function updateNode(nodeId: string, setFields: Record<string, unknown>): Promise<Record<string, any>> {
    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateNode(server, db, writeLock, vaultPath);
    return payload(await getToolHandler(server, 'update-node')({ node_id: nodeId, set_fields: setFields }));
  }

  function defineRequiredContext(defaultValue?: string): void {
    createGlobalField(db, {
      name: 'context',
      field_type: 'string',
      required: true,
      ...(defaultValue === undefined ? {} : { default_value: defaultValue }),
    });
    createSchemaDefinition(db, {
      name: 'Project',
      field_claims: [{ field: 'context' }],
    });
  }

  beforeEach(() => {
    db = createTestDb();
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-explicit-null-test-'));
    writeLock = new WriteLockManager();
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('distinguishes an explicit YAML null from an absent field', async () => {
    const nodeId = ingestExplicitNull();

    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_explicit_null_fields'`,
    ).get()).toEqual({ name: 'node_explicit_null_fields' });
    expect(db.prepare(
      'SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name',
    ).all(nodeId)).toEqual([{ field_name: 'context' }]);

    const server = new McpServer({ name: 'test', version: '0' });
    registerGetNode(server, db);
    const result = payload(await getToolHandler(server, 'get-node')({ node_id: nodeId }));

    expect(result.ok).toBe(true);
    expect(result.data.fields.context).toEqual({
      value: null,
      type: 'null',
      source: 'frontmatter',
    });
  });

  it('preserves explicit null across an unrelated tool mutation', async () => {
    const nodeId = ingestExplicitNull();

    const result = await updateNode(nodeId, { status: 'active' });

    expect(result.ok).toBe(true);
    expect(markerNames(nodeId)).toEqual(['context']);
    expect(readFileSync(join(vaultPath, 'Project.md'), 'utf-8')).toContain('\ncontext:\n');
  });

  it('allows an unrelated tool mutation while preserving an invalid required explicit null', async () => {
    defineRequiredContext();
    const nodeId = ingestExplicitNull();

    const result = await updateNode(nodeId, { status: 'active' });

    expect(result.ok).toBe(true);
    expect(markerNames(nodeId)).toEqual(['context']);
    expect(db.prepare(
      'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'context')).toBeUndefined();
    expect(readFileSync(join(vaultPath, 'Project.md'), 'utf-8')).toContain('\ncontext:\n');
  });

  it('does not tolerate a required-null error when the request touches that marker', async () => {
    defineRequiredContext();
    const nodeId = ingestExplicitNull();

    const result = await updateNode(nodeId, { context: null });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(markerNames(nodeId)).toEqual(['context']);
  });

  it('does not let an untouched marker hide a validation error on another field', async () => {
    defineRequiredContext();
    createGlobalField(db, { name: 'estimate', field_type: 'number' });
    db.prepare(`
      INSERT INTO schema_field_claims (schema_name, field, sort_order)
      VALUES ('Project', 'estimate', 200)
    `).run();
    const nodeId = ingestExplicitNull();

    const result = await updateNode(nodeId, { estimate: 'not-a-number' });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION_FAILED');
    expect(markerNames(nodeId)).toEqual(['context']);
    expect(db.prepare(
      'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'estimate')).toBeUndefined();
  });

  it('does not materialize a default over an untouched explicit-null marker in dry-run or commit', async () => {
    defineRequiredContext('fallback');
    const nodeId = ingestExplicitNull();
    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateNode(server, db, writeLock, vaultPath);

    const dryRun = payload(await getToolHandler(server, 'update-node')({
      node_id: nodeId,
      set_fields: { status: 'active' },
      dry_run: true,
    }));
    expect(dryRun.ok).toBe(true);
    expect(dryRun.data.preview.coerced_state).not.toHaveProperty('context');

    const committed = payload(await getToolHandler(server, 'update-node')({
      node_id: nodeId,
      set_fields: { status: 'active' },
    }));
    expect(committed.ok).toBe(true);
    expect(markerNames(nodeId)).toEqual(['context']);
    expect(db.prepare(
      'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'context')).toBeUndefined();
  });

  it('treats a marker as authoritative over a conflicting value row during validation and mutation', async () => {
    defineRequiredContext('fallback');
    const nodeId = ingestExplicitNull();
    db.prepare(`
      INSERT INTO node_fields (node_id, field_name, value_text, source)
      VALUES (?, 'context', 'conflicting value', 'frontmatter')
    `).run(nodeId);

    const server = new McpServer({ name: 'test', version: '0' });
    registerValidateNode(server, db);
    registerUpdateNode(server, db, writeLock, vaultPath);

    const validation = payload(await getToolHandler(server, 'validate-node')({ node_id: nodeId }));
    expect(validation.ok).toBe(true);
    expect(validation.data.valid).toBe(false);
    expect(validation.data.coerced_state).not.toHaveProperty('context');
    expect(validation.data.issues).toContainEqual(expect.objectContaining({
      code: 'REQUIRED_MISSING',
      field: 'context',
    }));

    const updated = payload(await getToolHandler(server, 'update-node')({
      node_id: nodeId,
      set_fields: { status: 'active' },
    }));
    expect(updated.ok).toBe(true);
    expect(markerNames(nodeId)).toEqual(['context']);
    expect(db.prepare(
      'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'context')).toBeUndefined();
  });

  it('keeps query dry-run and live mutation aligned for untouched explicit nulls', async () => {
    defineRequiredContext('fallback');
    const nodeId = ingestExplicitNull();
    const server = new McpServer({ name: 'test', version: '0' });
    registerUpdateNode(server, db, writeLock, vaultPath);
    const handler = getToolHandler(server, 'update-node');

    const dryRun = payload(await handler({
      query: { node_ids: [nodeId] },
      set_fields: { status: 'active' },
      dry_run: true,
    }));
    expect(dryRun.ok).toBe(true);
    expect(dryRun.data.would_update).toBe(1);
    expect(dryRun.data.would_fail).toBe(0);

    const committed = payload(await handler({
      query: { node_ids: [nodeId] },
      set_fields: { status: 'active' },
      dry_run: false,
    }));
    expect(committed.ok).toBe(true);
    expect(committed.data.updated).toBe(1);
    expect(committed.data.errors).toEqual([]);
    expect(markerNames(nodeId)).toEqual(['context']);
    expect(db.prepare(
      'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'context')).toBeUndefined();
  });

  it('clears the marker when a tool sets a non-null value', async () => {
    const nodeId = ingestExplicitNull();

    const result = await updateNode(nodeId, { context: 'work' });

    expect(result.ok).toBe(true);
    expect(markerNames(nodeId)).toEqual([]);
    expect(db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'context')).toEqual({ value_text: 'work' });
  });

  it('keeps tool null as deletion of both value and marker representations', async () => {
    const nodeId = ingestExplicitNull();

    const result = await updateNode(nodeId, { context: null });

    expect(result.ok).toBe(true);
    expect(markerNames(nodeId)).toEqual([]);
    expect(db.prepare(
      'SELECT 1 FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(nodeId, 'context')).toBeUndefined();
    expect(readFileSync(join(vaultPath, 'Project.md'), 'utf-8')).not.toContain('\ncontext:');
  });
});

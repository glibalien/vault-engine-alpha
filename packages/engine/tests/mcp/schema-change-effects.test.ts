import { relationshipViewsHash } from '../../src/rollups/definitions.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, type UpdateSchemaInput } from '../../src/schema/crud.js';
import { readCurrentClaims, type ClaimDiffShape } from '../../src/schema/claims.js';
import { diffClaims } from '../../src/schema/propagate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';

let db: ReturnType<typeof createTestDb>;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let server: McpServer;
const claims = [{ field: 'status', sort_order: 1 }, { field: 'notes', sort_order: 2 }];

beforeEach(() => {
  db = createTestDb();
  ({ vaultPath, cleanup } = createTempVault());
  writeLock = new WriteLockManager();
  createGlobalField(db, {
    name: 'status', field_type: 'enum', enum_values: ['open', 'closed'],
    overrides_allowed: { required: true, default_value: true, enum_values: true, ai_guessable: true },
  });
  createGlobalField(db, { name: 'notes', field_type: 'string', overrides_allowed: { required: true, default_value: true } });
  createSchemaDefinition(db, { name: 'task', field_claims: claims });
  executeMutation(db, writeLock, vaultPath, {
    source: 'tool', node_id: null, file_path: 'Task.md', title: 'Task',
    types: ['task'], fields: { status: 'open', notes: 'Original' }, body: 'Body',
  });
  server = new McpServer({ name: 'schema-effects', version: '0' });
  registerUpdateSchema(server, db, { writeLock, vaultPath });
  registerDescribeSchema(server, db);
});

afterEach(() => { writeLock.clearRecentWrites(); db.close(); cleanup(); });

async function call(name: string, params: Record<string, unknown>) {
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  }> })._registeredTools;
  return JSON.parse((await tools[name].handler({ name: 'task', ...params })).content[0].text);
}

function nodesAndHistory() {
  return Object.fromEntries(['nodes', 'node_types', 'node_fields', 'node_explicit_null_fields',
    'relationships', 'edits_log', 'sync_log', 'undo_snapshots'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
}

const metadataChanges = [
  { label: 'Workflow state' }, { description: 'Current workflow stage' }, { ai_guessable: true },
];

const schemaMetadataChanges = {
  display_name: { display_name: 'Work item' },
  icon: { icon: 'check' },
  relationship_views: { relationship_views: {version:1,relations:[],rollups:[]}, expected_relationship_views_hash: relationshipViewsHash(undefined) },
  expected_relationship_views_hash: { expected_relationship_views_hash: relationshipViewsHash(undefined) },
  metadata: { metadata: { group: 'Work' } },
  filename_template: { filename_template: '{title}' },
  default_directory: { default_directory: 'Tasks' },
} satisfies Record<Exclude<keyof UpdateSchemaInput, 'field_claims'>, UpdateSchemaInput>;

describe('schema property effects', () => {
  it.each(metadataChanges.flatMap(change => ['replacement', 'patch'].flatMap(form =>
    ['present', 'missing', 'unindexed-edit'].map(fileState => ({ change, form, fileState })),
  )))('reports $change in $form preview without propagating to a $fileState projection', async ({ change, form, fileState }) => {
    const path = join(vaultPath, 'Task.md');
    if (fileState === 'missing') unlinkSync(path);
    else if (fileState === 'unindexed-edit') writeFileSync(path, 'Unindexed human content\n');
    const beforeFile = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const beforeDb = db.serialize();
    const beforeNodes = nodesAndHistory();
    const params = form === 'patch'
      ? { update_field_claims: [{ field: 'status', ...change }] }
      : { field_claims: [{ ...claims[0], ...change }, claims[1]] };

    const preview = await call('update-schema', { ...params, dry_run: true });
    expect(preview).toMatchObject({ ok: true, data: {
      claims_modified: ['status'], claims_added: [], claims_removed: [],
      propagation: { nodes_affected: 0, nodes_rerendered: 0, defaults_populated: 0, fields_orphaned: 0 },
    } });
    expect(db.serialize()).toEqual(beforeDb);

    const live = await call('update-schema', params);
    expect(live).toMatchObject({ ok: true, data: { propagation: { nodes_affected: 0, nodes_rerendered: 0 } } });
    expect(nodesAndHistory()).toEqual(beforeNodes);
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(beforeFile);
    expect(readCurrentClaims(db, 'task').find(claim => claim.field === 'status')).toMatchObject(change);
    expect((await call('describe-schema', {})).data.fields).toContainEqual(expect.objectContaining({ name: 'status', ...change }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM undo_schema_snapshots').get()).toEqual({ n: 1 });

    const unchanged = await call('update-schema', { ...params, dry_run: true });
    expect(unchanged).toMatchObject({ ok: true, data: { claims_modified: [], propagation: { nodes_affected: 0 } } });
  });

  it.each(Object.values(schemaMetadataChanges))('updates schema-level metadata $0 without requiring or moving existing projections', async change => {
    unlinkSync(join(vaultPath, 'Task.md'));
    const beforeDb = db.serialize();
    const beforeNodes = nodesAndHistory();
    expect(await call('update-schema', { ...change, dry_run: true }))
      .toMatchObject({ ok: true, data: { claims_modified: [], propagation: { nodes_affected: 0 } } });
    expect(db.serialize()).toEqual(beforeDb);
    const { relationship_views, expected_relationship_views_hash: _guard, ...stored } = change as UpdateSchemaInput;
    const result = await call('update-schema', change);
    expect(result).toMatchObject({ ok: true, data: stored });
    if (relationship_views !== undefined) expect(result.data.metadata).toMatchObject({ relationship_views_v1: relationship_views });
    expect(nodesAndHistory()).toEqual(beforeNodes);
    expect(existsSync(join(vaultPath, 'Task.md'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Tasks'))).toBe(false);
  });

  it('reports metadata removed by full replacement without touching a missing projection', async () => {
    expect(await call('update-schema', { update_field_claims: [{ field: 'status', label: 'State', description: 'Workflow' }] }))
      .toMatchObject({ ok: true });
    unlinkSync(join(vaultPath, 'Task.md'));
    const beforeDb = db.serialize();
    const beforeNodes = nodesAndHistory();
    expect(await call('update-schema', { field_claims: claims, dry_run: true }))
      .toMatchObject({ ok: true, data: { claims_modified: ['status'], propagation: { nodes_affected: 0 } } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(await call('update-schema', { field_claims: claims })).toMatchObject({ ok: true });
    expect(nodesAndHistory()).toEqual(beforeNodes);
    expect(readCurrentClaims(db, 'task').find(claim => claim.field === 'status'))
      .toMatchObject({ label: undefined, description: undefined });
  });

  it.each([false, true])('preserves propagation policy for existing required claims when metadata also changes (with default=%s)', async withDefault => {
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Sparse.md', title: 'Sparse',
      types: ['task'], fields: { status: 'open' }, body: 'Sparse body',
    });
    const beforeDb = db.serialize();
    const beforeFile = readFileSync(join(vaultPath, 'Sparse.md'), 'utf8');
    const change = { update_field_claims: [{
      field: 'notes', label: 'Details', required: true, ...(withDefault ? { default_value: 'Filled' } : {}),
    }] };
    const preview = await call('update-schema', { ...change, dry_run: true });
    expect(preview).toMatchObject({ ok: true, data: {
      claims_modified: ['notes'], propagation: { nodes_affected: 2, nodes_rerendered: 0, defaults_populated: 0 },
    } });
    expect(db.serialize()).toEqual(beforeDb);
    const live = await call('update-schema', change);
    expect(live).toMatchObject({ ok: true, data: {
      propagation: { nodes_affected: 2, nodes_rerendered: 0, defaults_populated: 0 },
    } });
    // Re-render paths tolerate missing required fields and do not backfill
    // defaults for existing claims. Adoption defaults belong to added claims.
    expect(readFileSync(join(vaultPath, 'Sparse.md'), 'utf8')).toBe(beforeFile);
    expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toContain('notes: Original');
  });

  it('still renders order changes combined with presentation metadata', async () => {
    const change = { update_field_claims: [{ field: 'status', sort_order: 3, label: 'Workflow' }] };
    const beforeDb = db.serialize();
    expect(await call('update-schema', { ...change, dry_run: true }))
      .toMatchObject({ ok: true, data: { claims_modified: ['status'], propagation: { nodes_affected: 1 } } });
    expect(db.serialize()).toEqual(beforeDb);
    expect(await call('update-schema', change))
      .toMatchObject({ ok: true, data: { propagation: { nodes_affected: 1, nodes_rerendered: 1 } } });
    const content = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
    expect(content.indexOf('notes:')).toBeLessThan(content.indexOf('status:'));
  });

  it('still rejects an invalid enum restriction combined with a description change', async () => {
    const change = { update_field_claims: [{ field: 'status', description: 'Closed work', enum_values_override: ['closed'] }] };
    const beforeDb = db.serialize();
    const beforeFile = readFileSync(join(vaultPath, 'Task.md'), 'utf8');
    for (const dry_run of [true, false]) {
      expect(await call('update-schema', { ...change, dry_run })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(db.serialize()).toEqual(beforeDb);
      expect(readFileSync(join(vaultPath, 'Task.md'), 'utf8')).toBe(beforeFile);
    }
  });
});

// Exhaustive over the normalized claim properties consumed by propagation.
const changesByProperty = {
  label: { value: 'Label', propagate: false },
  description: { value: 'Description', propagate: false },
  ai_guessable: { value: true, propagate: false },
  sort_order: { value: 3, propagate: true },
  required: { value: true, propagate: true },
  default_value: { value: null, propagate: true },
  enum_values_override: { value: ['closed'], propagate: true },
  enum_groups_override: { value: { version: 1, groups: [] }, propagate: false },
} satisfies Record<Exclude<keyof ClaimDiffShape, 'field'>, { value: unknown; propagate: boolean }>;

it.each(Object.entries(changesByProperty))('classifies %s without dropping it from the claim diff', (property, { value, propagate }) => {
  const result = diffClaims([{ field: 'status' }], [{ field: 'status', [property]: value }]);
  expect(result).toEqual({ added: [], removed: [], changed: ['status'], renderChanged: propagate ? ['status'] : [] });
});

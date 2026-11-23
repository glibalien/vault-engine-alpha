import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { seedSummaryFixture, seedNode, seedRel } from '../helpers/summary-fixture.js';
import { projectViews } from '../helpers/rollup-fixture.js';
import { registerCreateSchema } from '../../src/mcp/tools/create-schema.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerRenameGlobalField } from '../../src/mcp/tools/rename-global-field.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerReadRollups } from '../../src/mcp/tools/read-rollups.js';
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { relationshipViewsHash } from '../../src/rollups/definitions.js';
import { restoreSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
let db: Database.Database,
  server: McpServer,
  client: Client,
  vaultPath: string,
  cleanup: () => void;
beforeEach(async () => {
  db = createTestDb();
  seedSummaryFixture(db);
  ({ vaultPath, cleanup } = createTempVault());
  server = new McpServer({ name: 'rollup-schema-test', version: '1' });
  registerCreateSchema(server, db, { vaultPath });
  registerUpdateSchema(server, db, {
    vaultPath,
    writeLock: new WriteLockManager(),
  });
  registerDescribeSchema(server, db);
  registerReadRollups(server, db);
  registerRenameGlobalField(server, db, { vaultPath });
  registerUndoOperations(server, db, new WriteLockManager(), vaultPath);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
  cleanup();
});
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as Array<{ text: string }>)[0].text);
}
it.each(['legacy', 42, false, ['legacy']])('preserves non-object metadata %j when removing absent views', async metadata => {
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify(metadata));
  const args = {
    name: 'project', relationship_views: null,
    expected_relationship_views_hash: relationshipViewsHash(undefined),
  };
  const before = db.serialize();
  const preview = await call('update-schema', { ...args, dry_run: true });
  expect(preview).toMatchObject({ ok: true, data: { relationship_views: { added: [], removed: [], changed: [] } } });
  expect(db.serialize().equals(before)).toBe(true);
  expect(await call('update-schema', { ...args, expected_relationship_views_hash: 'stale' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(db.serialize().equals(before)).toBe(true);
  const applied = await call('update-schema', args);
  expect(applied.ok).toBe(true);
  expect(db.prepare("SELECT metadata FROM schemas WHERE name='project'").get()).toEqual({ metadata: JSON.stringify(metadata) });
  restoreSchemaSnapshot(db, vaultPath, applied.data.operation_id, 'project');
  expect(db.prepare("SELECT metadata FROM schemas WHERE name='project'").get()).toEqual({ metadata: JSON.stringify(metadata) });
});
it.each(['label', 'description'])('allows relation %s edits while retaining an unrelated invalid rollup', async property => {
  const original = projectViews();
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify({ relationship_views_v1: original }));
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  const changed = { ...original, relations: original.relations.map(r => ({ ...r, [property]: 'Display only' })) };
  const args = {
    name: 'project', relationship_views: changed,
    expected_relationship_views_hash: relationshipViewsHash(original),
  };
  const before = db.serialize();
  expect(await call('update-schema', { ...args, dry_run: true })).toMatchObject({
    ok: true, data: { relationship_views: { changed: ['relation:tasks'] } },
  });
  expect(db.serialize().equals(before)).toBe(true);
  const applied = await call('update-schema', args);
  expect(applied.ok).toBe(true);
  const discovery = (await call('describe-schema', { name: 'project', include: ['relationship_views'] })).data.relationship_views;
  expect(discovery.relationship_views_hash).toBe(relationshipViewsHash(changed));
  expect(discovery.relationship_views_hash).not.toBe(args.expected_relationship_views_hash);
  expect(discovery.rollups.find((r: { definition: { name: string } }) => r.definition.name === 'next_due_date').state).toBe('invalid');
  expect(parse(readFileSync(join(vaultPath, '.schemas/project.yaml'), 'utf8')).relationship_views).toEqual(changed);
  expect((await call('read-rollups', { schema: 'project', rollups: ['open_task_count'] })).ok).toBe(true);
  expect(await call('read-rollups', { schema: 'project', rollups: ['next_due_date'] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  restoreSchemaSnapshot(db, vaultPath, applied.data.operation_id, 'project');
  expect(parse(readFileSync(join(vaultPath, '.schemas/project.yaml'), 'utf8')).relationship_views).toEqual(original);
});
it.each([
  { direction: 'outgoing' },
  { field: 'owner' },
  { filter: { types: ['project'] } },
])('still revalidates dependent rollups for execution changes %j', async change => {
  const original = projectViews();
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify({ relationship_views_v1: original }));
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  const before = db.serialize();
  for (const dry_run of [true, false]) {
    expect(await call('update-schema', {
      name: 'project', dry_run,
      relationship_views: { ...original, relations: original.relations.map(r => ({ ...r, ...change })) },
      expected_relationship_views_hash: relationshipViewsHash(original),
    })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(db.serialize().equals(before)).toBe(true);
  }
});
const update = (extra: Record<string, unknown> = {}) =>
  call('update-schema', {
    name: 'project',
    relationship_views: projectViews(),
    expected_relationship_views_hash: relationshipViewsHash(undefined),
    ...extra,
  });
const malformedViews = [
  ['unsupported version', { ...projectViews(), version: 2 }],
  ['unknown property', { ...projectViews(), extra: true }],
  ['too many relations', { ...projectViews(), relations: Array.from({ length: 17 }, (_, i) => ({ ...projectViews().relations[0], name: `tasks${i}` })) }],
  ['too many rollups', { ...projectViews(), rollups: Array.from({ length: 33 }, (_, i) => ({ ...projectViews().rollups[0], name: `count${i}` })) }],
] as const;
for (const mode of ['create', 'preview', 'commit'] as const) {
  it.each(malformedViews)(`${mode} returns an envelope for %s without writes`, async (_label, relationship_views) => {
    const before = db.serialize();
    const name = mode === 'create' ? 'new_schema' : 'project';
    const result = await client.callTool({
      name: mode === 'create' ? 'create-schema' : 'update-schema',
      arguments: {
        name,
        relationship_views,
        ...(mode === 'create' ? { field_claims: [] } : {
          dry_run: mode === 'preview',
          expected_relationship_views_hash: relationshipViewsHash(undefined),
        }),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS' },
      warnings: [],
    });
    expect(db.serialize().equals(before)).toBe(true);
    expect(existsSync(join(vaultPath, `.schemas/${name}.yaml`))).toBe(false);
  });
}
it('rejects null saved definitions on create without creating a schema or undo record', async () => {
  const before = db.serialize();
  expect(await call('create-schema', {
    name: 'new_schema', field_claims: [], relationship_views: null,
  })).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' }, warnings: [] });
  expect(db.serialize().equals(before)).toBe(true);
  expect(existsSync(join(vaultPath, '.schemas/new_schema.yaml'))).toBe(false);
});
it('advertises strict saved-definition shapes while allowing removal only on update', async () => {
  const { tools } = await client.listTools();
  const create = tools.find(t => t.name === 'create-schema')!.inputSchema;
  const update = tools.find(t => t.name === 'update-schema')!.inputSchema;
  // Repeated subschemas are factored into root definitions; follow local refs.
  const resolve = (root: Record<string, unknown>, node: unknown): Record<string, unknown> => {
    let current = node as Record<string, unknown>;
    for (;;) {
      const allOf = current.allOf as unknown[] | undefined;
      if (allOf?.length === 1) { current = allOf[0] as Record<string, unknown>; continue; }
      const ref = current.$ref as string | undefined;
      if (ref?.startsWith('#/definitions/')) {
        current = (root.definitions as Record<string, unknown>)[ref.slice('#/definitions/'.length)] as Record<string, unknown>;
        continue;
      }
      return current;
    }
  };
  const shape = {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { const: 1 },
      relations: { type: 'array', maxItems: 16 },
      rollups: { type: 'array', maxItems: 32 },
    },
  };
  expect(resolve(create, create.properties!.relationship_views)).toMatchObject(shape);
  const removable = resolve(update, update.properties!.relationship_views);
  expect(removable.anyOf).toHaveLength(2);
  expect(resolve(update, (removable.anyOf as unknown[])[0])).toMatchObject(shape);
  expect((removable.anyOf as unknown[])[1]).toEqual({ type: 'null' });
  // Inlining the finite-depth filter expressions made each listing ~90 KB.
  expect(JSON.stringify(create).length).toBeLessThan(16_384);
  expect(JSON.stringify(update).length).toBeLessThan(16_384);
  expect(create.required).toEqual(expect.arrayContaining(['name', 'field_claims']));
  expect(create.required).not.toContain('relationship_views');
  expect(update.required).toContain('name');
  expect(update.required).not.toContain('relationship_views');
});
it('previews and commits definitions without changing parent nodes, and exports/undo restores them', async () => {
  const before = db
    .prepare('SELECT id,version,body FROM nodes ORDER BY id')
    .all();
  const preview = await update({ dry_run: true });
  expect(preview.ok).toBe(true);
  expect(preview.data.relationship_views.added).toContain(
    'rollup:open_task_count',
  );
  expect(db.prepare('SELECT COUNT(*) AS n FROM undo_operations').get()).toEqual(
    { n: 0 },
  );
  expect(existsSync(join(vaultPath, '.schemas/project.yaml'))).toBe(false);
  const applied = await update();
  expect(applied.ok).toBe(true);
  expect(
    db.prepare('SELECT id,version,body FROM nodes ORDER BY id').all(),
  ).toEqual(before);
  expect(
    parse(readFileSync(join(vaultPath, '.schemas/project.yaml'), 'utf8'))
      .relationship_views,
  ).toEqual(projectViews());
  const discovery = await call('describe-schema', {
    name: 'project',
    include: ['relationship_views'],
  });
  expect(discovery.data.relationship_views.rollups[0]).toMatchObject({
    state: 'valid',
    type: 'integer',
  });
  expect(discovery.data.fields).toEqual([]);
  restoreSchemaSnapshot(db, vaultPath, applied.data.operation_id, 'project');
  expect(
    parse(readFileSync(join(vaultPath, '.schemas/project.yaml'), 'utf8')),
  ).not.toHaveProperty('relationship_views');
});
it('returns conflicts without creating an undo operation after a stale preview', async () => {
  expect((await update()).ok).toBe(true);
  const count = db.prepare('SELECT COUNT(*) AS n FROM undo_operations').get();
  const stale = await update({ dry_run: true });
  expect(stale).toMatchObject({
    ok: false,
    error: {
      code: 'CONFLICT',
      details: { reason: 'STALE_RELATIONSHIP_VIEWS' },
    },
  });
  expect(db.prepare('SELECT COUNT(*) AS n FROM undo_operations').get()).toEqual(
    count,
  );
});
it('warns when schema export is blocked while retaining committed definitions', async () => {
  await update();
  const path = join(vaultPath, '.schemas/project.yaml');
  writeFileSync(path, 'human edit\n');
  const result = await update({
    relationship_views: null,
    expected_relationship_views_hash: relationshipViewsHash(projectViews()),
  });
  expect(result.ok).toBe(true);
  expect(result.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'SCHEMA_FILE_RENDER_BLOCKED' }),
    ]),
  );
  expect(readFileSync(path, 'utf8')).toBe('human edit\n');
});
it('accepts typed definitions on create and preserves them on metadata-only patch updates', async () => {
  expect(
    (
      await call('create-schema', {
        name: 'custom',
        field_claims: [],
        relationship_views: projectViews(),
      })
    ).ok,
  ).toBe(true);
  const result = await call('update-schema', {
    name: 'custom',
    metadata: { a: 1 },
    add_field_claims: [],
  });
  expect(result.ok).toBe(true);
  expect(
    (
      await call('describe-schema', {
        name: 'custom',
        include: ['relationship_views'],
      })
    ).data.relationship_views.rollups,
  ).toHaveLength(2);
});

it('consumes discovered names over MCP and preserves invalid-definition envelopes', async () => {
  await update();
  const discovery = await call('describe-schema', {
    name: 'project',
    include: ['relationship_views'],
  });
  const names = discovery.data.relationship_views.rollups.map(
    (r: { definition: { name: string } }) => r.definition.name,
  );
  expect(
    (await call('read-rollups', { schema: 'project', rollups: names })).data
      .rows[0].rollups.open_task_count,
  ).toBe(2);
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  expect(
    await call('read-rollups', { schema: 'project', rollups: names }),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'VALIDATION_FAILED',
      details: { reason: 'INVALID_ROLLUP_DEFINITION', name: 'next_due_date' },
    },
  });
});
it.each([
  ['due', 'deadline'],
  ['project', 'portfolio'],
  ['status', 'state'],
])(
  'renames and undoes saved %s tokens through governed MCP operations',
  async (oldName, newName) => {
    await update();
    const before = await call('describe-schema', {
      name: 'project',
      include: ['relationship_views'],
    });
    const renamed = await call('rename-global-field', {
      old_name: oldName,
      new_name: newName,
    });
    expect(renamed.ok).toBe(true);
    const changed = await call('describe-schema', {
      name: 'project',
      include: ['relationship_views'],
    });
    expect(changed.data.relationship_views.state).toBe('valid');
    expect(changed.data.relationship_views_hash).not.toBe(
      before.data.relationship_views_hash,
    );
    const restored = await call('undo-operations', {
      operation_ids: [renamed.data.operation_id],
      dry_run: false,
    });
    expect(restored.ok).toBe(true);
    expect(
      (
        await call('describe-schema', {
          name: 'project',
          include: ['relationship_views'],
        })
      ).data.relationship_views,
    ).toEqual(before.data.relationship_views);
    expect(
      parse(readFileSync(join(vaultPath, '.schemas/project.yaml'), 'utf8'))
        .relationship_views,
    ).toEqual(projectViews());
  },
);

it('reports a blocked rollup schema projection after a committed field rename', async () => {
  await update();
  const path = join(vaultPath, '.schemas/project.yaml');
  writeFileSync(path, 'human edit\n');
  const result = await call('rename-global-field', {
    old_name: 'due',
    new_name: 'deadline',
  });
  expect(result).toMatchObject({
    ok: true,
    warnings: expect.arrayContaining([
      expect.objectContaining({
        code: 'SCHEMA_FILE_RENDER_BLOCKED',
        details: { schema: 'project' },
      }),
    ]),
  });
  expect(readFileSync(path, 'utf8')).toBe('human edit\n');
  expect(
    (
      await call('describe-schema', {
        name: 'project',
        include: ['relationship_views'],
      })
    ).data.relationship_views.rollups[1].definition.metric.field,
  ).toBe('deadline');
});

it.each(['replace', 'patch'])(
  'preserves null metadata when removing absent views through %s updates',
  async (mode) => {
    const args = {
      relationship_views: null,
      ...(mode === 'patch' ? { add_field_claims: [] } : {}),
    };
    const before = db.serialize();
    expect((await update({ ...args, dry_run: true })).ok).toBe(true);
    expect(db.serialize()).toEqual(before);
    const result = await update(args);
    expect(result.ok).toBe(true);
    expect(result.data.metadata).toBeNull();
    expect(
      (await call('describe-schema', { name: 'project' })).data.metadata,
    ).toBeNull();
  },
);

it('honors explicit null metadata with view removal and restores definitions on undo', async () => {
  expect((await update()).ok).toBe(true);
  const removed = await update({
    metadata: null,
    relationship_views: null,
    expected_relationship_views_hash: relationshipViewsHash(projectViews()),
  });
  expect(removed.ok).toBe(true);
  expect(removed.data.metadata).toBeNull();
  expect(
    (await call('describe-schema', { name: 'project' })).data.metadata,
  ).toBeNull();
  expect(
    (
      await call('undo-operations', {
        operation_ids: [removed.data.operation_id],
        dry_run: false,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await call('describe-schema', {
        name: 'project',
        include: ['relationship_views'],
      })
    ).data.relationship_views.state,
  ).toBe('valid');
});

it.each(['replace', 'patch'])(
  'reports attempted saved-definition additions when %s preview dependencies are invalid',
  async (mode) => {
    const views = projectViews();
    views.rollups[1].metric.field = 'due_typo';
    const before = db.serialize();
    const result = await update({
      dry_run: true,
      relationship_views: views,
      ...(mode === 'patch' ? { add_field_claims: [] } : {}),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: 'Unknown summary field: due_typo',
        details: {
          relationship_views: {
            added: [
              'relation:tasks',
              'rollup:open_task_count',
              'rollup:next_due_date',
            ],
            changed: [],
            removed: [],
            references: {
              'rollup:open_task_count': ['relation:tasks'],
              'rollup:next_due_date': ['relation:tasks'],
            },
          },
        },
      },
    });
    expect(db.serialize()).toEqual(before);
    expect(existsSync(join(vaultPath, '.schemas/project.yaml'))).toBe(false);
  },
);

it('reports attempted changed and removed definitions on dependency rejection', async () => {
  await update();
  const original = projectViews();
  const views = {
    ...original,
    rollups: [
      {
        ...original.rollups[1],
        metric: { ...original.rollups[1].metric, field: 'due_typo' },
      },
    ],
  };
  const before = db.serialize(),
    path = join(vaultPath, '.schemas/project.yaml'),
    bytes = readFileSync(path);
  const result = await update({
    dry_run: true,
    relationship_views: views,
    expected_relationship_views_hash: relationshipViewsHash(original),
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_PARAMS',
      details: {
        relationship_views: {
          added: [],
          changed: ['rollup:next_due_date'],
          removed: ['rollup:open_task_count'],
          references: { 'rollup:next_due_date': ['relation:tasks'] },
        },
      },
    },
  });
  expect(db.serialize()).toEqual(before);
  expect(readFileSync(path)).toEqual(bytes);
});

it('includes saved-definition intent alongside rejected claim diagnostics', async () => {
  const before = db.serialize();
  const result = await update({
    dry_run: true,
    field_claims: [{ field: 'nonexistent' }],
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'VALIDATION_FAILED',
      details: {
        claims_added: ['nonexistent'],
        groups: [expect.objectContaining({ reason: 'UNKNOWN_FIELD' })],
        relationship_views: {
          added: [
            'relation:tasks',
            'rollup:open_task_count',
            'rollup:next_due_date',
          ],
        },
      },
    },
  });
  expect(db.serialize()).toEqual(before);
  expect(existsSync(join(vaultPath, '.schemas/project.yaml'))).toBe(false);
});

it('keeps stale-hash conflicts unchanged when the proposed dependency is also invalid', async () => {
  await update();
  const views = projectViews();
  views.rollups[1].metric.field = 'due_typo';
  const before = db.serialize();
  const result = await update({ dry_run: true, relationship_views: views });
  expect(result.error).toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'STALE_RELATIONSHIP_VIEWS' },
  });
  expect(db.serialize()).toEqual(before);
});

it.each(['update', 'remove', 'rename'])(
  'reports blocked schema exports when undoing a saved-definition %s',
  async (kind) => {
    await update();
    const original = projectViews();
    const changed = projectViews();
    changed.rollups[0].name = 'remaining_count';
    const applied =
      kind === 'rename'
        ? await call('rename-global-field', {
            old_name: 'due',
            new_name: 'deadline',
          })
        : await update({
            relationship_views: kind === 'remove' ? null : changed,
            expected_relationship_views_hash: relationshipViewsHash(original),
          });
    expect(applied.ok).toBe(true);
    const path = join(vaultPath, '.schemas/project.yaml'),
      human = readFileSync(path, 'utf8') + '\n# human note\n';
    writeFileSync(path, human);
    const before = db.serialize();
    const preview = await call('undo-operations', {
      operation_ids: [applied.data.operation_id],
      dry_run: true,
    });
    expect(preview.ok).toBe(true);
    expect(preview.warnings).toEqual([]);
    expect(db.serialize()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toBe(human);
    const result = await call('undo-operations', {
      operation_ids: [applied.data.operation_id],
      dry_run: false,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'SCHEMA_FILE_RENDER_BLOCKED',
        details: { schema: 'project' },
      }),
    ]);
    expect(readFileSync(path, 'utf8')).toBe(human);
    const discovery = await call('describe-schema', {
      name: 'project',
      include: ['relationship_views'],
    });
    expect(discovery.data.relationship_views_hash).toBe(
      relationshipViewsHash(original),
    );
    expect(discovery.data.relationship_views.state).toBe('valid');
    expect(
      db
        .prepare('SELECT status FROM undo_operations WHERE operation_id=?')
        .get(applied.data.operation_id),
    ).toEqual({ status: 'undone' });
  },
);

it('deduplicates blocked exports across multiple undo operations and never emits them for dry-runs', async () => {
  const first = await update();
  const changed = projectViews();
  changed.rollups[0].name = 'remaining_count';
  const second = await update({
    relationship_views: changed,
    expected_relationship_views_hash: relationshipViewsHash(projectViews()),
  });
  const path = join(vaultPath, '.schemas/project.yaml'),
    human = readFileSync(path, 'utf8') + '\n# human note\n';
  writeFileSync(path, human);
  // Ensure the intended reverse chronology independent of the clock resolution.
  db.prepare(
    'UPDATE undo_operations SET timestamp=timestamp+100 WHERE operation_id=?',
  ).run(second.data.operation_id);
  const args = {
    operation_ids: [first.data.operation_id, second.data.operation_id],
  };
  const before = db.serialize();
  const preview = await call('undo-operations', { ...args, dry_run: true });
  expect(preview.ok).toBe(true);
  expect(preview.warnings).toEqual([]);
  expect(db.serialize()).toEqual(before);
  const result = await call('undo-operations', { ...args, dry_run: false });
  expect(result.ok).toBe(true);
  expect(result.warnings).toEqual([
    expect.objectContaining({
      code: 'SCHEMA_FILE_RENDER_BLOCKED',
      details: { schema: 'project' },
    }),
  ]);
  expect(readFileSync(path, 'utf8')).toBe(human);
  expect(
    (
      await call('describe-schema', {
        name: 'project',
        include: ['relationship_views'],
      })
    ).data.relationship_views.state,
  ).toBe('absent');
});

it('previews and commits a valid targeted edit while retaining an unchanged missing-relation rollup', async () => {
  const original = projectViews();
  const legacy = {
    ...original,
    rollups: [
      ...original.rollups,
      { name: 'legacy_count', relation: 'missing', metric: { op: 'count' } },
    ],
  };
  db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
    JSON.stringify({ relationship_views_v1: legacy }),
  );
  const next = {
    ...legacy,
    rollups: legacy.rollups.map((r) =>
      r.name === 'open_task_count'
        ? { ...r, description: 'Updated valid description' }
        : r,
    ),
  };
  const args = {
    relationship_views: next,
    expected_relationship_views_hash: relationshipViewsHash(legacy),
  };
  const before = db.serialize();
  const preview = await update({ ...args, dry_run: true });
  expect(preview.ok).toBe(true);
  expect(preview.data.relationship_views.changed).toEqual([
    'rollup:open_task_count',
  ]);
  expect(db.serialize()).toEqual(before);
  expect((await update(args)).ok).toBe(true);
  const discovery = await call('describe-schema', {
    name: 'project',
    include: ['relationship_views'],
  });
  expect(
    discovery.data.relationship_views.rollups.find(
      (r: { definition: { name: string } }) =>
        r.definition.name === 'legacy_count',
    ).state,
  ).toBe('invalid');
  expect(
    (
      await call('read-rollups', {
        schema: 'project',
        rollups: ['open_task_count'],
      })
    ).ok,
  ).toBe(true);
});


it('changes the percentage denominator through previewed hash-guarded settings and undo', async () => {
  seedNode(db,'PC',['project']);
  for(const [i,status] of ['done','done','open','pending','backlog','dropped'].entries()) {
    seedNode(db,`PC${i}`,['task'],{status});seedRel(db,`PC${i}`,'PC','PC');
  }
  const views={...projectViews(),rollups:[{name:'completion',relation:'tasks',filter:{fields:{status:{one_of:['done','open','in-progress','next','pending']}}},metric:{op:'percentage',matching_filter:{fields:{status:{eq:'done'}}}}}]};
  const args={name:'project',relationship_views:views,expected_relationship_views_hash:relationshipViewsHash(undefined)};
  const before=db.serialize();expect((await call('update-schema',{...args,dry_run:true})).ok).toBe(true);expect(db.serialize()).toEqual(before);
  expect((await call('update-schema',args)).ok).toBe(true);
  const read=()=>call('read-rollups',{schema:'project',rollups:['completion'],filter:{node_ids:['PC']}});
  expect((await read()).data.rows[0]).toMatchObject({rollups:{completion:50},rollup_details:{completion:{numerator_count:2,denominator_count:4}}});
  const updated=structuredClone(views);updated.rollups[0].filter.fields.status.one_of.push('backlog');
  expect(await call('update-schema',{...args,relationship_views:updated})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  const applied=await call('update-schema',{...args,relationship_views:updated,expected_relationship_views_hash:relationshipViewsHash(views)});
  expect(applied.ok).toBe(true);expect((await read()).data.rows[0].rollups.completion).toBe(40);
  restoreSchemaSnapshot(db,vaultPath,applied.data.operation_id,'project');
  expect((await read()).data.rows[0].rollups.completion).toBe(50);
});
it('configures percentage vocabulary for a different entity and field without code changes',async()=>{
  for(const name of ['portfolio','ticket']) db.prepare('INSERT INTO schemas(name) VALUES (?)').run(name);
  db.prepare("INSERT INTO global_fields(name,field_type) VALUES ('portfolio','reference'),('state','enum')").run();
  seedNode(db,'PF',['portfolio']);
  for(const [i,state] of ['resolved','working','queued'].entries()){seedNode(db,`K${i}`,['ticket'],{state});seedRel(db,`K${i}`,'PF','PF','portfolio');}
  const views={version:1,relations:[{name:'tickets',field:'portfolio',direction:'incoming',filter:{types:['ticket']}}],rollups:[{name:'completion',relation:'tickets',filter:{fields:{state:{one_of:['resolved','working']}}},metric:{op:'percentage',matching_filter:{fields:{state:{eq:'resolved'}}}}}]};
  const args={name:'portfolio',relationship_views:views,expected_relationship_views_hash:relationshipViewsHash(undefined)};
  expect((await call('update-schema',{...args,dry_run:true})).ok).toBe(true);
  expect((await call('update-schema',args)).ok).toBe(true);
  const read=()=>call('read-rollups',{schema:'portfolio',rollups:['completion']});
  expect((await read()).data.rows[0].rollups.completion).toBe(50);
  const updated=structuredClone(views);updated.rollups[0].filter.fields.state.one_of.push('queued');
  expect((await call('update-schema',{...args,relationship_views:updated,expected_relationship_views_hash:relationshipViewsHash(views)})).ok).toBe(true);
  expect((await read()).data.rows[0].rollup_details.completion).toEqual({numerator_count:1,denominator_count:3});
});

import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import {
  seedSummaryFixture,
  seedNode,
  seedRel,
} from '../helpers/summary-fixture.js';
import { upgradeForResolvedTargetId } from '../../src/db/migrate.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

it('previews and installs the profile, then reads exact metrics, task membership and bounded dependencies through MCP', async () => {
  const db = createTestDb(),
    { vaultPath, cleanup } = createTempVault();
  const server = new McpServer({ name: 'health-acceptance', version: '1' }),
    client = new Client({ name: 'health-consumer', version: '1' });
  try {
    upgradeForResolvedTargetId(db);
    seedSummaryFixture(db);
    db.prepare(
      "INSERT INTO global_fields (name,field_type,list_item_type) VALUES ('blockedBy','list','reference')",
    ).run();
    for (const id of ['A', 'B', 'Zero', 'Undated', 'Large'])
      seedNode(db, id, ['project'], { status: 'open' });
    const statuses = [
      'open',
      'in-progress',
      'next',
      'pending',
      'backlog',
      'done',
      'dropped',
    ];
    const dates = [
      '2026-09-10',
      '2026-09-25',
      null,
      '2026-09-20',
      '2026-09-01',
      '2026-08-01',
      '2026-08-02',
    ];
    statuses.forEach((status, i) => {
      seedNode(db, `H${i}`, ['task'], { status, due: dates[i] });
      seedRel(db, `H${i}`, 'A', 'A');
    });
    seedRel(db, 'H0', 'A.md', 'A');
    seedRel(db, 'H0', 'B', 'B');
    seedRel(db, 'H4', 'Zero', 'Zero');
    seedRel(db, 'H2', 'Undated', 'Undated');
    seedRel(db, 'H5', 'B', 'B', 'wiki-link');
    for (let i = 0; i < 27; i++) {
      seedNode(db, `Project${i}`, ['project'], { status: 'open' });
      seedNode(db, `LargeTask${i}`, ['task'], { status: 'next' });
      seedRel(db, `LargeTask${i}`, 'Large', 'Large');
    }
    for (const [a, b] of [
      ['H0', 'H1'],
      ['H0', 'H2'],
      ['H1', 'H3'],
      ['H2', 'H3'],
      ['H3', 'H5'],
      ['H5', 'H6'],
      ['H6', 'H4'],
      ['H3', 'H0'],
    ])
      seedRel(db, a, b, b, 'blockedBy');
    seedRel(db, 'H0', 'missing', null, 'blockedBy');
    registerAllTools(server, db, {
      vaultPath,
      writeLock: new WriteLockManager(),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    const relation = {
      name: 'project_health_tasks',
      direction: 'incoming',
      field: 'project',
      filter: { types: ['task'] },
    };
    const active = {
      fields: {
        status: { one_of: ['open', 'in-progress', 'next', 'pending'] },
      },
    };
    const views = {
      version: 1,
      relations: [relation],
      rollups: [
        {
          name: 'project_health_active_task_count',
          relation: relation.name,
          filter: active,
          metric: { op: 'count' },
        },
        {
          name: 'project_health_next_due',
          relation: relation.name,
          filter: active,
          metric: { op: 'min', field: 'due', date_mode: 'calendar_date' },
        },
      ],
    };
    const existing = {
      version: 1,
      relations: [{ ...relation, name: 'existing_tasks' }],
      rollups: [{ name: 'existing_count', relation: 'existing_tasks', metric: { op: 'count' } }],
    };
    db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
      JSON.stringify({ other: 'preserved', relationship_views_v1: existing }),
    );
    const discovered = await call('describe-schema', {
      name: 'project',
      include: ['relationship_views'],
    });
    const args = {
      name: 'project',
      relationship_views: { version: 1, relations: [...existing.relations, ...views.relations], rollups: [...existing.rollups, ...views.rollups] },
      expected_relationship_views_hash:
        discovered.data.relationship_views.relationship_views_hash,
    };
    const before = db.serialize();
    const yaml = join(vaultPath, '.schemas/project.yaml');
    const oldFile = existsSync(yaml) ? readFileSync(yaml) : null;
    expect((await call('update-schema', { ...args, dry_run: true })).ok).toBe(
      true,
    );
    expect(db.serialize().equals(before)).toBe(true);
    expect(existsSync(yaml) ? readFileSync(yaml) : null).toEqual(oldFile);
    expect((await call('update-schema', args)).ok).toBe(true);
    expect((await call('update-schema', args)).error.code).toBe('CONFLICT');
    expect(
      JSON.parse(
        (
          db
            .prepare("SELECT metadata FROM schemas WHERE name='project'")
            .get() as { metadata: string }
        ).metadata,
      ).other,
    ).toBe('preserved');
    const configured = await call('describe-schema', { name: 'project', include: ['relationship_views'] });
    expect(configured.data.relationship_views.rollups.find((r: { definition: { name: string } }) => r.definition.name === 'existing_count').state).toBe('valid');
    const readStart = db.serialize();
    const rollups = await call('read-rollups', {
      schema: 'project',
      rollups: views.rollups.map((r) => r.name),
      filter: { node_ids: ['A', 'B', 'Zero', 'Undated'] },
    });
    expect(rollups.ok).toBe(true);
    const metrics = (id: string) =>
      rollups.data.rows.find((r: { node: { id: string } }) => r.node.id === id)
        .rollups;
    expect(metrics('A')).toEqual({
      project_health_active_task_count: 4,
      project_health_next_due: '2026-09-10',
    });
    expect(metrics('B').project_health_active_task_count).toBe(1);
    expect(metrics('Zero')).toEqual({
      project_health_active_task_count: 0,
      project_health_next_due: null,
    });
    expect(metrics('Undated')).toEqual({
      project_health_active_task_count: 1,
      project_health_next_due: null,
    });
    expect(rollups.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CROSS_NODE_FILTER_UNRESOLVED',
          details: expect.objectContaining({ scope: 'vault_rel_type' }),
        }),
      ]),
    );
    const query = (project: string, offset = 0) =>
      call('query-nodes', {
        types: ['task'],
        ...active,
        join_filters: [
          {
            direction: 'outgoing',
            rel_type: 'project',
            target: { node_ids: [project] },
          },
        ],
        include_fields: ['status', 'due'],
        sort_by: 'title',
        sort_order: 'asc',
        limit: 25,
        offset,
      });
    expect(
      (await query('A')).data.nodes.map((n: { id: string }) => n.id).sort(),
    ).toEqual(['H0', 'H1', 'H2', 'H3']);
    const first = await query('Large'),
      second = await query('Large', 25);
    expect(first.data.total).toBe(27);
    expect(first.data.nodes.length).toBe(25);
    expect(second.data.nodes.length).toBe(2);
    const sorted = await call('read-rollups', {
      schema: 'project',
      rollups: [views.rollups[0].name],
      sort: { by: 'rollup', name: views.rollups[0].name, order: 'desc' },
      limit: 25,
    });
    expect(sorted.data.rows[0].node.id).toBe('Large');
    expect(sorted.data.page.has_more).toBe(true);
    const graph = await call('traverse-nodes', {
      root_id: 'H0',
      field: 'blockedBy',
      direction: 'outgoing',
      max_depth: 4,
      include_fields: ['status', 'due'],
    });
    expect(graph.ok).toBe(true);
    expect(
      graph.data.nodes.find((n: { id: string }) => n.id === 'H3').depth,
    ).toBe(2);
    expect(graph.data.cycles.components.length).toBeGreaterThan(0);
    expect(graph.data.boundary.depth_limited).toBe(true);
    expect(graph.data.unresolved).toMatchObject({
      scope: 'expanded_sources',
      raw_count: 1,
      source_ids: ['H0'],
    });
    expect(
      graph.data.nodes.find((n: { id: string }) => n.id === 'H5').fields.status,
    ).toBe('done');
    expect(
      graph.data.nodes.find((n: { id: string }) => n.id === 'H6').fields.status,
    ).toBe('dropped');
    expect(db.serialize().equals(readStart)).toBe(true);
  } finally {
    await client.close();
    await server.close();
    db.close();
    cleanup();
  }
});

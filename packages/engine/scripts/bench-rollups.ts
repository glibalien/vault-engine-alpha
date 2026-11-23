/** Synthetic on-disk databases only. Run from repository root with node --import tsx. */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchema } from '../src/db/schema.js';
import { upgradeForResolvedTargetId } from '../src/db/migrate.js';
import { readRollups } from '../src/rollups/service.js';
import { compileRollups } from '../src/rollups/compile.js';
import { summarizeNodes } from '../src/summaries/service.js';
import type { RelationshipViews } from '../src/rollups/types.js';
for (const parents of [100, 1000, 10000]) {
  const dir = mkdtempSync(join(tmpdir(), 'rollup-bench-')),
    db = new Database(join(dir, 'synthetic.db'));
  try {
    createSchema(db);
    upgradeForResolvedTargetId(db);
    db.transaction(() => {
      db.prepare("INSERT INTO schemas(name) VALUES ('project'),('task')").run();
      db.prepare(
        "INSERT INTO global_fields(name,field_type,list_item_type) VALUES ('project','list','reference'),('estimate','number',NULL)",
      ).run();
      const node = db.prepare(
          'INSERT INTO nodes(id,title,file_path) VALUES (?,?,?)',
        ),
        type = db.prepare(
          'INSERT INTO node_types(node_id,schema_type) VALUES (?,?)',
        ),
        edge = db.prepare(
          "INSERT INTO relationships(source_id,target,resolved_target_id,rel_type) VALUES (?,?,?,'project')",
        ),
        value = db.prepare(
          "INSERT INTO node_fields(node_id,field_name,value_number,source) VALUES (?,'estimate',?,'frontmatter')",
        );
      for (let i = 0; i < parents; i++) {
        const id = `P${String(i).padStart(5, '0')}`;
        node.run(id, id, `${id}.md`);
        type.run(id, 'project');
        for (let j = 0; j < 2; j++) {
          const child = `${id}-T${j}`;
          node.run(child, child, `${child}.md`);
          type.run(child, 'task');
          edge.run(child, id, id);
          value.run(child, j);
        }
      }
    })();
    for (const independent of [false, true]) {
      const name = (prefix: string, i: number) =>
        `${prefix}${i}`.padEnd(64, 'x');
      const views: RelationshipViews = {
        version: 1,
        relations: Array.from({ length: 4 }, (_, i) => ({
          name: name('r', i),
          direction: 'incoming',
          field: 'project',
          filter: { types: ['task'] },
          label: 'L'.repeat(1024),
          description: 'D'.repeat(1024),
        })),
        rollups: Array.from({ length: 8 }, (_, i) => ({
          name: name('m', i),
          relation: name('r', Math.floor(i / 2)),
          filter: {
            fields: { estimate: { gte: independent ? Math.floor(i / 2) : 0 } },
          },
          metric: i % 2 ? { op: 'max', field: 'estimate' } : { op: 'count' },
          label: 'L'.repeat(1024),
          description: 'D'.repeat(1024),
        })),
      };
      db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(
        JSON.stringify({ relationship_views_v1: views }),
      );
      const request = {
          schema: 'project',
          rollups: views.rollups.map((r) => r.name),
          limit: 100,
        },
        compiled = compileRollups(db, request);
      const source = JSON.parse(
          summarizeNodes(db, compiled.summaryRequest).content[0].text,
        ).data,
        result = JSON.parse(readRollups(db, request).content[0].text).data;
      assert.equal(result.page.total, parents);
      assert.equal(
        compiled.summaryRequest.relations.length,
        independent ? 4 : 1,
      );
      for (let i = 0; i < result.rows.length; i++)
        for (const [name, a] of compiled.aliases.rollups)
          assert.equal(
            result.rows[i].rollups[name],
            source.rows[i].relations[a.relation].metrics[a.metric],
          );
      const times: number[] = [];
      let rss = 0;
      for (let i = 0; i < 5; i++) {
        rss = Math.max(rss, process.memoryUsage().rss);
        const start = performance.now();
        readRollups(db, request);
        times.push(performance.now() - start);
        rss = Math.max(rss, process.memoryUsage().rss);
      }
      times.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          parents,
          independent,
          descriptors: compiled.summaryRequest.relations.length,
          namespaceBytes: Buffer.byteLength(JSON.stringify(views)),
          minMs: times[0],
          medianMs: times[2],
          maxMs: times[4],
          peakSampledRssMiB: rss / 1048576,
          node: process.version,
          plans: db
            .prepare(
              'EXPLAIN QUERY PLAN SELECT source_id FROM relationships WHERE rel_type=? AND resolved_target_id IN (?,?) LIMIT ?',
            )
            .all('project', 'P00000', 'P00001', 100001),
        }),
      );
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

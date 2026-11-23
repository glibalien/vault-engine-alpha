import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createSchema } from '../src/db/schema.js';
import {
  seedSummaryFixture,
  seedNode,
  seedRel,
} from '../tests/helpers/summary-fixture.js';
import { traverseNodes } from '../src/traversal/service.js';
const cases: Array<{
  name: string;
  pairs: Array<[string, string]>;
  nodes: number;
  edges: number;
  raw: number;
  depth: number;
}> = [];
cases.push({
  name: 'chain',
  pairs: Array.from({ length: 8 }, (_, i) => [`N${i}`, `N${i + 1}`]),
  nodes: 9,
  edges: 8,
  raw: 8,
  depth: 8,
});
cases.push({
  name: 'cycle',
  pairs: Array.from({ length: 8 }, (_, i) => [`N${i}`, `N${(i + 1) % 8}`]),
  nodes: 8,
  edges: 8,
  raw: 8,
  depth: 8,
});
cases.push({
  name: 'high-degree',
  pairs: Array.from({ length: 499 }, (_, i) => ['N0', `N${i + 1}`]),
  nodes: 500,
  edges: 499,
  raw: 499,
  depth: 4,
});
cases.push({
  name: 'diamond',
  pairs: [
    ['N0', 'N1'],
    ['N0', 'N2'],
    ['N1', 'N3'],
    ['N2', 'N3'],
  ],
  nodes: 4,
  edges: 4,
  raw: 4,
  depth: 4,
});
cases.push({
  name: 'duplicates',
  pairs: Array.from({ length: 10000 }, () => ['N0', 'N1']),
  nodes: 2,
  edges: 1,
  raw: 10000,
  depth: 4,
});
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-traversal-')),
    db = new Database(join(dir, 'test.db'));
  try {
    createSchema(db);
    seedSummaryFixture(db);
    db.prepare(
      "INSERT INTO global_fields (name,field_type) VALUES ('blockedBy','reference')",
    ).run();
    db.transaction(() => {
      for (const id of new Set(c.pairs.flat())) seedNode(db, id, ['task']);
      c.pairs.forEach(([s, t], i) =>
        seedRel(db, s, `${t}-spelling-${i}`, t, 'blockedBy'),
      );
    })();
    const run = () => {
      const result = JSON.parse(
        traverseNodes(db, {
          root_id: 'N0',
          field: 'blockedBy',
          direction: 'outgoing',
          max_depth: c.depth,
        }).content[0].text,
      );
      assert.equal(result.data.nodes.length, c.nodes);
      assert.equal(result.data.edges.length, c.edges);
      assert.equal(result.data.stats.raw_rows_examined, c.raw);
    };
    run();
    const times: number[] = [];
    let rss = 0;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      run();
      times.push(performance.now() - start);
      rss = Math.max(rss, process.memoryUsage().rss);
    }
    times.sort((a, b) => a - b);
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT source_id,resolved_target_id AS target_id FROM relationships WHERE rel_type=? AND source_id IN (?) ORDER BY source_id,resolved_target_id,target LIMIT ?',
      )
      .all('blockedBy', 'N0', 10001);
    console.log(
      JSON.stringify({
        case: c.name,
        node: process.version,
        platform: process.platform,
        min_ms: times[0],
        median_ms: times[2],
        max_ms: times[4],
        sampled_rss_mib: rss / 1048576,
        plan,
      }),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

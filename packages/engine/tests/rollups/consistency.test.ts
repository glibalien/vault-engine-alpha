import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { seedSummaryFixture } from '../helpers/summary-fixture.js';
import { projectViews, seedRollups } from '../helpers/rollup-fixture.js';
import { readRollups } from '../../src/rollups/service.js';
it('reads definitions and source data from one WAL snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollup-wal-')),
    writer = new Database(join(dir, 'test.db'));
  writer.pragma('journal_mode=WAL');
  createSchema(writer);
  seedSummaryFixture(writer);
  seedRollups(writer);
  let changed = false;
  const reader = new Database(join(dir, 'test.db'), {
    verbose(sql) {
      if (!changed && String(sql).includes('AS parent_id')) {
        changed = true;
        const views = projectViews();
        views.rollups[0].filter.fields.status.one_of = ['done'];
        writer.transaction(() => {
          writer
            .prepare("UPDATE schemas SET metadata=? WHERE name='project'")
            .run(JSON.stringify({ relationship_views_v1: views }));
          writer
            .prepare(
              "UPDATE node_fields SET value_text='done' WHERE node_id IN ('T1','T2') AND field_name='status'",
            )
            .run();
        })();
      }
    },
  });
  try {
    const read = () =>
      JSON.parse(
        readRollups(reader, { schema: 'project', rollups: ['open_task_count'] })
          .content[0].text,
      ).data;
    const a = read();
    expect(a.rows[0].rollups.open_task_count).toBe(2);
    expect(changed).toBe(true);
    const b = read();
    expect(b.rows[0].rollups.open_task_count).toBe(3);
    expect(a.relationship_views_hash).not.toBe(b.relationship_views_hash);
    expect(
      b.definitions.rollups[0].definition.filter.fields.status.one_of,
    ).toEqual(['done']);
  } finally {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

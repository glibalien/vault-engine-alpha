import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchema } from '../../src/db/schema.js';
import { seedSummaryFixture } from '../helpers/summary-fixture.js';
import { seedTraversal } from '../helpers/traversal-fixture.js';
import { traverseNodes } from '../../src/traversal/service.js';
it('keeps edges and projected values in one WAL snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traversal-wal-'));
  const writer = new Database(join(dir, 'test.db'));
  writer.pragma('journal_mode=WAL');
  createSchema(writer);
  seedSummaryFixture(writer);
  seedTraversal(writer, [['A', 'B']]);
  let changed = false;
  const reader = new Database(join(dir, 'test.db'), {
    verbose(sql) {
      if (!changed && String(sql).includes('AS target_id')) {
        changed = true;
        writer
          .prepare(
            "UPDATE node_fields SET value_text='open' WHERE node_id='B' AND field_name='status'",
          )
          .run();
      }
    },
  });
  try {
    const read = () =>
      JSON.parse(
        traverseNodes(reader, {
          root_id: 'A',
          field: 'blockedBy',
          direction: 'outgoing',
          include_fields: ['status'],
        }).content[0].text,
      );
    expect(read().data.nodes[1].fields.status).toBe('done');
    expect(changed).toBe(true);
    expect(read().data.nodes[1].fields.status).toBe('open');
  } finally {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

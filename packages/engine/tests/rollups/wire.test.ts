import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { makeRollupDb } from '../helpers/rollup-fixture.js';
import { readRollups } from '../../src/rollups/service.js';
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../tests/fixtures/read-rollups/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
it('matches the frozen wire fixture used by both clients', () => {
  const db = makeRollupDb();
  try {
    expect(
      JSON.parse(readRollups(db, fixture('request')).content[0].text),
    ).toEqual(fixture('success'));
  } finally {
    db.close();
  }
});

it('freezes hand-calculated values, missing fields and explicit nulls', () => {
  const rows = fixture('success').data.rows;
  expect(rows.map((r: { rollups: unknown }) => r.rollups)).toEqual([
    { open_task_count: 2, next_due_date: '2026-09-18' },
    { open_task_count: 3, next_due_date: '2026-09-18' },
    { open_task_count: 0, next_due_date: null },
  ]);
  expect(rows[1].relations.tasks.items[1].fields).not.toHaveProperty('due');
  expect(rows[0].relations.tasks.items[0].fields).not.toHaveProperty('label');
});

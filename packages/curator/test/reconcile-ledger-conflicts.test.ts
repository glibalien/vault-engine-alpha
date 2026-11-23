import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { keptBothPairs, upsertVerdict } from '../src/db/reconcile.js';

it('lists the pairs the reconciler kept both of, among the given memories only (#474 idea 4)', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const stamp = { updatedAtA: 'a', updatedAtB: 'b', adjudicatedAt: 't' };
  upsertVerdict(db, { idA: 9, idB: 4, verdict: 'kept_both', ...stamp });
  upsertVerdict(db, { idA: 4, idB: 5, verdict: 'distinct', ...stamp });
  upsertVerdict(db, { idA: 5, idB: 77, verdict: 'kept_both', ...stamp });
  expect(keptBothPairs(db, [4, 5, 9])).toEqual([[4, 9]]);
  expect(keptBothPairs(db, [4])).toEqual([]);
  db.close();
});

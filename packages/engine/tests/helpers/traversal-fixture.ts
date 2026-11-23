import type Database from 'better-sqlite3';
import { makeSummaryDb, seedNode, seedRel } from './summary-fixture.js';
export function seedTraversal(
  db: Database.Database,
  pairs: Array<[string, string]>,
  extra: string[] = [],
): void {
  db.prepare(
    "INSERT OR IGNORE INTO global_fields (name,field_type,list_item_type) VALUES ('blockedBy','list','reference')",
  ).run();
  for (const id of new Set([...pairs.flat(), ...extra]))
    seedNode(db, id, ['task'], { status: 'done', due: null });
  for (const [s, t] of pairs) seedRel(db, s, t, t, 'blockedBy');
}
export function makeTraversalDb(
  pairs: Array<[string, string]>,
  extra: string[] = [],
): Database.Database {
  const db = makeSummaryDb();
  seedTraversal(db, pairs, extra);
  return db;
}

import type Database from 'better-sqlite3';
import { makeSummaryDb } from './summary-fixture.js';
export const projectViews = () => ({
  version: 1,
  relations: [
    {
      name: 'tasks',
      direction: 'incoming',
      field: 'project',
      filter: { types: ['task'] },
    },
  ],
  rollups: [
    {
      name: 'open_task_count',
      relation: 'tasks',
      filter: { fields: { status: { one_of: ['open', 'in-progress'] } } },
      metric: { op: 'count' },
    },
    {
      name: 'next_due_date',
      relation: 'tasks',
      filter: { fields: { status: { one_of: ['open', 'in-progress'] } } },
      metric: { op: 'min', field: 'due', date_mode: 'calendar_date' },
    },
  ],
});
export function seedRollups(db: Database.Database): void {
  db.prepare('UPDATE schemas SET metadata=? WHERE name=?').run(
    JSON.stringify({
      other: 'preserved',
      relationship_views_v1: projectViews(),
    }),
    'project',
  );
}
export function makeRollupDb(): Database.Database {
  const db = makeSummaryDb();
  seedRollups(db);
  return db;
}

import type Database from 'better-sqlite3';
import { registerWikiRoot } from '../src/db/wiki-roots.js';

/** Project wikis exist only when requested: register the projects a test curates, by title. */
export function enrolProjects(db: Database.Database, ...titles: string[]): void {
  for (const title of titles) {
    registerWikiRoot(db, { root_title: title, root_node_id: null, kind: 'project', source: 'vault', cadence: null,
      brief: null, created_at: '2026-10-25T00:00:00.000Z', created_by: 'test' });
  }
}

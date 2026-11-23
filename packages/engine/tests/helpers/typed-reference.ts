import type Database from 'better-sqlite3';
import { createTestDb } from './db.js';

export function typedReferenceDb(): Database.Database {
  const db = createTestDb();
  const node = db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)');
  const type = db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)');
  for (const [id, path, kind] of [
    ['P1', 'Projects/Example.md', 'Project'],
    ['W', 'Wiki/Example.md', 'Wiki'],
    ['C', 'People/Example.md', 'Person'],
  ]) {
    node.run(id, path, 'Example');
    type.run(id, kind);
  }
  return db;
}

export function addSecondProject(db: Database.Database): void {
  db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run('P2', 'Archive/Example.md', 'Example');
  db.prepare('INSERT INTO node_types (node_id, schema_type) VALUES (?, ?)').run('P2', 'Project');
}

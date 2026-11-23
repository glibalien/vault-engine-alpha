import type Database from 'better-sqlite3';

/** A registered wiki root the curator maintains beyond the active-project list. */
export interface WikiRootRow {
  root_title: string;
  root_node_id: string | null;
  kind: string;     // 'topic' | 'project'
  source: string;   // 'vault' (forward-compat with 3b's 'vault+web')
  brief: string | null;
  cadence: string | null;
  created_at: string;
  created_by: string | null;
}

export type WikiRootInsert = Pick<
  WikiRootRow, 'root_title' | 'root_node_id' | 'kind' | 'source' | 'cadence' | 'brief' | 'created_at' | 'created_by'
>;

/** DDL for the wiki-roots registry. Called by migration #4. */
export function createWikiRootsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_roots (
      root_title    TEXT PRIMARY KEY,
      root_node_id  TEXT,
      kind          TEXT NOT NULL DEFAULT 'topic',
      source        TEXT NOT NULL DEFAULT 'vault',
      brief         TEXT,
      cadence       TEXT,
      created_at    TEXT NOT NULL,
      created_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_roots_kind ON wiki_roots(kind);
  `);
}

/** Register (or update) a wiki root. Idempotent on root_title — re-register
 *  refreshes root_node_id + source + cadence + brief without duplicating. */
export function registerWikiRoot(db: Database.Database, row: WikiRootInsert): void {
  db.prepare(`
    INSERT INTO wiki_roots (root_title, root_node_id, kind, source, cadence, brief, created_at, created_by)
    VALUES (@root_title, @root_node_id, @kind, @source, @cadence, @brief, @created_at, @created_by)
    ON CONFLICT(root_title) DO UPDATE SET
      root_node_id = @root_node_id, source = @source, cadence = @cadence, brief = @brief
  `).run(row);
}

/** Deregister a wiki root so the sweep stops curating it. Returns true iff a row
 *  went away — an unknown title is a caller mistake, not a silent success. Vault
 *  pages are untouched; only the registry entry disappears. */
export function deleteWikiRoot(db: Database.Database, title: string): boolean {
  return db.prepare(`DELETE FROM wiki_roots WHERE root_title = ?`).run(title).changes > 0;
}

export function getWikiRoot(db: Database.Database, title: string): WikiRootRow | undefined {
  return db.prepare(`SELECT * FROM wiki_roots WHERE root_title = ?`).get(title) as WikiRootRow | undefined;
}

/** The wiki registered for a note, by its title or its node id; undefined when none is. */
export function wikiRootFor(db: Database.Database, title: string, nodeId: string): WikiRootRow | undefined {
  return db.prepare(`SELECT * FROM wiki_roots WHERE root_title = ? OR root_node_id = ? LIMIT 1`).get(title, nodeId) as WikiRootRow | undefined;
}

export function wikiRootExists(db: Database.Database, title: string): boolean {
  return db.prepare(`SELECT 1 FROM wiki_roots WHERE root_title = ?`).get(title) !== undefined;
}

/** Project wikis someone asked the curator to keep; sweeps maintain only these. */
export function projectWikiRoots(db: Database.Database): WikiRootRow[] {
  return db.prepare(`SELECT * FROM wiki_roots WHERE kind = 'project' ORDER BY root_title`).all() as WikiRootRow[];
}

/** Registered topic wiki roots, for the sweep + status. */
export function topicWikiRoots(db: Database.Database): WikiRootRow[] {
  return db.prepare(`SELECT * FROM wiki_roots WHERE kind = 'topic' ORDER BY root_title`).all() as WikiRootRow[];
}

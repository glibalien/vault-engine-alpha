import type Database from 'better-sqlite3';

/**
 * The dossiers the Curator has written (#714), one row per subject note, so it can tell when one
 * is behind and rebuild the ones asked for. A row is written by each build that publishes a page;
 * a dossier built before this table has none until its next build. `remove-dossier` (#723) deletes
 * the row with the page.
 */

export type DossierStatus = 'current' | 'behind';

export interface DossierRecord {
  readonly nodeId: string;
  readonly pageTitle: string;
  readonly homeId: string | null;
  /** The output the behind check compares with now: its recorded inputs. */
  readonly outputRevisionId: string;
  readonly builtAt: string;
  /** Live memories about the subject when it was built; null when the Engine gave no total. */
  readonly memoryTotal: number | null;
  readonly status: DossierStatus;
  readonly checkedAt: string | null;
}

/** DDL for migration 40. */
export function createDossierTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE dossiers (
      node_id            TEXT PRIMARY KEY,
      page_title         TEXT NOT NULL,
      home_id            TEXT,
      output_revision_id TEXT NOT NULL,
      built_at           TEXT NOT NULL,
      memory_total       INTEGER,
      status             TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'behind')),
      checked_at         TEXT
    );
  `);
}

interface Row {
  node_id: string; page_title: string; home_id: string | null; output_revision_id: string; built_at: string;
  memory_total: number | null; status: DossierStatus; checked_at: string | null;
}

const toRecord = (row: Row): DossierRecord => ({ nodeId: row.node_id, pageTitle: row.page_title, homeId: row.home_id,
  outputRevisionId: row.output_revision_id, builtAt: row.built_at, memoryTotal: row.memory_total, status: row.status, checkedAt: row.checked_at });

/** A build published the page: it is current as built. */
export function recordDossierBuild(db: Database.Database, build: Omit<DossierRecord, 'status' | 'checkedAt'>): void {
  db.prepare(`INSERT INTO dossiers (node_id, page_title, home_id, output_revision_id, built_at, memory_total, status, checked_at)
    VALUES (@nodeId, @pageTitle, @homeId, @outputRevisionId, @builtAt, @memoryTotal, 'current', @builtAt)
    ON CONFLICT(node_id) DO UPDATE SET page_title = excluded.page_title, home_id = excluded.home_id,
      output_revision_id = excluded.output_revision_id, built_at = excluded.built_at, memory_total = excluded.memory_total,
      status = 'current', checked_at = excluded.checked_at`).run(build);
}

export function listDossiers(db: Database.Database): DossierRecord[] {
  return (db.prepare('SELECT * FROM dossiers ORDER BY built_at, node_id').all() as Row[]).map(toRecord);
}

export function getDossier(db: Database.Database, nodeId: string): DossierRecord | null {
  const row = db.prepare('SELECT * FROM dossiers WHERE node_id = ?').get(nodeId) as Row | undefined;
  return row ? toRecord(row) : null;
}

/** A check's verdict, for the output it checked: a build since then has already written its own. */
export function setDossierStatus(db: Database.Database, nodeId: string, outputRevisionId: string, status: DossierStatus, checkedAt: string): boolean {
  return db.prepare('UPDATE dossiers SET status = ?, checked_at = ? WHERE node_id = ? AND output_revision_id = ?')
    .run(status, checkedAt, nodeId, outputRevisionId).changes === 1;
}

export function getDossierByHome(db: Database.Database, homeId: string): DossierRecord | null {
  const row = db.prepare('SELECT * FROM dossiers WHERE home_id = ?').get(homeId) as Row | undefined;
  return row ? toRecord(row) : null;
}

export function forgetDossier(db: Database.Database, nodeId: string): boolean {
  return db.prepare('DELETE FROM dossiers WHERE node_id = ?').run(nodeId).changes === 1;
}

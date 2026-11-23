import type Database from 'better-sqlite3';
import type { WikiCatalogPage } from '../types.js';

export type PageRequestStatus = 'pending' | 'fulfilled' | 'failed';

/** One caller-requested wiki sub-page. `page_title` is the project-qualified
 *  stored title — provisional at insert, corrected at fulfillment (a request
 *  can resolve to an existing page under a different stored title). */
export interface PageRequestRow {
  id: number;
  project_node_id: string | null;
  project_title: string;
  title: string;
  page_title: string;
  brief: string | null;
  status: PageRequestStatus;
  requested_by: string | null;
  created_at: string;
  fulfilled_at: string | null;
  page_node_id: string | null;
  error: string | null;
}

export type PageRequestInsert = Pick<
  PageRequestRow,
  'project_node_id' | 'project_title' | 'title' | 'page_title' | 'brief' | 'requested_by' | 'created_at'
>;

/** DDL for the caller-requested-pages table. Called by migration #2. */
export function createPageRequestsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_requests (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_node_id TEXT,
      project_title   TEXT NOT NULL,
      title           TEXT NOT NULL,
      page_title      TEXT NOT NULL,
      brief           TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      requested_by    TEXT,
      created_at      TEXT NOT NULL,
      fulfilled_at    TEXT,
      page_node_id    TEXT,
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_page_requests_project_status
      ON page_requests(project_title, status);
  `);
}

export function insertPageRequest(db: Database.Database, row: PageRequestInsert): number {
  const res = db.prepare(`
    INSERT INTO page_requests
      (project_node_id, project_title, title, page_title, brief, requested_by, created_at, status)
    VALUES
      (@project_node_id, @project_title, @title, @page_title, @brief, @requested_by, @created_at, 'pending')
  `).run(row);
  return Number(res.lastInsertRowid);
}

/** Public request readers must not expose the private execution checkpoint. */
const PAGE_REQUEST_COLUMNS = `id, project_node_id, project_title, title, page_title, brief,
  status, requested_by, created_at, fulfilled_at, page_node_id, error`;

export function getPageRequest(db: Database.Database, id: number): PageRequestRow | undefined {
  return db.prepare(`SELECT ${PAGE_REQUEST_COLUMNS} FROM page_requests WHERE id = ?`).get(id) as PageRequestRow | undefined;
}

export function pendingRequests(db: Database.Database, projectTitle: string): PageRequestRow[] {
  return db.prepare(
    `SELECT ${PAGE_REQUEST_COLUMNS} FROM page_requests WHERE project_title = ? AND status = 'pending' ORDER BY id`,
  ).all(projectTitle) as PageRequestRow[];
}

export function markRequestFulfilled(
  db: Database.Database, id: number, pageTitle: string, pageNodeId: string | null, ts: string,
): void {
  db.prepare(`
    UPDATE page_requests
    SET status = 'fulfilled', page_title = ?, page_node_id = ?, fulfilled_at = ?, error = NULL
    WHERE id = ?
  `).run(pageTitle, pageNodeId, ts, id);
}

export function markRequestFailed(db: Database.Database, id: number, error: string, ts: string): void {
  db.prepare(
    `UPDATE page_requests SET status = 'failed', fulfilled_at = ?, error = ? WHERE id = ?`,
  ).run(ts, error, id);
}

/**
 * Stored titles of fulfilled requested pages for a project — the pin set. A
 * caller asked for these pages, so the curator must never auto-retire them;
 * they retire only on explicit ask or project completion.
 */
export function pinnedPageTitles(db: Database.Database, projectTitle: string): Set<string> {
  const rows = db.prepare(
    `SELECT page_title FROM page_requests WHERE project_title = ? AND status = 'fulfilled'`,
  ).all(projectTitle) as Array<{ page_title: string }>;
  return new Set(rows.map(r => r.page_title));
}

/** Stable node identities of fulfilled requested pages. Legacy rows without an
 * identity remain available through pinnedPageTitles for response compatibility. */
export function pinnedPageNodeIds(db: Database.Database, projectTitle: string): Set<string> {
  const rows = db.prepare(
    `SELECT page_node_id FROM page_requests
     WHERE project_title = ? AND status = 'fulfilled' AND page_node_id IS NOT NULL`,
  ).all(projectTitle) as Array<{ page_node_id: string }>;
  return new Set(rows.map(row => row.page_node_id));
}

/** Move fulfilled request audit rows from historical merge sources to the
 * canonical target. The engine batch has already committed when this runs. */
export function retargetFulfilledRequests(
  db: Database.Database,
  projectTitle: string,
  sourceNodeIds: readonly string[],
  targetNodeId: string,
  targetTitle: string,
): number {
  const sources = [...new Set(sourceNodeIds)].filter(nodeId => nodeId !== targetNodeId);
  if (sources.length === 0) return 0;
  const placeholders = sources.map(() => '?').join(', ');
  return db.prepare(`
    UPDATE page_requests
    SET page_node_id = ?, page_title = ?
    WHERE project_title = ? AND status = 'fulfilled'
      AND page_node_id IN (${placeholders})
  `).run(targetNodeId, targetTitle, projectTitle, ...sources).changes;
}

/** Repair stale fulfilled rows from the authoritative catalog replacement graph.
 * Also upgrades legacy title-only rows when their stored title is unambiguous. */
export function repairFulfilledRequestTargets(
  db: Database.Database,
  projectTitle: string,
  catalog: readonly WikiCatalogPage[],
): number {
  const byId = new Map(catalog.map(page => [page.id, page]));
  const byTitle = new Map<string, WikiCatalogPage[]>();
  for (const page of catalog) {
    const pages = byTitle.get(page.title);
    if (pages === undefined) byTitle.set(page.title, [page]);
    else pages.push(page);
  }
  const rows = db.prepare(`
    SELECT id, page_node_id, page_title FROM page_requests
    WHERE project_title = ? AND status = 'fulfilled'
  `).all(projectTitle) as Array<{ id: number; page_node_id: string | null; page_title: string }>;
  const update = db.prepare(`UPDATE page_requests SET page_node_id = ?, page_title = ? WHERE id = ?`);
  let repaired = 0;
  const transaction = db.transaction(() => {
    for (const row of rows) {
      const titleMatches = byTitle.get(row.page_title) ?? [];
      const start = (row.page_node_id === null ? undefined : byId.get(row.page_node_id))
        ?? (titleMatches.length === 1 ? titleMatches[0] : undefined);
      if (start === undefined) continue;
      const target = replacementTarget(start, byId);
      if (row.page_node_id === target.id && row.page_title === target.title) continue;
      update.run(target.id, target.title, row.id);
      repaired += 1;
    }
  });
  transaction();
  return repaired;
}

function replacementTarget(
  start: WikiCatalogPage,
  byId: ReadonlyMap<string, WikiCatalogPage>,
): WikiCatalogPage {
  const seen = new Set([start.id]);
  let current = start;
  while (current.wiki_replaced_by?.id !== undefined && !seen.has(current.wiki_replaced_by.id)) {
    const next = byId.get(current.wiki_replaced_by.id);
    if (next === undefined) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/** Drop every page request for a wiki title (pins included) — for deregistration,
 *  where a surviving pin would resurrect pages for a wiki that no longer exists. */
export function deletePageRequests(db: Database.Database, projectTitle: string): number {
  return db.prepare(`DELETE FROM page_requests WHERE project_title = ?`).run(projectTitle).changes;
}

export interface RequestCounts { pending: number; fulfilled: number; failed: number; }

export function requestCounts(db: Database.Database): RequestCounts {
  const rows = db.prepare(
    `SELECT status, COUNT(*) AS c FROM page_requests GROUP BY status`,
  ).all() as Array<{ status: string; c: number }>;
  const out: RequestCounts = { pending: 0, fulfilled: 0, failed: 0 };
  for (const r of rows) {
    if (r.status === 'pending') out.pending = r.c;
    else if (r.status === 'fulfilled') out.fulfilled = r.c;
    else if (r.status === 'failed') out.failed = r.c;
  }
  return out;
}

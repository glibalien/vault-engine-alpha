import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, MIGRATIONS } from '../src/db/migrate.js';
import {
  insertPageRequest, getPageRequest, pendingRequests, markRequestFulfilled, markRequestFailed,
  pinnedPageNodeIds, pinnedPageTitles, repairFulfilledRequestTargets,
  requestCounts, retargetFulfilledRequests, type PageRequestInsert,
  deletePageRequests,
} from '../src/db/requests.js';
import type { WikiCatalogPage } from '../src/types.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

const row = (over: Partial<PageRequestInsert> = {}): PageRequestInsert => ({
  project_node_id: 'p1',
  project_title: 'AskAcme',
  title: 'ID Verification Pilot',
  page_title: 'AskAcme — ID Verification Pilot',
  brief: 'The ID check pilot workstream.',
  requested_by: 'client-abc',
  created_at: '2026-06-11T00:00:00Z',
  ...over,
});

describe('page_requests migration', () => {
  it('migration #2 creates the table (runMigrations applies all, user_version is current max)', () => {
    const db = freshDb();
    expect(db.pragma('user_version', { simple: true })).toBe(41);
    expect(MIGRATIONS.map(m => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41]);
    db.close();
  });
});

describe('page request lifecycle', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('insert → pending → fulfilled, and the fulfilled title becomes pinned', () => {
    const id = insertPageRequest(db, row());
    expect(pendingRequests(db, 'AskAcme').map(r => r.id)).toEqual([id]);
    expect(pendingRequests(db, 'Other')).toEqual([]);

    markRequestFulfilled(db, id, 'AskAcme — ID Verification Pilot', 'node9', '2026-06-11T01:00:00Z');
    expect(pendingRequests(db, 'AskAcme')).toEqual([]);
    expect(pinnedPageTitles(db, 'AskAcme')).toEqual(new Set(['AskAcme — ID Verification Pilot']));
    expect(pinnedPageTitles(db, 'Other')).toEqual(new Set());
  });

  it('failed requests are not pinned and not pending', () => {
    const id = insertPageRequest(db, row());
    markRequestFailed(db, id, 'engine down', '2026-06-11T01:00:00Z');
    expect(pendingRequests(db, 'AskAcme')).toEqual([]);
    expect(pinnedPageTitles(db, 'AskAcme')).toEqual(new Set());
  });

  it('deregistration removes checkpoint storage with the request row', () => {
    const id = insertPageRequest(db, row());
    db.prepare('UPDATE page_requests SET execution_json=? WHERE id=?').run('{"generation":"old"}', id);
    expect(deletePageRequests(db, 'AskAcme')).toBe(1);
    expect(db.prepare('SELECT execution_json FROM page_requests WHERE id=?').get(id)).toBeUndefined();
  });

  it('keeps execution material out of ordinary request readers', () => {
    const id = insertPageRequest(db, row());
    db.prepare('UPDATE page_requests SET execution_json=? WHERE id=?').run('{"secret":"recovery material"}', id);
    const columns = ['id', 'project_node_id', 'project_title', 'title', 'page_title', 'brief',
      'status', 'requested_by', 'created_at', 'fulfilled_at', 'page_node_id', 'error'];
    expect(Object.keys(getPageRequest(db, id) ?? {})).toEqual(columns);
    expect(Object.keys(pendingRequests(db, 'AskAcme')[0] ?? {})).toEqual(columns);
  });

  it('counts by status', () => {
    const a = insertPageRequest(db, row({ title: 'A', page_title: 'AskAcme — A' }));
    insertPageRequest(db, row({ title: 'B', page_title: 'AskAcme — B' }));
    const c = insertPageRequest(db, row({ title: 'C', page_title: 'AskAcme — C' }));
    markRequestFulfilled(db, a, 'AskAcme — A', 'n1', 't');
    markRequestFailed(db, c, 'boom', 't');
    expect(requestCounts(db)).toEqual({ pending: 1, fulfilled: 1, failed: 1 });
  });

  it('pendingRequests returns rows in FIFO (insertion) order', () => {
    const a = insertPageRequest(db, row({ title: 'A', page_title: 'AskAcme — A' }));
    const b = insertPageRequest(db, row({ title: 'B', page_title: 'AskAcme — B' }));
    const c = insertPageRequest(db, row({ title: 'C', page_title: 'AskAcme — C' }));
    expect(pendingRequests(db, 'AskAcme').map(r => r.id)).toEqual([a, b, c]);
  });

  it('fulfillment corrects a provisional page_title and pins the corrected title', () => {
    const id = insertPageRequest(db, row({ page_title: 'AskAcme — Provisional' }));
    markRequestFulfilled(db, id, 'AskAcme — Actual', 'n1', 't');
    expect(pinnedPageTitles(db, 'AskAcme')).toEqual(new Set(['AskAcme — Actual']));
  });

  it('retargets every fulfilled merge source to the canonical node identity', () => {
    // Given
    const first = insertPageRequest(db, row({ title: 'A', page_title: 'AskAcme — A' }));
    const second = insertPageRequest(db, row({ title: 'B', page_title: 'AskAcme — B' }));
    markRequestFulfilled(db, first, 'AskAcme — A', 'source-a', 't');
    markRequestFulfilled(db, second, 'AskAcme — B', 'source-b', 't');

    // When
    retargetFulfilledRequests(db, 'AskAcme', ['source-a', 'source-b'], 'target', 'AskAcme — Canonical');

    // Then
    expect(pinnedPageNodeIds(db, 'AskAcme')).toEqual(new Set(['target']));
    expect(pinnedPageTitles(db, 'AskAcme')).toEqual(new Set(['AskAcme — Canonical']));
  });

  it('repairs stale fulfilled rows by following replacement chains idempotently', () => {
    // Given
    const id = insertPageRequest(db, row({ page_title: 'AskAcme — Legacy' }));
    markRequestFulfilled(db, id, 'AskAcme — Legacy', 'source', 't');
    const page = (id: string, title: string, replacement?: { id: string; title: string }): WikiCatalogPage => ({
      id, title, file_path: `Wikis/${title}.md`, version: 1, content_hash: id,
      wiki_state: replacement === undefined ? 'active' : 'retired', wiki_origin: 'automatic',
      wiki_pinned: false, ...(replacement === undefined ? {} : { wiki_replaced_by: replacement }),
    });
    const catalog = [
      page('source', 'AskAcme — Legacy', { id: 'middle', title: 'AskAcme — Middle' }),
      page('middle', 'AskAcme — Middle', { id: 'target', title: 'AskAcme — Canonical' }),
      page('target', 'AskAcme — Canonical'),
    ];

    // When
    const firstRepair = repairFulfilledRequestTargets(db, 'AskAcme', catalog);
    const secondRepair = repairFulfilledRequestTargets(db, 'AskAcme', catalog);

    // Then
    expect(firstRepair).toBe(1);
    expect(secondRepair).toBe(0);
    expect(pinnedPageNodeIds(db, 'AskAcme')).toEqual(new Set(['target']));
  });
});

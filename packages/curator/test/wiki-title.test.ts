import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { moveWikiTitle } from '../src/db/wiki-title.js';
import { getWikiRoot, registerWikiRoot } from '../src/db/wiki-roots.js';
import { activeCorrections, addCorrection, isPaused, setPaused } from '../src/db/control.js';
import { insertPageRequest, pendingRequests } from '../src/db/requests.js';
import { readDeferredCreates, recordDeferredCreates } from '../src/db/deferred-creates.js';
import { writeEvidenceManifest } from '../src/db/evidence-manifests.js';
import { writeStagePlanning } from '../src/db/stage-checkpoints.js';
import type { PlanningResult } from '../src/reconciliation-planning.js';

function db() { const d = new Database(':memory:'); runMigrations(d); return d; }
function register(d: Database.Database, title: string, node: string) {
  registerWikiRoot(d, { root_title: title, root_node_id: node, kind: 'project', source: 'vault', cadence: null, brief: null,
    created_at: '2026-10-01T00:00:00Z', created_by: null });
}

describe('moveWikiTitle', () => {
  it('moves the registration and every piece of title-keyed state, and drops stage checkpoints', () => {
    const d = db();
    register(d, 'Old', 'p-1');
    setPaused(d, 'Old', true, 'tester', '2026-10-02T00:00:00Z');
    addCorrection(d, { project_title: 'Old', note: 'Note.', created_by: null, created_at: '2026-10-02T00:00:00Z' });
    insertPageRequest(d, { project_node_id: 'p-1', project_title: 'Old', title: 'Old', page_title: 'Old — Risks', brief: null,
      requested_by: null, created_at: '2026-10-02T00:00:00Z' });
    recordDeferredCreates(d, 'Old', { evidenceHash: 'h', count: 1 });
    writeEvidenceManifest(d, 'Old', { evidenceHash: 'h', curatedAt: '2026-10-02T00:00:00Z',
      components: { status: 's', tasks: 't', notes: 'n', meetings: 'm', contacts: 'c' } });
    writeStagePlanning(d, 'Old', 'fp', {} as PlanningResult);

    expect(moveWikiTitle(d, 'Old', 'New')).toBe('moved');
    expect(getWikiRoot(d, 'Old')).toBeUndefined();
    expect(getWikiRoot(d, 'New')).toMatchObject({ root_node_id: 'p-1', created_at: '2026-10-01T00:00:00Z' });
    expect(isPaused(d, 'New')).toBe(true);
    expect(activeCorrections(d, 'New')).toHaveLength(1);
    expect(pendingRequests(d, 'New')).toHaveLength(1);
    expect(readDeferredCreates(d, 'New')).toEqual({ evidenceHash: 'h', count: 1 });
    expect(d.prepare("SELECT evidence_hash FROM wiki_evidence_manifests WHERE project = 'New'").get()).toEqual({ evidence_hash: 'h' });
    for (const table of ['wiki_control', 'wiki_corrections', 'page_requests', 'wiki_deferred_creates', 'wiki_evidence_manifests']) {
      const column = table === 'wiki_evidence_manifests' ? 'project' : table === 'wiki_deferred_creates' ? 'root_title' : 'project_title';
      expect(d.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = 'Old'`).get()).toEqual({ c: 0 });
    }
    expect(d.prepare('SELECT COUNT(*) AS c FROM wiki_stage_checkpoints').get()).toEqual({ c: 0 });
  });

  it('keeps state already set under the new title', () => {
    const d = db();
    register(d, 'Old', 'p-1');
    setPaused(d, 'Old', true, 'tester', '2026-10-02T00:00:00Z');
    setPaused(d, 'New', false, 'tester', '2026-10-03T00:00:00Z');
    expect(moveWikiTitle(d, 'Old', 'New')).toBe('moved');
    expect(isPaused(d, 'New')).toBe(false);
    expect(d.prepare("SELECT COUNT(*) AS c FROM wiki_control WHERE project_title = 'Old'").get()).toEqual({ c: 0 });
  });

  it('refuses a title another wiki holds and reports an unregistered source', () => {
    const d = db();
    register(d, 'Old', 'p-1');
    register(d, 'New', 'p-2');
    setPaused(d, 'Old', true, 'tester', '2026-10-02T00:00:00Z');
    expect(moveWikiTitle(d, 'Old', 'New')).toBe('title-in-use');
    expect(getWikiRoot(d, 'Old')?.root_node_id).toBe('p-1');
    expect(isPaused(d, 'Old')).toBe(true);
    expect(moveWikiTitle(d, 'Missing', 'Elsewhere')).toBe('missing');
  });
});

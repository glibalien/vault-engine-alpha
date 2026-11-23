import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type Database from 'better-sqlite3';

/**
 * Dossier builds in flight (#722), so a restart can tell a build that never called the model from
 * one whose call may have been paid. A row is written when a live build is accepted (`queued`),
 * moves to `calling` just before its first model call and to `publishing` just before the page is
 * written, and is deleted when the build ends, written or not. A row left at startup was cut off by
 * the restart: a `queued` one is started again (a scheduled one with its eligibility asked again), a
 * `calling` one is reported and never re-run (its call may have been paid, and the owner decides),
 * and for a `publishing` one the Engine is asked whether the page went out (Codex, #732).
 *
 * The server and a CLI sweep share this database, and a build in flight has a row too, so a row is
 * left only when its process is gone: on this host, not this process (`PROCESS_REF`), and its pid
 * no longer alive or now this process's own (a pid reused after a restart).
 */

/** This process, for the rows it writes. */
export const PROCESS_REF = randomUUID();

export type DossierBuildState = 'queued' | 'calling' | 'publishing';

export interface DossierBuildRow {
  readonly runRef: string;
  readonly nodeId: string;
  readonly pageTitle: string;
  readonly state: DossierBuildState;
  /** A nightly rebuild (#714): on a restart it is started only if still asked for and behind. */
  readonly scheduled: boolean;
  readonly queuedAt: string;
  readonly updatedAt: string;
  readonly hostName: string;
  readonly pid: number;
  readonly processRef: string;
}

/** DDL for migration 41. */
export function createDossierBuildTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE dossier_builds (
      run_ref    TEXT PRIMARY KEY,
      node_id    TEXT NOT NULL,
      page_title TEXT NOT NULL,
      state      TEXT NOT NULL CHECK (state IN ('queued', 'calling', 'publishing')),
      scheduled  INTEGER NOT NULL DEFAULT 0,
      queued_at  TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      host        TEXT NOT NULL,
      pid         INTEGER NOT NULL,
      process_ref TEXT NOT NULL
    );
  `);
}

export function queueDossierBuild(db: Database.Database, row: { runRef: string; nodeId: string; pageTitle: string; scheduled?: boolean },
  now = new Date().toISOString()): void {
  db.prepare(`INSERT INTO dossier_builds (run_ref, node_id, page_title, state, scheduled, queued_at, updated_at, host, pid, process_ref)
    VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(row.runRef, row.nodeId, row.pageTitle, row.scheduled ? 1 : 0, now, now,
    hostname(), process.pid, PROCESS_REF);
}

/** Just before the page is written: from here a restart asks the Engine whether it went out. */
export function markDossierPublishing(db: Database.Database, runRef: string, now = new Date().toISOString()): void {
  db.prepare(`UPDATE dossier_builds SET state = 'publishing', updated_at = ? WHERE run_ref = ?`).run(now, runRef);
}

/** Just before the build's first model call: from here a restart can't know whether it was paid. */
export function markDossierCalling(db: Database.Database, runRef: string, now = new Date().toISOString()): void {
  db.prepare(`UPDATE dossier_builds SET state = 'calling', updated_at = ? WHERE run_ref = ?`).run(now, runRef);
}

export function finishDossierBuild(db: Database.Database, runRef: string): void {
  db.prepare('DELETE FROM dossier_builds WHERE run_ref = ?').run(runRef);
}

/** The builds a gone process left, oldest first. `alive` tells whether a pid on this host still runs. */
export function leftDossierBuilds(db: Database.Database, alive: (pid: number) => boolean,
  self: { host: string; pid: number; ref: string } = { host: hostname(), pid: process.pid, ref: PROCESS_REF }): DossierBuildRow[] {
  const rows = (db.prepare('SELECT * FROM dossier_builds ORDER BY queued_at, run_ref').all() as Array<{
    run_ref: string; node_id: string; page_title: string; state: DossierBuildState; scheduled: number; queued_at: string; updated_at: string;
    host: string; pid: number; process_ref: string;
  }>).map(row => ({ runRef: row.run_ref, nodeId: row.node_id, pageTitle: row.page_title, state: row.state, scheduled: row.scheduled === 1, queuedAt: row.queued_at,
    updatedAt: row.updated_at, hostName: row.host, pid: row.pid, processRef: row.process_ref }));
  return rows.filter(row => row.hostName === self.host && row.processRef !== self.ref && (row.pid === self.pid || !alive(row.pid)));
}

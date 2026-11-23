import type Database from 'better-sqlite3';

/**
 * On-demand runs (#644): one row per run of a job over a chosen set of notes, and the Engine undo
 * operation of every note a run wrote, so the run can be undone as one request.
 *
 * Every job shares this table, because the rules that matter are about all of them together: one
 * run at a time, and one ceiling on what they spend in a day.
 */

/** The jobs that run on demand. A job's request and counts are its own, stored as JSON. */
export type OnDemandJob = 'fill-fields' | 'type-notes' | 'guess-memory-subjects' | 'extract-memories';

/** What a job works through, one and many: notes, or memories (#554). */
export const ON_DEMAND_ITEM: Record<OnDemandJob, { one: string; many: string }> = {
  'fill-fields': { one: 'note', many: 'notes' },
  'type-notes': { one: 'note', many: 'notes' },
  'guess-memory-subjects': { one: 'memory', many: 'memories' },
  'extract-memories': { one: 'note', many: 'notes' },
};

/** What a job has done to an item it need not ask about again, for messages about starting again. */
export const ON_DEMAND_DONE_WORD: Record<OnDemandJob, string> = {
  'fill-fields': 'filled', 'type-notes': 'typed', 'guess-memory-subjects': 'given subjects', 'extract-memories': 'read',
};

/** "notes already typed", for messages about starting again. */
export function alreadyDone(job: string): string {
  const known = ON_DEMAND_DONE_WORD[job as OnDemandJob];
  return known === undefined ? 'notes already done' : `${ON_DEMAND_ITEM[job as OnDemandJob].many} already ${known}`;
}

export type OnDemandRunStatus =
  /** Accepted, waiting for the queue. */
  | 'queued'
  | 'running'
  /** Every note in scope was looked at. */
  | 'completed'
  /** Its limit, or a provider's own limit, refused a call. Start it again to continue. */
  | 'stopped'
  /** The Curator shut down or restarted under it. Start it again to continue. */
  | 'interrupted'
  | 'failed';

export interface OnDemandRunRow<Request = Record<string, unknown>, Counts = Record<string, unknown>> {
  id: string;
  job: OnDemandJob;
  status: OnDemandRunStatus;
  request: Request;
  limit_usd: number;
  model: string;
  provider: string | null;
  trigger: string;
  /** Notes in scope when the run was accepted. */
  notes: number;
  /** What the run did, as the job counts it. A job fills in the counts a row saved before they existed. */
  counts: Counts;
  spent_usd: number;
  /** Why it stopped, failed or was interrupted. */
  detail: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** When its writes were undone, if they were. */
  undone_at: string | null;
}

/** DDL for migration 35, under the names the tables had then. Migration 36 renames them. */
export function createFieldFillRunTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE field_fill_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      limit_usd REAL NOT NULL,
      model TEXT NOT NULL,
      provider TEXT,
      trigger TEXT NOT NULL,
      notes INTEGER NOT NULL,
      counts_json TEXT NOT NULL,
      spent_usd REAL NOT NULL DEFAULT 0,
      detail TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      undone_at TEXT,
      owner_host TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      heartbeat_at TEXT NOT NULL
    );
    CREATE INDEX idx_field_fill_runs_created ON field_fill_runs (created_at);
    CREATE TABLE field_fill_run_operations (
      run_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      written_at TEXT NOT NULL,
      PRIMARY KEY (run_id, operation_id)
    );
  `);
}

/**
 * DDL for migration 36: the run tables take every on-demand job, so they lose "field fill" from
 * their names and each run says which job it is. The runs already there are field-filling runs.
 */
export function generalizeRunTables(db: Database.Database): void {
  db.exec(`
    ALTER TABLE field_fill_runs RENAME TO on_demand_runs;
    ALTER TABLE field_fill_run_operations RENAME TO on_demand_run_operations;
    ALTER TABLE on_demand_runs ADD COLUMN job TEXT NOT NULL DEFAULT 'fill-fields';
    DROP INDEX idx_field_fill_runs_created;
    CREATE INDEX idx_on_demand_runs_created ON on_demand_runs (created_at);
  `);
}

interface StoredRow {
  id: string; job: string; status: string; request_json: string; limit_usd: number; model: string; provider: string | null;
  trigger: string; notes: number; counts_json: string; spent_usd: number; detail: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; undone_at: string | null;
}

function toRow(stored: StoredRow): OnDemandRunRow {
  return {
    id: stored.id,
    job: stored.job as OnDemandJob,
    status: stored.status as OnDemandRunStatus,
    request: JSON.parse(stored.request_json) as Record<string, unknown>,
    limit_usd: stored.limit_usd,
    model: stored.model,
    provider: stored.provider,
    trigger: stored.trigger,
    notes: stored.notes,
    counts: JSON.parse(stored.counts_json) as Record<string, unknown>,
    spent_usd: stored.spent_usd,
    detail: stored.detail,
    created_at: stored.created_at,
    started_at: stored.started_at,
    finished_at: stored.finished_at,
    undone_at: stored.undone_at,
  };
}

/** The process a run belongs to. The server and a CLI on the same machine share this database. */
export interface OnDemandRunOwner { host: string; pid: number }

export interface NewOnDemandRun {
  id: string; job: OnDemandJob; request: object; counts: object; limitUsd: number; model: string; provider: string | null;
  trigger: string; notes: number; createdAt: string; owner: OnDemandRunOwner;
}

export function insertOnDemandRun(db: Database.Database, run: NewOnDemandRun): void {
  db.prepare(`
    INSERT INTO on_demand_runs (id, job, status, request_json, limit_usd, model, provider, trigger, notes, counts_json, created_at,
      owner_host, owner_pid, heartbeat_at)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(run.id, run.job, JSON.stringify(run.request), run.limitUsd, run.model, run.provider, run.trigger, run.notes,
    JSON.stringify(run.counts), run.createdAt, run.owner.host, run.owner.pid, run.createdAt);
}

/**
 * Start a run only if none is queued or running, as one write transaction: the server and a CLI
 * share this database, and each has its own queue, so nothing else stops two of them starting a
 * run at the same moment. `release` first marks runs whose process is gone. Returns the run that
 * is already active, whatever its job, or null when `run` was inserted and is now the active one.
 *
 * `admit` is the last word on whether this run may start, asked once no run is active and before
 * the row is written; it throws to refuse, and nothing is then inserted. The day's ceiling is
 * checked here: a check made earlier can be stale, because another run may have started, spent
 * and finished while this one's scope was being counted.
 */
export function claimOnDemandRun(db: Database.Database, run: NewOnDemandRun,
  release: () => void, admit: () => void = () => {}): OnDemandRunRow | null {
  return db.transaction((): OnDemandRunRow | null => {
    release();
    const active = activeOnDemandRun(db);
    if (active !== null) return active;
    admit();
    insertOnDemandRun(db, run);
    return null;
  }).immediate();
}

/** The owning process says it is still there. */
export function touchOnDemandRun(db: Database.Database, id: string, at: string): void {
  db.prepare("UPDATE on_demand_runs SET heartbeat_at = ? WHERE id = ? AND status IN ('queued', 'running')").run(at, id);
}

export function getOnDemandRun(db: Database.Database, id: string): OnDemandRunRow | null {
  const stored = db.prepare('SELECT * FROM on_demand_runs WHERE id = ?').get(id) as StoredRow | undefined;
  return stored === undefined ? null : toRow(stored);
}

/** Newest first; one job's runs, or every job's. */
export function listOnDemandRuns(db: Database.Database, limit: number, job?: OnDemandJob): OnDemandRunRow[] {
  const stored = (job === undefined
    ? db.prepare('SELECT * FROM on_demand_runs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM on_demand_runs WHERE job = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(job, limit)) as StoredRow[];
  return stored.map(toRow);
}

/** The run still queued or running, if any: at most one at a time, across every job. */
export function activeOnDemandRun(db: Database.Database): OnDemandRunRow | null {
  const stored = db.prepare(
    "SELECT * FROM on_demand_runs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
  ).get() as StoredRow | undefined;
  return stored === undefined ? null : toRow(stored);
}

export function markOnDemandRunStarted(db: Database.Database, id: string, at: string): void {
  db.prepare("UPDATE on_demand_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(at, id);
}

/** Progress after each batch of notes, so status shows a run that is still going. */
export function saveOnDemandRunProgress(db: Database.Database, id: string, counts: object, spentUsd: number): void {
  db.prepare('UPDATE on_demand_runs SET counts_json = ?, spent_usd = ? WHERE id = ?').run(JSON.stringify(counts), spentUsd, id);
}

export function finishOnDemandRun(db: Database.Database, id: string, end: {
  status: Exclude<OnDemandRunStatus, 'queued' | 'running'>; detail: string | null; at: string;
}): void {
  db.prepare('UPDATE on_demand_runs SET status = ?, detail = ?, finished_at = ? WHERE id = ?')
    .run(end.status, end.detail, end.at, id);
}

/** A run's process beats this often, and is taken for gone after this long without a beat. */
export const ON_DEMAND_HEARTBEAT_MS = 15_000;
export const ON_DEMAND_STALE_MS = 2 * 60_000;

/**
 * Mark the runs whose process is gone as interrupted, and return how many. A run is queued or
 * running only while its owner lives: the server that accepted it, or a CLI. One is gone when
 * its heartbeat is older than `ON_DEMAND_STALE_MS`, or sooner when it ran on this machine and
 * its process no longer exists (`alive`). A run another live process owns is left alone, so
 * the server starting up does not end a CLI's run, nor the reverse.
 *
 * Called at server start and before a run is started, listed or undone.
 */
export function interruptAbandonedOnDemandRuns(db: Database.Database, input: {
  now: Date; host: string; alive: (pid: number) => boolean;
}): number {
  const open = db.prepare("SELECT id, job, owner_host, owner_pid, heartbeat_at FROM on_demand_runs WHERE status IN ('queued', 'running')")
    .all() as Array<{ id: string; job: string; owner_host: string; owner_pid: number; heartbeat_at: string }>;
  const mark = db.prepare(`
    UPDATE on_demand_runs SET status = 'interrupted', finished_at = ?, detail = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `);
  let marked = 0;
  for (const run of open) {
    const silent = input.now.getTime() - Date.parse(run.heartbeat_at) > ON_DEMAND_STALE_MS;
    const gone = run.owner_host === input.host && !input.alive(run.owner_pid);
    if (!silent && !gone) continue;
    marked += mark.run(input.now.toISOString(),
      `The process running this stopped before it finished. Start it again to continue: ${alreadyDone(run.job)} are not asked again.`,
      run.id).changes;
  }
  return marked;
}

export function recordOnDemandRunOperation(db: Database.Database, runId: string, operationId: string, nodeId: string, at: string): void {
  db.prepare('INSERT OR IGNORE INTO on_demand_run_operations (run_id, operation_id, node_id, written_at) VALUES (?, ?, ?, ?)')
    .run(runId, operationId, nodeId, at);
}

/** Give one of a run's recorded operations a new id, keeping its place: a write the run itself changed again since (#659). */
export function renameOnDemandRunOperation(db: Database.Database, runId: string, from: string, to: string): void {
  db.prepare('UPDATE OR IGNORE on_demand_run_operations SET operation_id = ? WHERE run_id = ? AND operation_id = ?').run(to, runId, from);
}

/** A run's undo operations, oldest write first, and when the first was written. */
export function onDemandRunOperations(db: Database.Database, runId: string): { ids: string[]; firstWrittenAt: string | null } {
  const rows = db.prepare('SELECT operation_id, written_at FROM on_demand_run_operations WHERE run_id = ? ORDER BY written_at, operation_id')
    .all(runId) as Array<{ operation_id: string; written_at: string }>;
  return { ids: rows.map(row => row.operation_id), firstWrittenAt: rows[0]?.written_at ?? null };
}

/**
 * What the runs started at or after `sinceIso` have spent, every job's together, by their own
 * tallies: the figure the day's ceiling for on-demand runs is checked against. A run's tally is
 * saved after each batch and counts calls the usage ledger never records, so this needs no read
 * of the ledger.
 */
export function onDemandSpentSince(db: Database.Database, sinceIso: string): number {
  return (db.prepare('SELECT COALESCE(SUM(spent_usd), 0) AS spent FROM on_demand_runs WHERE created_at >= ?').get(sinceIso) as { spent: number }).spent;
}

export function markOnDemandRunUndone(db: Database.Database, id: string, at: string): void {
  db.prepare('UPDATE on_demand_runs SET undone_at = ? WHERE id = ?').run(at, id);
}

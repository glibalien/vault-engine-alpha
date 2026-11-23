import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS, type Migration } from '../src/db/migrate.js';
import { getWikiRoot, registerWikiRoot } from '../src/db/wiki-roots.js';
import { insertPageRequest, markRequestFulfilled, pinnedPageTitles } from '../src/db/requests.js';

function version(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function getConversationCaptureLedger(db: Database.Database, conversationId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM conversation_capture_ledger WHERE conversation_id = ?').get(conversationId) as Record<string, unknown> | undefined;
}

describe('runMigrations', () => {
  it('keeps the link sweep\'s notes past 37 and lets a note be applied (#332)', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 36));
    db.prepare("INSERT INTO link_sweep_notes (node_id, status, proposals, failures, checked_at) VALUES ('a', 'reported', 3, 0, '2026-11-18T05:00:00Z'), ('b', 'pending', 0, 2, '2026-11-19T05:00:00Z')").run();
    expect(() => db.prepare("UPDATE link_sweep_notes SET status = 'applied' WHERE node_id = 'a'").run()).toThrow(/CHECK/);
    runMigrations(db);
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT node_id, status, proposals, failures, checked_at FROM link_sweep_notes ORDER BY node_id').all()).toEqual([
      { node_id: 'a', status: 'reported', proposals: 3, failures: 0, checked_at: '2026-11-18T05:00:00Z' },
      { node_id: 'b', status: 'pending', proposals: 0, failures: 2, checked_at: '2026-11-19T05:00:00Z' },
    ]);
    db.prepare("UPDATE link_sweep_notes SET status = 'applied' WHERE node_id = 'a'").run();
    expect(() => db.prepare("UPDATE link_sweep_notes SET status = 'linked' WHERE node_id = 'a'").run()).toThrow(/CHECK/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_link_sweep_notes_status'").get()).toEqual({ name: 'idx_link_sweep_notes_status' });
    db.close();
  });
  it('adds the subject runs\' "no subjects" answers at 38 (#554)', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 37));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'subject_run_verdicts'").get()).toBeUndefined();
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(columnNames(db, 'subject_run_verdicts')).toEqual(['memory_id', 'shown_hash', 'call_hash', 'model', 'decided_at']);
    db.close();
  });
  it('adds the link sweep\'s seen names and re-read queue at 39 (#699)', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 38));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'link_sweep_names'").get()).toBeUndefined();
    runMigrations(db);
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(columnNames(db, 'link_sweep_names')).toEqual(['name_key', 'target_id', 'seen_at']);
    expect(columnNames(db, 'link_sweep_names_seeded')).toEqual(['id', 'seeded_at']);
    expect(columnNames(db, 'link_sweep_rechecks')).toEqual(['node_id', 'name', 'queued_at']);
    db.close();
  });
  it('adds the dossier builds table at 41 (#722)', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 40));
    runMigrations(db);
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(columnNames(db, 'dossier_builds')).toEqual(['run_ref', 'node_id', 'page_title', 'state', 'scheduled', 'queued_at', 'updated_at', 'host', 'pid', 'process_ref']);
    db.close();
  });
  it('adds the dossiers table at 40 (#714)', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 39));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'dossiers'").get()).toBeUndefined();
    runMigrations(db);
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(columnNames(db, 'dossiers')).toEqual(['node_id', 'page_title', 'home_id', 'output_revision_id', 'built_at', 'memory_total', 'status', 'checked_at']);
    db.close();
  });
  it('keeps version 31 taken and drops the retired wiki_page_fact_states table at 32 (#352)', () => {
    // Production reached 31 with the node-facts table (#389) before facts were retired.
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 30));
    db.exec('CREATE TABLE wiki_page_fact_states (page_id TEXT PRIMARY KEY, built_at TEXT NOT NULL, nodes_json TEXT NOT NULL)');
    db.pragma('user_version = 31');
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'wiki_page_fact_states'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'wiki_page_note_states'").get()).toEqual({ name: 'wiki_page_note_states' });
    // A fresh DB takes the same path without the table.
    const fresh = new Database(':memory:');
    runMigrations(fresh);
    expect(version(fresh)).toBe(41);
    db.close();
    fresh.close();
  });
  it('adds nullable execution storage to legacy request rows without changing pins and reruns safely', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 18));
    const id = insertPageRequest(db, {
      project_node_id: 'project-1', project_title: 'Project', title: 'Decisions',
      page_title: 'Project — Decisions', brief: null, requested_by: null,
      created_at: '2026-09-25T00:00:00.000Z',
    });
    markRequestFulfilled(db, id, 'Project — Decisions', 'page-1', '2026-09-25T01:00:00.000Z');

    runMigrations(db);
    runMigrations(db);

    expect(version(db)).toBe(41);
    expect(columnNames(db, 'page_requests').filter(name => name === 'execution_json')).toEqual(['execution_json']);
    expect(db.prepare('SELECT execution_json FROM page_requests WHERE id=?').get(id)).toEqual({ execution_json: null });
    expect(pinnedPageTitles(db, 'Project')).toEqual(new Set(['Project — Decisions']));
    db.close();
  });
  it('applies the real MIGRATIONS list and creates the runs + page_requests tables', () => {
    const db = new Database(':memory:');
    expect(MIGRATIONS).toHaveLength(41);
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare('PRAGMA table_info(runs)').all()).toContainEqual(expect.objectContaining({ name: 'topology_json', type: 'TEXT' }));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'")
      .all();
    expect(tables).toHaveLength(1);
    const control = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('wiki_control','wiki_corrections')")
      .all();
    expect(control).toHaveLength(2);
    const roots = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_roots'").all();
    expect(roots).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_capture_state','conversation_capture_ledger','conversation_capture_artifacts')").all()).toHaveLength(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conversation_capture_artifacts_conversation'").all()).toHaveLength(1);
    expect(columnNames(db, 'conversation_capture_ledger')).toEqual(expect.arrayContaining(['decision_evidence_hash', 'decision_evidence_version']));
    const attempts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='field_guess_attempts'",
    ).all();
    expect(attempts).toHaveLength(1);
    db.close();
  });

  it('is idempotent on the real list — a second run is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db);
    expect(version(db)).toBe(41);
    db.close();
  });

  it('migrates a version 9 runs table to topology_json and reruns safely', () => {
    // Given
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 9));

    // When
    runMigrations(db);
    runMigrations(db);

    // Then
    expect(version(db)).toBe(41);
    expect(db.prepare('PRAGMA table_info(runs)').all().filter((column: unknown) =>
      typeof column === 'object' && column !== null && 'name' in column && column.name === 'topology_json')).toHaveLength(1);
    db.close();
  });

  it('upgrades a version 10 database without changing existing rows', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 10));
    db.prepare(`
      INSERT INTO runs (
        ts, project, "trigger", dry_run, outcome, home_written, spine_written, spine_total,
        themed_created, themed_retired, input_tokens, output_tokens, cache_read, cache_write,
        duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('2026-08-25T12:00:00.000Z', 'Project', 'scheduled', 0, 'written', 1, 0, 0, 0, 0, 10, 20, 0, 0, 123);
    const before = db.prepare('SELECT * FROM runs').get();

    runMigrations(db);

    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT * FROM runs').get()).toEqual({ ...(before as object), output_policy_hash: null });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='field_guess_attempts'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='conversation_capture_artifacts'",
    ).get()).toEqual({ count: 1 });
    db.close();
  });

  it('upgrades a version 11 field-guess database to capture migration 12 without row loss', () => {
    const db = new Database(':memory:');
    const earlier = MIGRATIONS.filter(migration => migration.version <= 11);
    expect(earlier.map(migration => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    runMigrations(db, earlier);
    expect(version(db)).toBe(11);
    db.prepare(`
      INSERT INTO field_guess_attempts (
        run_ref, call_ref, node_id, field_name, content_hash, definition_hash,
        model, classifier_version, outcome, attempted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'run-1', 'call-1', 'node-1', 'status', 'content-1', 'definition-1',
      'model-1', 1, 'abstained', '2026-08-25T12:00:00.000Z',
    );
    const before = db.prepare('SELECT * FROM field_guess_attempts').all();

    runMigrations(db);
    runMigrations(db);

    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT * FROM field_guess_attempts').all()).toEqual(before.map(row => ({ ...(row as Record<string, unknown>), evidence_hash: null, evidence_version: null })));
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='conversation_capture_artifacts'",
    ).get()).toEqual({ count: 1 });
    db.close();
  });

  it('upgrades a version 12 capture ledger while preserving legacy null evidence', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 12));
    db.prepare(`
      INSERT INTO conversation_capture_ledger (
        conversation_id, input_hash, processed_at, outcome, artifact_count, destination_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy', 'input', '2026-08-25T12:00:00.000Z', 'no-fitting-destination', 0, 0);

    runMigrations(db);

    expect(version(db)).toBe(41);
    expect(columnNames(db, 'conversation_capture_ledger')).toEqual(expect.arrayContaining(['decision_evidence_hash', 'decision_evidence_version']));
    expect(getConversationCaptureLedger(db, 'legacy')).toMatchObject({ decision_evidence_hash: null, decision_evidence_version: null });
    db.close();
  });

  it('rolls back migration 13 schema and version when its up fails', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 12));
    const failing: Migration = {
      version: 13,
      name: 'fake-failing-13',
      up: (d) => {
        d.exec('ALTER TABLE conversation_capture_ledger ADD COLUMN temporary_column TEXT');
        throw new Error('migration failed');
      },
    };

    expect(() => runMigrations(db, [...MIGRATIONS.filter(migration => migration.version <= 12), failing])).toThrow('migration failed');
    expect(version(db)).toBe(12);
    expect(columnNames(db, 'conversation_capture_ledger')).not.toContain('temporary_column');
    db.close();
  });

  it('upgrades a version 13 database with topic refresh state while preserving legacy topics', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(migration => migration.version <= 13));
    db.exec(`
      ALTER TABLE runs DROP COLUMN refresh_trigger;
      ALTER TABLE runs DROP COLUMN refresh_evidence_json;
    `);
    expect(columnNames(db, 'runs')).not.toEqual(expect.arrayContaining(['refresh_trigger', 'refresh_evidence_json']));
    registerWikiRoot(db, {
      root_title: 'Legacy Topic', root_node_id: 'legacy-root', kind: 'topic', source: 'vault',
      cadence: 'weekly', brief: null, created_at: '2026-08-29T12:00:00.000Z', created_by: null,
    });

    runMigrations(db);

    expect(version(db)).toBe(41);
    expect(getWikiRoot(db, 'Legacy Topic')).toMatchObject({ root_node_id: 'legacy-root' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topic_refresh_sources'").all()).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_topic_refresh_sources_root_kind'").all()).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topic_refresh_state'").all()).toHaveLength(1);
    expect(columnNames(db, 'topic_refresh_state')).toContain('pending_baseline_retry');
    expect(columnNames(db, 'runs')).toEqual(expect.arrayContaining(['refresh_trigger', 'refresh_evidence_json']));
    const primaryKey = (db.prepare('PRAGMA table_info(topic_refresh_sources)').all() as Array<{
      name: string; pk: number;
    }>).filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk);
    expect(primaryKey.map(column => column.name)).toEqual(['root_title', 'node_id', 'source_kind']);
    db.close();
  });

  it('rolls back migration 14 table, altered runs column, and version when its up fails', () => {
    const db = new Database(':memory:');
    const through13 = MIGRATIONS.filter(migration => migration.version <= 13);
    runMigrations(db, through13);
    const failing: Migration = {
      version: 14,
      name: 'fake-failing-14',
      up: (d) => {
        d.exec('CREATE TABLE temporary_topic_refresh (id INTEGER PRIMARY KEY)');
        d.exec('ALTER TABLE runs ADD COLUMN temporary_refresh_column TEXT');
        throw new Error('migration 14 failed');
      },
    };

    expect(() => runMigrations(db, [...through13, failing])).toThrow('migration 14 failed');
    expect(version(db)).toBe(13);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temporary_topic_refresh'").all()).toHaveLength(0);
    expect(columnNames(db, 'runs')).not.toContain('temporary_refresh_column');
    db.close();
  });

  it('upgrades a deployed version 25 database without touching its retired maintenance tables', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE maintenance_jobs (job_id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY)');
    db.prepare("INSERT INTO maintenance_jobs VALUES ('job-1')").run();
    db.pragma('user_version = 25');
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT job_id FROM maintenance_jobs').all()).toEqual([{ job_id: 'job-1' }]);
    expect(columnNames(db, 'wiki_evidence_manifests')).toEqual(['project', 'evidence_hash', 'components_json', 'curated_at']);
    expect(columnNames(db, 'wiki_deferred_creates')).toEqual(['root_title', 'evidence_hash', 'count']);
    db.close();
  });

  it('upgrades a version 26 database with an empty deferred-creates table, keeping its manifests', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(m => m.version <= 26));
    db.prepare("INSERT INTO wiki_evidence_manifests VALUES ('Project', 'h', '{}', '2026-10-25T05:00:00.000Z')").run();
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT project FROM wiki_evidence_manifests').all()).toEqual([{ project: 'Project' }]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM wiki_deferred_creates').get()).toEqual({ c: 0 });
    db.close();
  });

  it('upgrades a version 27 database with an empty stage-checkpoints table, keeping its deferred creates', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(m => m.version <= 27));
    db.prepare("INSERT INTO wiki_deferred_creates VALUES ('Project', 'h', 2)").run();
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT root_title, count FROM wiki_deferred_creates').all()).toEqual([{ root_title: 'Project', count: 2 }]);
    expect(columnNames(db, 'wiki_stage_checkpoints')).toEqual(['root_title', 'fingerprint', 'planning_json', 'pages_json', 'created_at']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM wiki_stage_checkpoints').get()).toEqual({ c: 0 });
    db.close();
  });

  it('upgrades a version 28 database with an empty budget-charges table, keeping its checkpoints', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(m => m.version <= 28));
    db.prepare("INSERT INTO wiki_stage_checkpoints VALUES ('Project', 'fp', '{}', '[]', '2026-10-25T12:00:00.000Z')").run();
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare('SELECT root_title FROM wiki_stage_checkpoints').all()).toEqual([{ root_title: 'Project' }]);
    expect(columnNames(db, 'budget_charges')).toEqual(['charged_at', 'amount_usd']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM budget_charges').get()).toEqual({ c: 0 });
    db.close();
  });

  it('advances a version 20 database past the reserved versions without maintenance tables', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS.filter(m => m.version <= 20));
    expect(version(db)).toBe(20);
    runMigrations(db);
    expect(version(db)).toBe(41);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'maintenance_%'").all()).toEqual([]);
    db.close();
  });

  it('applies an injected migration, runs its up(), and bumps user_version', () => {
    const db = new Database(':memory:');
    const fake: Migration[] = [
      {
        version: 1,
        name: 'create-fake',
        up: (d) => d.exec('CREATE TABLE fake (id INTEGER PRIMARY KEY)'),
      },
    ];
    runMigrations(db, fake);
    expect(version(db)).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fake'")
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it('runs migrations in version order regardless of array order', () => {
    const db = new Database(':memory:');
    const applied: number[] = [];
    const migrations: Migration[] = [
      { version: 2, name: 'second', up: () => applied.push(2) },
      { version: 1, name: 'first', up: () => applied.push(1) },
    ];
    runMigrations(db, migrations);
    expect(applied).toEqual([1, 2]);
    expect(version(db)).toBe(2);
    db.close();
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = new Database(':memory:');
    let ups = 0;
    const migrations: Migration[] = [
      { version: 1, name: 'once', up: () => { ups += 1; } },
    ];
    runMigrations(db, migrations);
    runMigrations(db, migrations);
    expect(ups).toBe(1);
    expect(version(db)).toBe(1);
    db.close();
  });
});

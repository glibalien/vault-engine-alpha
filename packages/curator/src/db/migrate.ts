import { createProvenanceIdentity } from './provenance.js';
import { createEvidenceManifestTable } from './evidence-manifests.js';
import { createDeferredCreatesTable } from './deferred-creates.js';
import { createStageCheckpointsTable } from './stage-checkpoints.js';
import { createBudgetChargesTable } from './budget-charges.js';
import { createPageNoteStatesTable } from './page-note-states.js';
import { addLinkSweepApplied, createLinkSweepNameTables, createLinkSweepTables } from './link-sweep.js';
import { createFieldFillRunTables, generalizeRunTables } from './on-demand-runs.js';
import { createTypeVerdictTable } from './type-verdicts.js';
import { createSubjectVerdictTable } from './subject-verdicts.js';
import { createDossierTable } from './dossiers.js';
import { createDossierBuildTable } from './dossier-builds.js';
import { createHomeRefreshAliases, createHomeRefreshRequests } from './home-refresh.js';
import type Database from 'better-sqlite3';
import { createRunsTable } from './runs.js';
import { createPageRequestsTable } from './requests.js';
import { createWikiControlTables } from './control.js';
import { createWikiRootsTable } from './wiki-roots.js';
import { createMemorySweepTables } from './memory-sweep.js';
import { createOrgSweepTables } from './org-sweep.js';
import { createJournalTable } from './journal.js';
import { createReconcileTable } from './reconcile.js';
import { createConversationSweepTables } from './conversation-sweep.js';
import { createConversationCaptureTables } from './conversation-capture.js';
import { createFieldGuessTables } from './field-guess.js';
import { createTopicRefreshTables } from './topic-refresh.js';

export interface Migration {
  /** Target `user_version` after this migration applies. Must be a positive integer, unique, monotonically increasing. */
  version: number;
  /** Human-readable label (for logs/debugging). */
  name: string;
  /** Schema change. Runs inside a transaction with the version bump. */
  up: (db: Database.Database) => void;
}

/**
 * Curator-owned versioned migrations (append-only). OAuth tables come from the
 * idempotent `createAuthSchema` and are not listed here. Each entry runs in a
 * transaction that bumps `user_version`; additive changes stay clean because
 * they are real migrations rather than create-if-missing bootstrap DDL.
 *
 * #1 — `runs` table (run-history observability)
 * #2 — `page_requests` table (caller-requested wiki sub-pages + pin set)
 * #3 — `wiki_control` + `wiki_corrections` tables (pause flag + standing corrections)
 * #4 — `wiki_roots` table (caller-created topic wiki registry)
 * #5 — `memory_sweep_ledger` + `memory_sweep_state` (v1.6 auto memory collection)
 * #6 — `org_sweep_ledger` (organization sweep null-verdict ledger)
 * #7 — journal_events table (curator journal action/summary events)
 * #8 — reconcile_ledger (§4c nightly reconciliation verdicts)
 * #9 — memory_sweep_conversation_ledger + conversation_sweep_state (conversation memory sweep)
 * #10 — nullable topology_json on runs (bounded topology observability)
 * #11 — append-only field_guess_attempts (inference retry and observability history)
 * #12 — conversation capture state, ledger, and exact artifact recovery records
 * #13 — decision evidence hash and version on conversation capture ledger
 * #14 — topic refresh source and web evidence baselines
 * #15 — versioned bounded prompt evidence on field-guess attempts
 * #19 — nullable durable execution checkpoint on caller page requests
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'create-runs-table', up: createRunsTable },
  { version: 2, name: 'create-page-requests-table', up: createPageRequestsTable },
  { version: 3, name: 'create-wiki-control-tables', up: createWikiControlTables },
  { version: 4, name: 'create-wiki-roots-table', up: createWikiRootsTable },
  { version: 5, name: 'create-memory-sweep-tables', up: createMemorySweepTables },
  { version: 6, name: 'create-org-sweep-tables', up: createOrgSweepTables },
  { version: 7, name: 'create-journal-events-table', up: createJournalTable },
  { version: 8, name: 'create-reconcile-ledger', up: createReconcileTable },
  { version: 9, name: 'create-conversation-sweep-tables', up: createConversationSweepTables },
  {
    version: 10,
    name: 'add-run-topology-json',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'topology_json')) db.exec('ALTER TABLE runs ADD COLUMN topology_json TEXT');
    },
  },
  { version: 11, name: 'create-field-guess-attempts', up: createFieldGuessTables },
  { version: 12, name: 'create-conversation-capture-tables', up: createConversationCaptureTables },
  {
    version: 13,
    name: 'add-conversation-capture-decision-evidence',
    up: (db) => {
      const columns = db.prepare(
        'PRAGMA table_info(conversation_capture_ledger)',
      ).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'decision_evidence_hash')) {
        db.exec(
          'ALTER TABLE conversation_capture_ledger ADD COLUMN decision_evidence_hash TEXT',
        );
      }
      if (!columns.some((column) => column.name === 'decision_evidence_version')) {
        db.exec(
          'ALTER TABLE conversation_capture_ledger ADD COLUMN decision_evidence_version INTEGER',
        );
      }
    },
  },
  {
    version: 14,
    name: 'create-topic-refresh-state',
    up: (db) => {
      createTopicRefreshTables(db);
      const columns = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'refresh_trigger')) {
        db.exec('ALTER TABLE runs ADD COLUMN refresh_trigger TEXT');
      }
      if (!columns.some((column) => column.name === 'refresh_evidence_json')) {
        db.exec('ALTER TABLE runs ADD COLUMN refresh_evidence_json TEXT');
      }
    },
  },
  {
    version: 15,
    name: 'add-field-guess-prompt-evidence',
    up: (db) => {
      db.exec(`
        ALTER TABLE field_guess_attempts ADD COLUMN evidence_hash TEXT;
        ALTER TABLE field_guess_attempts ADD COLUMN evidence_version INTEGER;
        DROP INDEX idx_field_guess_terminal_lookup;
        CREATE INDEX idx_field_guess_terminal_lookup ON field_guess_attempts (
          node_id, field_name, content_hash, definition_hash, model, classifier_version,
          evidence_hash, evidence_version, outcome
        );
      `);
    },
  },
  { version: 16, name: 'create-provenance-identity', up: createProvenanceIdentity },
  { version: 17, name: 'create-home-refresh-requests', up: createHomeRefreshRequests },
  { version: 18, name: 'create-home-refresh-aliases', up: createHomeRefreshAliases },
  { version: 19, name: 'add-page-request-execution', up: (db) => {
    db.exec('ALTER TABLE page_requests ADD COLUMN execution_json TEXT');
  } },
  { version: 20, name: 'topic-source-selection', up: db => {
    db.exec('ALTER TABLE topic_refresh_sources ADD COLUMN freshness_version INTEGER');
    db.exec('ALTER TABLE topic_refresh_sources ADD COLUMN freshness_hash TEXT');
    db.exec('ALTER TABLE topic_refresh_sources ADD COLUMN selection_json TEXT');
  } },
  // 21-25 created tables for the retired maintenance subsystem (2026-10). Deployed
  // DBs may already be at 25, so these versions stay reserved as no-ops; leftover
  // maintenance_* tables are unused and intentionally left in place.
  ...[21, 22, 23, 24, 25].map((version): Migration => ({
    version, name: `retired-maintenance-${version}`, up: () => {},
  })),
  { version: 26, name: 'wiki-evidence-manifests', up: createEvidenceManifestTable },
  { version: 27, name: 'wiki-deferred-creates', up: createDeferredCreatesTable },
  { version: 28, name: 'wiki-stage-checkpoints', up: createStageCheckpointsTable },
  { version: 29, name: 'budget-charges', up: createBudgetChargesTable },
  { version: 30, name: 'runs-output-policy-hash', up: db => {
    db.exec('ALTER TABLE runs ADD COLUMN output_policy_hash TEXT');
  } },
  // Version 31 created `wiki_page_fact_states` for wikis built from node facts (#389), retired on
  // 2026-11-09 (#352). Production is at 31, so the number stays taken: a new migration 31 would
  // never run there. 32 drops the table wherever 31 made it.
  { version: 31, name: 'wiki-page-fact-states (retired)', up: () => {} },
  { version: 32, name: 'drop-wiki-page-fact-states', up: db => {
    db.exec('DROP TABLE IF EXISTS wiki_page_fact_states');
  } },
  { version: 33, name: 'wiki-page-note-states', up: createPageNoteStatesTable },
  { version: 34, name: 'link-sweep', up: createLinkSweepTables },
  { version: 35, name: 'field-fill-runs', up: createFieldFillRunTables },
  // The run tables take every on-demand job, and typing runs keep their "no type fits" verdicts (#644).
  { version: 36, name: 'on-demand-runs', up: db => { generalizeRunTables(db); createTypeVerdictTable(db); } },
  // A note the link sweep read in apply mode (#332), apart from one a report-only run read.
  { version: 37, name: 'link-sweep-applied', up: addLinkSweepApplied },
  // On-demand subject runs' "no subjects" answers (#554, slice 2).
  { version: 38, name: 'subject-run-verdicts', up: createSubjectVerdictTable },
  // The names the link sweep has seen, and notes to read again for a new one (#699).
  { version: 39, name: 'link-sweep-names', up: createLinkSweepNameTables },
  { version: 40, name: 'dossiers', up: createDossierTable },
  { version: 41, name: 'dossier-builds', up: createDossierBuildTable },
];

/**
 * Applies every migration whose `version` exceeds the DB's current
 * `user_version`, in ascending version order, each inside a transaction that
 * also bumps `user_version`. Idempotent: re-running applies nothing new.
 * `migrations` is injectable so tests can feed a fake list.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS,
): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
}

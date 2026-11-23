// src/wiki/status.ts
//
// Keeps a project wiki's `behind` status exact (#547). A wiki home page's `wiki_status`
// says whether the wiki is current, behind, paused, paused-behind, building or failed.
// The Curator writes paused, building and failed, and a build stamps current (or
// paused). This check moves current to behind, and paused to paused-behind, once the
// project's evidence no longer matches the hash the last build stamped: the evidence
// comparison the Curator's gate makes before it rebuilds. (The gate also rebuilds for a
// changed page topology or an invalid catalog, which this does not show.)
//
// Notes are compared by text hash (#332), so a link added around words already in a note does not
// put a wiki behind. A home stamped before that, whose evidence still matches by the old formula,
// is stamped with the current one instead of being marked behind (`restampWikiEvidence`), once.
//
// It runs a few seconds after anything in the vault changes (the node count, the
// latest index time, or the wiki's calendar day moves), compares each such wiki once,
// and writes only the homes whose status changes, through the ordinary pipeline, so
// the file shows it at once. A home whose file has an edit the Engine has not read yet
// is skipped and tried again after the watcher reads it. Behind is kept until the next
// build, even if the change is undone. Topic wikis are not checked: only the Curator
// can work out their evidence.

import type Database from 'better-sqlite3';
import { effectiveSettings, type CuratorSettings } from '@vault/settings-registry';
import { executeMutation } from '../pipeline/execute.js';
import { loadNodeState } from '../pipeline/node-state.js';
import { getStoredSettings } from '../settings/store.js';
import type { SyncLogger } from '../sync/sync-logger.js';
import type { WriteLockManager } from '../sync/write-lock.js';
import type { EmbeddingIndexer } from '../search/indexer.js';
import { getWikiConfig, type WikiConfig } from './config.js';
import { projectEvidenceHash, projectEvidenceHashBeforeTextHashes } from './evidence.js';
import { calendarDate, wikiTimeZone } from './today.js';
import { isWikiStatus, type WikiStatus } from './status-values.js';
import { recordStatusOnlyWrite } from './status-versions.js';

export const WIKI_STATUS_CHECK_EVERY_MS = 5_000;

export interface WikiStatusDeps {
  readonly db: Database.Database;
  readonly writeLock: WriteLockManager;
  readonly vaultPath: string;
  readonly syncLogger?: SyncLogger;
  readonly embeddingIndexer?: Pick<EmbeddingIndexer, 'enqueue'>;
}

export interface WikiStatusChange {
  readonly home_id: string;
  readonly project_id: string;
  readonly from: WikiStatus;
  readonly to: WikiStatus;
}

/** The status a home moves to when its evidence no longer matches its last build, or null. */
export function behindStatus(status: WikiStatus): WikiStatus | null {
  if (status === 'current') return 'behind';
  if (status === 'paused') return 'paused-behind';
  return null;
}

interface CheckedHome {
  readonly projectId: string;
  readonly homeId: string;
  readonly status: WikiStatus;
  readonly evidenceHash: string;
}

/** A wiki's home page, as `project-evidence` picks it (`fetchExistingWiki`), with its status. */
export interface WikiHome {
  readonly id: string;
  readonly version: number;
  readonly status: WikiStatus | null;
  readonly evidenceHash: string | null;
}

/**
 * The home of the wiki whose root is `rootId`: the page of the wiki kind for that root with no
 * parent, newest first when there are several, the same pick `fetchExistingWiki` makes.
 */
export function findWikiHome(db: Database.Database, rootId: string, wikiType: string): WikiHome | null {
  const row = db.prepare(`
    SELECT n.id, n.version, status.value_text AS wiki_status, evidence.value_text AS wiki_evidence_hash
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = ?
    JOIN relationships r ON r.source_id = n.id AND r.rel_type = 'wiki_for' AND r.resolved_target_id = ?
    LEFT JOIN node_fields status ON status.node_id = n.id AND status.field_name = 'wiki_status'
    LEFT JOIN node_fields evidence ON evidence.node_id = n.id AND evidence.field_name = 'wiki_evidence_hash'
    WHERE NOT EXISTS (
      SELECT 1 FROM relationships rp WHERE rp.source_id = n.id AND rp.rel_type = 'wiki_parent'
    )
    ORDER BY n.file_mtime IS NULL, n.file_mtime DESC, n.title ASC
  `).get(wikiType, rootId) as
    | { id: string; version: number; wiki_status: string | null; wiki_evidence_hash: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    status: isWikiStatus(row.wiki_status) ? row.wiki_status : null,
    evidenceHash: row.wiki_evidence_hash,
  };
}

/**
 * The project wikis a check compares: each project's home when its status can still move and
 * a build has stamped its evidence hash. A root that is also a topic note is left out.
 */
function checkedHomes(db: Database.Database, config: WikiConfig): CheckedHome[] {
  const { wikiType, projectType, topicType } = config;
  if (wikiType === null || projectType === null) return [];
  const projects = db.prepare(`
    SELECT DISTINCT r.resolved_target_id AS project_id
    FROM nodes n
    JOIN node_types nt ON nt.node_id = n.id AND nt.schema_type = @wikiType
    JOIN relationships r ON r.source_id = n.id AND r.rel_type = 'wiki_for' AND r.resolved_target_id IS NOT NULL
    JOIN node_types pt ON pt.node_id = r.resolved_target_id AND pt.schema_type = @projectType
    WHERE NOT EXISTS (SELECT 1 FROM relationships rp WHERE rp.source_id = n.id AND rp.rel_type = 'wiki_parent')
      AND NOT EXISTS (SELECT 1 FROM node_types tt WHERE tt.node_id = r.resolved_target_id AND tt.schema_type = @topicType)
    ORDER BY project_id
  `).all({ wikiType, projectType, topicType: topicType ?? '' }) as Array<{ project_id: string }>;
  const homes: CheckedHome[] = [];
  for (const { project_id } of projects) {
    const home = findWikiHome(db, project_id, wikiType);
    if (!home || !home.evidenceHash || home.status === null) continue;
    if (behindStatus(home.status) === null) continue;
    homes.push({ projectId: project_id, homeId: home.id, status: home.status, evidenceHash: home.evidenceHash });
  }
  return homes;
}

/** Whether the check compares this root: a project note that is not also a topic note. */
function isCheckedRoot(db: Database.Database, config: WikiConfig, rootId: string): boolean {
  if (config.projectType === null) return false;
  const types = (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(rootId) as Array<{ schema_type: string }>)
    .map(row => row.schema_type);
  return types.includes(config.projectType) && (config.topicType === null || !types.includes(config.topicType));
}

/**
 * The status to write in place of `status`: behind for current, paused-behind for paused, when
 * the root is a project whose evidence no longer matches `stampedHash`. So a resume, a startup
 * stamp, or a build that a note edit overtook writes the right value at once, not a current
 * that the next check corrects. Any other status, root or missing hash is written as asked.
 */
export function settledWikiStatus(
  db: Database.Database,
  config: WikiConfig,
  rootId: string,
  status: WikiStatus,
  stampedHash: string | null | undefined,
): WikiStatus {
  const behind = behindStatus(status);
  if (behind === null || !stampedHash || !isCheckedRoot(db, config, rootId)) return status;
  try {
    const options = { project: rootId, meeting_recent_limit: curatorMeetingReads(db) };
    if (projectEvidenceHash(db, options) === stampedHash) return status;
    // A stamp from before text hashes (#332) that still matches; the next check restamps it.
    return projectEvidenceHashBeforeTextHashes(db, options) === stampedHash ? status : behind;
  } catch (err) {
    console.warn(`[wiki-status] could not read the evidence of project ${rootId}: ${message(err)}`);
    return status;
  }
}

/** The meeting limit the Curator's builds read evidence with (its `meetingReads` setting). */
function curatorMeetingReads(db: Database.Database): number {
  const settings = effectiveSettings<CuratorSettings>('curator', getStoredSettings(db, 'curator'));
  return Math.min(settings.meetingReads, 100);
}

/**
 * Compare every checked project wiki with its last build once, and write `behind` (or
 * `paused-behind`) to each home whose evidence has moved on. Returns what it wrote.
 */
export function checkWikiStatuses(deps: WikiStatusDeps): WikiStatusChange[] {
  const config = getWikiConfig(deps.db);
  const homes = checkedHomes(deps.db, config);
  if (homes.length === 0) return [];
  const meetingRecentLimit = curatorMeetingReads(deps.db);
  const changes: WikiStatusChange[] = [];
  for (const home of homes) {
    let liveHash: string;
    try {
      liveHash = projectEvidenceHash(deps.db, { project: home.projectId, meeting_recent_limit: meetingRecentLimit });
    } catch (err) {
      console.warn(`[wiki-status] could not read the evidence of project ${home.projectId}: ${message(err)}`);
      continue;
    }
    if (liveHash === home.evidenceHash) continue;
    if (stampedBeforeTextHashes(deps.db, home, meetingRecentLimit)) {
      try {
        restampWikiEvidence(deps, home.homeId, home.evidenceHash, liveHash);
      } catch (err) {
        console.warn(`[wiki-status] left the stamp of home ${home.homeId} as it is for now: ${message(err)}`);
      }
      continue;
    }
    const to = behindStatus(home.status);
    if (to === null) continue;
    try {
      const write = setWikiHomeStatus(deps, home.homeId, to, { onlyFrom: home.status });
      if (write?.written) changes.push({ home_id: home.homeId, project_id: home.projectId, from: home.status, to });
    } catch (err) {
      // Most often an edit not read yet; the watcher's read of it moves the signature,
      // and the next check tries again.
      console.warn(`[wiki-status] left home ${home.homeId} as it is for now: ${message(err)}`);
    }
  }
  return changes;
}

/** Whether the home's stamp is the project's evidence by the formula from before text hashes (#332). */
function stampedBeforeTextHashes(db: Database.Database, home: CheckedHome, meetingRecentLimit: number): boolean {
  try {
    return projectEvidenceHashBeforeTextHashes(db, { project: home.projectId, meeting_recent_limit: meetingRecentLimit })
      === home.evidenceHash;
  } catch {
    return false;
  }
}

/**
 * Replace a home's evidence stamp `from` with `to`, the same evidence by the current formula
 * (#332). The field is never rendered, so only the database changes; the version it adds is
 * recorded like a status write's, so a build or page request that read the home before it still
 * writes. Nothing is written when the stamp is no longer `from`. Throws as `setWikiHomeStatus`.
 */
export function restampWikiEvidence(deps: WikiStatusDeps, homeId: string, from: string, to: string): boolean {
  const state = loadNodeState(deps.db, homeId);
  const row = deps.db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(homeId) as
    | { version: number; content_hash: string | null }
    | undefined;
  if (!state || !row || state.currentFields.wiki_evidence_hash !== from) return false;
  executeMutation(deps.db, deps.writeLock, deps.vaultPath, {
    source: 'tool',
    node_id: homeId,
    file_path: state.file_path,
    title: state.title,
    types: state.types,
    fields: { ...state.currentFields, wiki_evidence_hash: to },
    touchedFields: ['wiki_evidence_hash'],
    body: state.body,
    raw_field_texts: state.rawFieldTexts,
    canonicalizeLinks: false,
    expectedVersion: row.version,
    ...(row.content_hash === null ? {} : { expectedDiskContentHash: row.content_hash }),
  }, deps.syncLogger);
  const version = (deps.db.prepare('SELECT version FROM nodes WHERE id = ?').get(homeId) as { version: number }).version;
  if (version !== row.version) recordStatusOnlyWrite(deps.db, homeId, row.version, version);
  return true;
}

export interface WikiStatusWrite {
  /** The status the home had before. */
  readonly previous: WikiStatus | null;
  /** The status it has now. */
  readonly status: WikiStatus | null;
  /** Its version now. */
  readonly version: number;
  readonly written: boolean;
}

/**
 * Write `status` as the home's `wiki_status`, through the pipeline, unless it already reads
 * that (or, with `onlyFrom`, reads anything else). Links in the page are left as written.
 * The write must find the file as the Engine last read or wrote it, so an edit Obsidian has
 * saved but the watcher has not read yet is never overwritten: that throws the pipeline's
 * `ContentHashMismatchError`. Null when the node is gone.
 */
export function setWikiHomeStatus(
  deps: WikiStatusDeps,
  homeId: string,
  status: WikiStatus,
  options: { onlyFrom?: WikiStatus } = {},
): WikiStatusWrite | null {
  const state = loadNodeState(deps.db, homeId);
  const row = deps.db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(homeId) as
    | { version: number; content_hash: string | null }
    | undefined;
  if (!state || !row) return null;
  const stored = state.currentFields.wiki_status;
  const previous = isWikiStatus(stored) ? stored : null;
  if (previous === status || (options.onlyFrom !== undefined && previous !== options.onlyFrom)) {
    return { previous, status: previous, version: row.version, written: false };
  }
  executeMutation(deps.db, deps.writeLock, deps.vaultPath, {
    source: 'tool',
    node_id: homeId,
    file_path: state.file_path,
    title: state.title,
    types: state.types,
    fields: { ...state.currentFields, wiki_status: status },
    touchedFields: ['wiki_status'],
    body: state.body,
    raw_field_texts: state.rawFieldTexts,
    canonicalizeLinks: false,
    expectedVersion: row.version,
    ...(row.content_hash === null ? {} : { expectedDiskContentHash: row.content_hash }),
  }, deps.syncLogger);
  try {
    deps.embeddingIndexer?.enqueue({ node_id: homeId, source_type: 'node' });
  } catch (err) {
    console.warn(`[wiki-status] could not queue ${state.file_path} for embedding: ${message(err)}`);
  }
  const version = (deps.db.prepare('SELECT version FROM nodes WHERE id = ?').get(homeId) as { version: number }).version;
  recordStatusOnlyWrite(deps.db, homeId, row.version, version);
  return { previous, status, version, written: true };
}

/**
 * What a check depends on: any node written or removed, and the wiki's calendar day
 * (meetings and tasks move between buckets as days pass).
 */
function vaultSignature(db: Database.Database): string {
  const row = db.prepare('SELECT COUNT(*) AS count, MAX(indexed_at) AS latest FROM nodes').get() as
    { count: number; latest: number | null };
  return `${row.count}:${row.latest ?? ''}:${calendarDate(Date.now(), wikiTimeZone(db))}`;
}

export interface WikiStatusChecks {
  /** Check now if anything changed since the last check. */
  tick(): WikiStatusChange[];
  stop(): void;
}

/**
 * Check at once, then every few seconds whenever the vault has changed since the last
 * check. Best-effort: a failed check is logged and the next change tries again.
 */
export function startWikiStatusChecks(
  deps: WikiStatusDeps,
  options: { everyMs?: number; log?: (line: string) => void } = {},
): WikiStatusChecks {
  const log = options.log ?? ((line: string) => console.log(line));
  let lastSignature: string | null = null;
  const tick = (): WikiStatusChange[] => {
    try {
      const signature = vaultSignature(deps.db);
      if (signature === lastSignature) return [];
      const changes = checkWikiStatuses(deps);
      // After the check's own writes, so they don't start another one.
      lastSignature = vaultSignature(deps.db);
      for (const change of changes) {
        log(`[wiki-status] ${change.home_id}: ${change.from} -> ${change.to}`);
      }
      return changes;
    } catch (err) {
      console.warn(`[wiki-status] check failed: ${message(err)}`);
      return [];
    }
  };
  tick();
  const timer = setInterval(tick, options.everyMs ?? WIKI_STATUS_CHECK_EVERY_MS);
  timer.unref?.();
  return {
    tick,
    stop: () => clearInterval(timer),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

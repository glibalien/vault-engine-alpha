import { parseTopicSelection, type TopicCommittedSelection } from '../topic-selection-state.js';
import type Database from 'better-sqlite3';
import type { TopicWebMaterialityAssessment } from '../topic-refresh-assessment.js';
import {
  buildCanonicalWebProbe,
  CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP,
  TOPIC_VAULT_SOURCE_EVIDENCE_VERSION,
  TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP,
  type CanonicalWebProbe,
} from '../topic-refresh-evidence.js';

const MAX_EXPLICIT_SOURCES = 20;
const MAX_OBSERVED_SOURCES = 50;
const MAX_CHANGED_URLS = 20;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type TopicRefreshSourceKind = 'explicit' | 'observed';

export interface TopicRefreshSourceRow {
  root_title: string;
  node_id: string;
  source_kind: TopicRefreshSourceKind;
  title_at_commit: string | null;
  evidence_state: 'present' | 'missing' | null;
  body_included: 0 | 1 | null;
  fingerprint_version: number | null;
  evidence_hash: string | null;
  captured_at: string | null;
  freshness_version?: number | null;
  freshness_hash?: string | null;
  selection_json?: string | null;
}

export interface TopicRefreshStateRow {
  root_title: string;
  pending_source_change: 0 | 1;
  pending_baseline_retry: 0 | 1;
  source_committed_at: string | null;
  committed_web_hash: string | null;
  committed_web_snapshot_json: string | null;
  web_committed_at: string | null;
  last_probe_hash: string | null;
  last_probe_snapshot_json: string | null;
  last_probe_verdict: 'material' | 'immaterial' | 'uncertain' | null;
  last_probe_reason_code: TopicWebMaterialityAssessment['reasonCode'] | null;
  last_probe_changed_urls_json: string | null;
  last_probe_assessed_at: string | null;
}

export interface TopicCommittedSourceProjection {
  nodeId: string;
  titleAtCommit: string | null;
  evidenceState: 'present' | 'missing';
  bodyIncluded: 0 | 1;
  fingerprintVersion: number;
  evidenceHash: string;
  capturedAt: string;
  selection?: TopicCommittedSelection;
}

export interface TopicProbeCacheInput {
  rootTitle: string;
  probe: CanonicalWebProbe;
  assessment: TopicWebMaterialityAssessment;
  assessedAt: string;
}

export interface TopicRefreshCommitInput {
  rootTitle: string;
  sourceProjections: readonly TopicCommittedSourceProjection[];
  observedSourceNodeIds: readonly string[];
  sourceCommittedAt: string;
  webProbe?: CanonicalWebProbe;
  webCommittedAt?: string;
}

/** DDL owned by Curator migration 14. */
export function createTopicRefreshTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE topic_refresh_sources (
      root_title          TEXT NOT NULL,
      node_id             TEXT NOT NULL,
      source_kind         TEXT NOT NULL
                          CHECK (source_kind IN ('explicit', 'observed')),
      title_at_commit      TEXT,
      evidence_state      TEXT CHECK (evidence_state IN ('present', 'missing')),
      body_included       INTEGER CHECK (body_included IN (0, 1)),
      fingerprint_version INTEGER,
      evidence_hash       TEXT,
      captured_at         TEXT,
      PRIMARY KEY (root_title, node_id, source_kind)
    );

    CREATE INDEX idx_topic_refresh_sources_root_kind
      ON topic_refresh_sources(root_title, source_kind);

    CREATE TABLE topic_refresh_state (
      root_title                  TEXT PRIMARY KEY,
      pending_source_change       INTEGER NOT NULL DEFAULT 0
                                  CHECK (pending_source_change IN (0, 1)),
      pending_baseline_retry      INTEGER NOT NULL DEFAULT 0
                                  CHECK (pending_baseline_retry IN (0, 1)),
      source_committed_at         TEXT,
      committed_web_hash          TEXT,
      committed_web_snapshot_json TEXT,
      web_committed_at            TEXT,
      last_probe_hash             TEXT,
      last_probe_snapshot_json    TEXT,
      last_probe_verdict          TEXT,
      last_probe_reason_code      TEXT,
      last_probe_changed_urls_json TEXT,
      last_probe_assessed_at      TEXT
    );
  `);
}

export function explicitTopicRefreshSources(
  db: Database.Database,
  rootTitle: string,
): TopicRefreshSourceRow[] {
  return topicRefreshSources(db, rootTitle, 'explicit');
}

export function observedTopicRefreshSources(
  db: Database.Database,
  rootTitle: string,
): TopicRefreshSourceRow[] {
  return topicRefreshSources(db, rootTitle, 'observed');
}

function topicRefreshSources(
  db: Database.Database,
  rootTitle: string,
  sourceKind: TopicRefreshSourceKind,
): TopicRefreshSourceRow[] {
  return db.prepare(`
    SELECT root_title, node_id, source_kind, title_at_commit, evidence_state,
      body_included, fingerprint_version, evidence_hash, captured_at, freshness_version, freshness_hash, selection_json
    FROM topic_refresh_sources
    WHERE root_title = ? AND source_kind = ?
    ORDER BY rowid
  `).all(rootTitle, sourceKind) as TopicRefreshSourceRow[];
}

export function replaceExplicitTopicRefreshSources(
  db: Database.Database,
  rootTitle: string,
  nodeIds: readonly string[],
): { changed: boolean } {
  validateRootTitle(rootTitle);
  const normalized = normalizedNodeIds(nodeIds, MAX_EXPLICIT_SOURCES, 'explicit sources');
  const current = explicitTopicRefreshSources(db, rootTitle).map(row => row.node_id);
  const requested = new Set(normalized);
  const currentSet = new Set(current);
  const changed = requested.size !== currentSet.size
    || normalized.some(nodeId => !currentSet.has(nodeId));
  if (!changed) return { changed: false };

  const write = db.transaction(() => {
    const remove = db.prepare(`
      DELETE FROM topic_refresh_sources
      WHERE root_title = ? AND source_kind = 'explicit' AND node_id = ?
    `);
    for (const nodeId of current) {
      if (!requested.has(nodeId)) remove.run(rootTitle, nodeId);
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO topic_refresh_sources (root_title, node_id, source_kind)
      VALUES (?, ?, 'explicit')
    `);
    for (const nodeId of normalized) insert.run(rootTitle, nodeId);
    ensureState(db, rootTitle);
    db.prepare(`
      UPDATE topic_refresh_state SET pending_source_change = 1 WHERE root_title = ?
    `).run(rootTitle);
  });
  write();
  return { changed: true };
}

export function topicRefreshState(
  db: Database.Database,
  rootTitle: string,
): TopicRefreshStateRow | undefined {
  return db.prepare(`
    SELECT root_title, pending_source_change, pending_baseline_retry, source_committed_at,
      committed_web_hash, committed_web_snapshot_json, web_committed_at,
      last_probe_hash, last_probe_snapshot_json, last_probe_verdict,
      last_probe_reason_code, last_probe_changed_urls_json, last_probe_assessed_at
    FROM topic_refresh_state WHERE root_title = ?
  `).get(rootTitle) as TopicRefreshStateRow | undefined;
}

export function armTopicRefreshBaselineRetry(
  db: Database.Database,
  rootTitle: string,
): void {
  validateRootTitle(rootTitle);
  if (topicRefreshState(db, rootTitle)?.pending_baseline_retry === 1) return;
  const write = db.transaction(() => {
    ensureState(db, rootTitle);
    db.prepare(`
      UPDATE topic_refresh_state SET pending_baseline_retry = 1 WHERE root_title = ?
    `).run(rootTitle);
  });
  write();
}

export function storeTopicProbeCache(
  db: Database.Database,
  input: TopicProbeCacheInput,
): void {
  validateRootTitle(input?.rootTitle);
  const currentProbe = validateProbe(input?.probe, 'last probe');
  const assessment = validateAssessment(input?.assessment);
  validateTimestamp(input?.assessedAt, 'last probe assessed timestamp');
  const state = topicRefreshState(db, input.rootTitle);
  const allowedUrls = new Set(currentProbe.results.map(result => result.url));
  if (state?.committed_web_snapshot_json !== null
    && state?.committed_web_snapshot_json !== undefined) {
    for (const url of urlsFromSnapshot(state.committed_web_snapshot_json, 'committed web snapshot')) {
      allowedUrls.add(url);
    }
  }
  if (assessment.changedUrls.some(url => !allowedUrls.has(url))) {
    throw new Error('probe changed URL must belong to the committed or current snapshot');
  }
  const changedUrlsJson = JSON.stringify(assessment.changedUrls);

  const write = db.transaction(() => {
    ensureState(db, input.rootTitle);
    db.prepare(`
      UPDATE topic_refresh_state SET
        last_probe_hash = ?,
        last_probe_snapshot_json = ?,
        last_probe_verdict = ?,
        last_probe_reason_code = ?,
        last_probe_changed_urls_json = ?,
        last_probe_assessed_at = ?
      WHERE root_title = ?
    `).run(
      currentProbe.hash,
      currentProbe.snapshotJson,
      assessment.verdict,
      assessment.reasonCode,
      changedUrlsJson,
      input.assessedAt,
      input.rootTitle,
    );
  });
  write();
}

export function commitTopicRefreshBaseline(
  db: Database.Database,
  input: TopicRefreshCommitInput,
): void {
  validateRootTitle(input?.rootTitle);
  validateTimestamp(input?.sourceCommittedAt, 'source committed timestamp');
  if (!Array.isArray(input?.sourceProjections)) {
    throw new TypeError('source projections must be an array');
  }
  const projections = normalizedProjections(input.sourceProjections);
  const observedIds = normalizedNodeIds(
    input?.observedSourceNodeIds,
    MAX_OBSERVED_SOURCES,
    'observed sources',
  );
  for (const nodeId of observedIds) {
    if (!projections.has(nodeId)) {
      throw new Error(`observed source ${nodeId} has no committed projection`);
    }
  }
  const hasProbe = input.webProbe !== undefined;
  const hasWebTimestamp = input.webCommittedAt !== undefined;
  if (hasProbe !== hasWebTimestamp) {
    throw new Error('committed web probe and timestamp must be both omitted or both set');
  }
  const webProbe = hasProbe ? validateProbe(input.webProbe, 'committed web') : undefined;
  if (hasWebTimestamp) validateTimestamp(input.webCommittedAt, 'web committed timestamp');

  const write = db.transaction(() => {
    const explicit = explicitTopicRefreshSources(db, input.rootTitle);
    const update = db.prepare(`
      UPDATE topic_refresh_sources SET
        title_at_commit = @title_at_commit,
        evidence_state = @evidence_state,
        body_included = @body_included,
        fingerprint_version = @fingerprint_version,
        evidence_hash = @evidence_hash,
        captured_at = @captured_at,
        freshness_version = @freshness_version, freshness_hash = @freshness_hash, selection_json = @selection_json
      WHERE root_title = @root_title AND node_id = @node_id AND source_kind = @source_kind
    `);
    for (const row of explicit) {
      const projection = projections.get(row.node_id);
      if (projection !== undefined) update.run(sourceParams(input.rootTitle, 'explicit', projection));
    }

    db.prepare(`
      DELETE FROM topic_refresh_sources WHERE root_title = ? AND source_kind = 'observed'
    `).run(input.rootTitle);
    const insertObserved = db.prepare(`
      INSERT INTO topic_refresh_sources (
        root_title, node_id, source_kind, title_at_commit, evidence_state,
        body_included, fingerprint_version, evidence_hash, captured_at, freshness_version, freshness_hash, selection_json
      ) VALUES (
        @root_title, @node_id, @source_kind, @title_at_commit, @evidence_state,
        @body_included, @fingerprint_version, @evidence_hash, @captured_at, @freshness_version, @freshness_hash, @selection_json
      )
    `);
    for (const nodeId of observedIds) {
      insertObserved.run(sourceParams(input.rootTitle, 'observed', projections.get(nodeId)!));
    }

    ensureState(db, input.rootTitle);
    if (webProbe === undefined) {
      db.prepare(`
        UPDATE topic_refresh_state SET
          pending_source_change = 0,
          pending_baseline_retry = 0,
          source_committed_at = ?
        WHERE root_title = ?
      `).run(input.sourceCommittedAt, input.rootTitle);
    } else {
      db.prepare(`
        UPDATE topic_refresh_state SET
          pending_source_change = 0,
          pending_baseline_retry = 0,
          source_committed_at = ?,
          committed_web_hash = ?,
          committed_web_snapshot_json = ?,
          web_committed_at = ?,
          last_probe_hash = NULL,
          last_probe_snapshot_json = NULL,
          last_probe_verdict = NULL,
          last_probe_reason_code = NULL,
          last_probe_changed_urls_json = NULL,
          last_probe_assessed_at = NULL
        WHERE root_title = ?
      `).run(
        input.sourceCommittedAt,
        webProbe.hash,
        webProbe.snapshotJson,
        input.webCommittedAt,
        input.rootTitle,
      );
    }
  });
  write();
}

export function deleteTopicRefreshState(
  db: Database.Database,
  rootTitle: string,
): { sources: number; state: number } {
  validateRootTitle(rootTitle);
  const write = db.transaction(() => {
    const sources = db.prepare('DELETE FROM topic_refresh_sources WHERE root_title = ?')
      .run(rootTitle).changes;
    const state = db.prepare('DELETE FROM topic_refresh_state WHERE root_title = ?')
      .run(rootTitle).changes;
    return { sources, state };
  });
  return write();
}

function ensureState(db: Database.Database, rootTitle: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO topic_refresh_state (root_title, pending_source_change)
    VALUES (?, 0)
  `).run(rootTitle);
}

function normalizedNodeIds(
  value: readonly string[] | undefined,
  max: number,
  label: string,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const nodeId of value) {
    validateNodeId(nodeId);
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);
  }
  if (result.length > max) throw new Error(`${label} may contain at most ${max} unique node IDs`);
  return result;
}

function normalizedProjections(
  values: readonly TopicCommittedSourceProjection[],
): Map<string, TopicCommittedSourceProjection> {
  const result = new Map<string, TopicCommittedSourceProjection>();
  for (const value of values) {
    validateProjection(value);
    const existing = result.get(value.nodeId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(`conflicting projections for source ${value.nodeId}`);
    }
    result.set(value.nodeId, value);
  }
  return result;
}

function validateProjection(value: TopicCommittedSourceProjection): void {
  if (value === null || typeof value !== 'object') throw new TypeError('source projection must be an object');
  validateNodeId(value.nodeId);
  if (value.evidenceState !== 'present' && value.evidenceState !== 'missing') {
    throw new Error('source evidence state must be present or missing');
  }
  if (value.bodyIncluded !== 0 && value.bodyIncluded !== 1) {
    throw new Error('source body flag must be 0 or 1');
  }
  if (value.fingerprintVersion !== TOPIC_VAULT_SOURCE_EVIDENCE_VERSION) {
    throw new Error('unsupported source fingerprint version');
  }
  if (value.selection !== undefined) parseTopicSelection(JSON.stringify(value.selection));
  validateHash(value.evidenceHash, 'source evidence hash');
  validateTimestamp(value.capturedAt, 'source captured timestamp');
  if (value.evidenceState === 'present') {
    validateBoundedTitle(value.titleAtCommit, 'source title');
  } else if (value.titleAtCommit !== null || value.bodyIncluded !== 0) {
    throw new Error('missing source projection requires a null title and body flag 0');
  }
}

function sourceParams(
  rootTitle: string,
  sourceKind: TopicRefreshSourceKind,
  projection: TopicCommittedSourceProjection,
): Record<string, unknown> {
  return {
    root_title: rootTitle,
    node_id: projection.nodeId,
    source_kind: sourceKind,
    title_at_commit: projection.titleAtCommit,
    evidence_state: projection.evidenceState,
    body_included: projection.bodyIncluded,
    fingerprint_version: projection.fingerprintVersion,
    evidence_hash: projection.evidenceHash,
    captured_at: projection.capturedAt,
    freshness_version: projection.selection?.freshnessVersion ?? null,
    freshness_hash: projection.selection?.freshnessHash ?? null,
    selection_json: projection.selection ? JSON.stringify(projection.selection) : null,
  };
}

function validateAssessment(
  value: TopicWebMaterialityAssessment | undefined,
): TopicWebMaterialityAssessment {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('probe assessment must be an object');
  }
  const verdicts = new Set(['material', 'immaterial', 'uncertain']);
  const reasons = new Set([
    'new_development', 'changed_fact', 'time_sensitive_update',
    'restatement', 'ranking_or_source_churn', 'insufficient_evidence',
  ]);
  if (!verdicts.has(value.verdict)) throw new Error('invalid probe verdict');
  if (!reasons.has(value.reasonCode)) throw new Error('invalid probe reason code');
  if (!Array.isArray(value.changedUrls)
    || value.changedUrls.some(url => typeof url !== 'string')) {
    throw new Error('probe changed URLs must be a string array');
  }
  const changedUrls = [...new Set(value.changedUrls)];
  if (changedUrls.length !== value.changedUrls.length) {
    throw new Error('probe changed URLs must be unique');
  }
  if (changedUrls.length > MAX_CHANGED_URLS) {
    throw new Error(`probe changed URLs may contain at most ${MAX_CHANGED_URLS} URLs`);
  }
  return { verdict: value.verdict, reasonCode: value.reasonCode, changedUrls };
}

function validateProbe(value: CanonicalWebProbe | undefined, label: string): CanonicalWebProbe {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} must be complete`);
  if (value.version !== 1) throw new Error(`${label} has an unsupported version`);
  validateHash(value.hash, `${label} hash`);
  if (typeof value.snapshotJson !== 'string'
    || value.snapshotJson.length > CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP) {
    throw new Error(`${label} snapshot exceeds ${CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP} characters`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.snapshotJson);
  } catch {
    throw new Error(`${label} snapshot must be valid JSON`);
  }
  if (!isCanonicalSnapshot(parsed)) throw new Error(`${label} snapshot has an invalid fixed shape`);
  const rebuilt = buildCanonicalWebProbe(parsed.results);
  if (!rebuilt.ok
    || rebuilt.probe.snapshotJson !== value.snapshotJson
    || rebuilt.probe.hash !== value.hash
    || JSON.stringify(rebuilt.probe.results) !== JSON.stringify(value.results)) {
    throw new Error(`${label} snapshot or digest is not canonical`);
  }
  return value;
}

function isCanonicalSnapshot(value: unknown): value is {
  version: 1;
  results: Array<{ url: string; title: string; snippet: string; published: string | null }>;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'results,version'
    || record['version'] !== 1
    || !Array.isArray(record['results'])) return false;
  return record['results'].every((result) => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
    const item = result as Record<string, unknown>;
    return Object.keys(item).sort().join(',') === 'published,snippet,title,url'
      && typeof item['url'] === 'string'
      && typeof item['title'] === 'string'
      && typeof item['snippet'] === 'string'
      && (typeof item['published'] === 'string' || item['published'] === null);
  });
}

function urlsFromSnapshot(snapshotJson: string, label: string): string[] {
  if (snapshotJson.length > CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP) {
    throw new Error(`${label} exceeds ${CANONICAL_WEB_PROBE_SNAPSHOT_CHAR_CAP} characters`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!isCanonicalSnapshot(parsed)) throw new Error(`${label} has an invalid fixed shape`);
  return parsed.results.map(result => result.url);
}

function validateHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
}

function validateTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be a valid UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a valid UTC timestamp`);
  }
}

function validateNodeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('source node ID must be a non-empty string');
  }
}

function validateRootTitle(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('root title must be a non-empty string');
  }
}

function validateBoundedTitle(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP) {
    throw new Error(`${label} exceeds ${TOPIC_VAULT_SOURCE_TITLE_CHAR_CAP} characters`);
  }
}

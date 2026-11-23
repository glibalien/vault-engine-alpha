import type { TopicEvidenceDiagnostics } from '../topic-evidence-diagnostics.js';
import type Database from 'better-sqlite3';
import { ZERO_USAGE } from '../pricing.js';
import type {
  CurateResult,
  PlanningActionAudit,
  PlanningAttemptTopologyAudit,
  TopologyResult,
  WikiScopeV1,
} from '../types.js';
import type { RequestedPageOutcome } from '../curate.js';
import type { TopicRefreshAdmissionWarning, TopicRefreshTrigger } from '../topic-refresh-admission.js';
import type { TopicWebMaterialityAssessment } from '../topic-refresh-assessment.js';

const MAX_PLANNING_ATTEMPTS = 6;
const MAX_AUDIT_ITEMS = 100;
const MAX_AUDIT_STRING_BYTES = 300;
const MAX_TOPOLOGY_JSON_BYTES = 65_536;
const MAX_REFRESH_EVIDENCE_CHARS = 32_000;
const MAX_CHANGED_SOURCE_NODE_IDS = 70;
const MAX_REFRESH_WARNINGS = 8;
const MAX_CHANGED_URLS = 20;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type RunTrigger = 'scheduled' | 'on-demand' | 'cli';

/** One row of the curator's run history. `id` is present on reads only. */
export interface RunRow {
  id: number;
  ts: string;
  project: string;
  trigger: RunTrigger;
  dry_run: number;
  outcome: string;
  evidence_hash: string | null;
  wiki_curated_at: string | null;
  home_written: number;
  spine_written: number;
  spine_total: number;
  themed_created: number;
  themed_retired: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number | null;
  duration_ms: number;
  error: string | null;
  topology_json: string | null;
  refresh_trigger: TopicRefreshTrigger | null;
  refresh_evidence_json: string | null;
  /** The wiki output policy this run used; null when it stopped before resolving one. */
  output_policy_hash: string | null;
}

export type RunRowInsert = Omit<RunRow, 'id' | 'output_policy_hash'> & { output_policy_hash?: string | null };

/** DDL for the run-history table. Called by migration #1, not on every boot. */
export function createRunsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL,
      project         TEXT    NOT NULL,
      "trigger"       TEXT    NOT NULL,
      dry_run         INTEGER NOT NULL,
      outcome         TEXT    NOT NULL,
      evidence_hash   TEXT,
      wiki_curated_at TEXT,
      home_written    INTEGER NOT NULL,
      spine_written   INTEGER NOT NULL,
      spine_total     INTEGER NOT NULL,
      themed_created  INTEGER NOT NULL,
      themed_retired  INTEGER NOT NULL,
      input_tokens    INTEGER NOT NULL,
      output_tokens   INTEGER NOT NULL,
      cache_read      INTEGER NOT NULL,
      cache_write     INTEGER NOT NULL,
      cost_usd        REAL,
      duration_ms     INTEGER NOT NULL,
      error           TEXT,
      topology_json   TEXT,
      refresh_trigger TEXT,
      refresh_evidence_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);
    CREATE INDEX IF NOT EXISTS idx_runs_project_ts ON runs(project, ts);
  `);
}

export interface RunContext {
  trigger: RunTrigger;
  durationMs: number;
  ts: string;
  /** Internal-only web baseline evidence; never added to public CurateResult. */
  refreshEvidence?: {
    committedWebHash?: string;
    currentWebHash?: string;
  };
}

/**
 * Pure mapper: project a (never-throwing) CurateResult plus the invocation's
 * extrinsic facts (trigger/duration/ts) into an insertable run row. `outcome`
 * 'skipped' is recorded as 'skipped_unchanged' for self-documentation.
 */
export function curateResultToRunRow(result: CurateResult, ctx: RunContext): RunRowInsert {
  const usage = result.usage ?? ZERO_USAGE;
  const topology = result.topology ?? [];
  const themedCreated = topology.length > 0
    ? topology.filter(item => item.action === 'created' || item.action === 'refreshed' || item.action === 'reactivated').length
    : (result.themed ?? []).filter(item => item.action === 'created' || item.action === 'updated').length;
  const themedRetired = topology.length > 0
    ? topology.filter(item => item.action === 'dormant' || item.action === 'retired' || item.action === 'merged-source').length
    : (result.themed ?? []).filter(item => item.action === 'retired' || item.action === 'dormant').length;
  const outcome = result.outcome === 'skipped' ? 'skipped_unchanged' : result.outcome;
  const topologyJson = topology.length === 0 && result.topologyAudit === undefined
    ? null
    : serializeTopologyJson({
      actions: topology.slice(0, 100).map(projectTopology),
      adjudication: (result.topologyAudit?.adjudicationVerdicts ?? []).slice(0, 100).map(verdict => ({
        candidate_plan_key: verdict.candidate_plan_key.slice(0, 200), compared_to: verdict.compared_to,
        relation: verdict.relation, confidence: verdict.confidence,
      })),
      validation_issue_codes: (result.topologyAudit?.validationIssueCodes ?? []).slice(0, 100).map(code => code.slice(0, 100)),
      post_topology_hash: result.topologyHash ?? null,
      reconcile_key: result.topologyAudit?.reconcileKey?.slice(0, 300) ?? null,
      ...(result.topologyAudit?.provenanceReceipt ? { provenance: {
        derivation_id: result.topologyAudit.provenanceReceipt.derivation_id.slice(0, 100),
        output_revision_id: result.topologyAudit.provenanceReceipt.output_revision_id.slice(0, 100),
      } } : {}),
      warnings: (result.topologyAudit?.warnings ?? []).slice(0, 50).map(warning => warning.slice(0, 500)),
      compatibility: { themed_created: themedCreated, themed_retired: themedRetired },
    }, result.topologyAudit?.planningAttempts);
  const refreshTrigger = closedRefreshTrigger(result.refreshTrigger);
  const refreshEvidenceJson = serializeRefreshEvidence(result, ctx.refreshEvidence);
  return {
    ts: ctx.ts,
    project: result.project,
    trigger: ctx.trigger,
    dry_run: result.dryRun ? 1 : 0,
    outcome,
    evidence_hash: result.evidenceHash ?? null,
    wiki_curated_at: result.wikiCuratedAt ?? null,
    home_written: result.outcome === 'written' ? 1 : 0,
    spine_written: 0,
    spine_total: 0,
    themed_created: themedCreated,
    themed_retired: themedRetired,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    cost_usd: result.costUsd ?? null,
    duration_ms: ctx.durationMs,
    error: result.outcome === 'error' ? (result.detail ?? null) : null,
    topology_json: topologyJson,
    refresh_trigger: refreshTrigger,
    refresh_evidence_json: refreshEvidenceJson,
    output_policy_hash: result.outputPolicyHash ?? null,
  };
}

interface ProjectedRefreshEvidence {
  evidence_selection?: TopicEvidenceDiagnostics;
  committed_web_hash?: string;
  current_web_hash?: string;
  changed_source_node_ids?: string[];
  warnings?: TopicRefreshAdmissionWarning[];
  web_assessment?: {
    verdict: TopicWebMaterialityAssessment['verdict'];
    reason_code: TopicWebMaterialityAssessment['reasonCode'];
    changed_urls: string[];
  };
  truncated?: true;
}

function serializeRefreshEvidence(
  result: CurateResult,
  privateEvidence: RunContext['refreshEvidence'],
): string | null {
  const committedWebHash = closedSha256(privateEvidence?.committedWebHash);
  const currentWebHash = closedSha256(privateEvidence?.currentWebHash);
  const hasRefreshFields = result.evidenceSelection !== undefined || result.refreshTrigger !== undefined
    || result.changedSourceNodeIds !== undefined
    || result.webAssessment !== undefined
    || result.refreshWarnings !== undefined
    || committedWebHash !== null
    || currentWebHash !== null;
  if (!hasRefreshFields) return null;

  let truncated = false;
  const rawIds = safeUnknownArray(result.changedSourceNodeIds);
  const changedSourceNodeIds = rawIds.filter((value): value is string => typeof value === 'string');
  if (changedSourceNodeIds.length > MAX_CHANGED_SOURCE_NODE_IDS) truncated = true;
  changedSourceNodeIds.splice(MAX_CHANGED_SOURCE_NODE_IDS);

  const rawWarnings = safeUnknownArray(result.refreshWarnings);
  const warnings = rawWarnings.map(closedRefreshWarning).filter((value): value is TopicRefreshAdmissionWarning => value !== null);
  if (warnings.length > MAX_REFRESH_WARNINGS) truncated = true;
  warnings.splice(MAX_REFRESH_WARNINGS);

  const webAssessment = projectWebAssessment(result.webAssessment);
  if (webAssessment?.truncated === true) truncated = true;
  const evidence: ProjectedRefreshEvidence = {
    ...(result.evidenceSelection ? { evidence_selection: { ...result.evidenceSelection, calls: [...result.evidenceSelection.calls] } } : {}),
    ...(committedWebHash === null ? {} : { committed_web_hash: committedWebHash }),
    ...(currentWebHash === null ? {} : { current_web_hash: currentWebHash }),
    ...(result.changedSourceNodeIds === undefined ? {} : { changed_source_node_ids: changedSourceNodeIds }),
    ...(result.refreshWarnings === undefined ? {} : { warnings }),
    ...(webAssessment === null ? {} : {
      web_assessment: {
        verdict: webAssessment.verdict,
        reason_code: webAssessment.reasonCode,
        changed_urls: webAssessment.changedUrls,
      },
    }),
    ...(truncated ? { truncated: true } : {}),
  };

  let serialized = JSON.stringify(evidence);
  if (serialized.length <= MAX_REFRESH_EVIDENCE_CHARS) return serialized;
  evidence.truncated = true;
  const removable = [
    evidence.changed_source_node_ids,
    evidence.web_assessment?.changed_urls,
    evidence.warnings,
  ];
  for (const values of removable) {
    while (values !== undefined && values.length > 0 && serialized.length > MAX_REFRESH_EVIDENCE_CHARS) {
      values.pop();
      serialized = JSON.stringify(evidence);
    }
  }
  while (serialized.length > MAX_REFRESH_EVIDENCE_CHARS && evidence.evidence_selection?.calls.length) {
    evidence.evidence_selection.calls.pop(); evidence.evidence_selection.omittedCallCount++;
    serialized = JSON.stringify(evidence);
  }
  return serialized;
}

function closedSha256(value: unknown): string | null {
  return typeof value === 'string' && SHA256_HEX.test(value) ? value : null;
}

function safeUnknownArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  try {
    return Array.from(value as unknown[]);
  } catch {
    return [];
  }
}

function projectWebAssessment(value: unknown): (TopicWebMaterialityAssessment & { truncated?: true }) | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const record = value as Record<string, unknown>;
    const verdict = closedAssessmentVerdict(record['verdict']);
    const reasonCode = closedAssessmentReason(record['reasonCode']);
    if (verdict === null || reasonCode === null || !assessmentPairIsValid(verdict, reasonCode)) return null;
    const rawUrls = safeUnknownArray(record['changedUrls']);
    const changedUrls = rawUrls.filter((url): url is string => typeof url === 'string');
    const truncated = changedUrls.length > MAX_CHANGED_URLS;
    changedUrls.splice(MAX_CHANGED_URLS);
    if (verdict === 'material' && changedUrls.length === 0) return null;
    return { verdict, reasonCode, changedUrls, ...(truncated ? { truncated: true } : {}) };
  } catch {
    return null;
  }
}

function assessmentPairIsValid(
  verdict: TopicWebMaterialityAssessment['verdict'],
  reason: TopicWebMaterialityAssessment['reasonCode'],
): boolean {
  switch (verdict) {
    case 'material':
      return reason === 'new_development' || reason === 'changed_fact' || reason === 'time_sensitive_update';
    case 'immaterial':
      return reason === 'restatement' || reason === 'ranking_or_source_churn';
    case 'uncertain':
      return reason === 'insufficient_evidence';
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function closedRefreshTrigger(value: unknown): TopicRefreshTrigger | null {
  switch (value) {
    case 'manual_request': case 'manual_force': case 'cadence_due':
    case 'baseline_retry': case 'vault_source_changed': case 'web_material_change': case 'not_due':
      return value;
    default: return null;
  }
}

function closedRefreshWarning(value: unknown): TopicRefreshAdmissionWarning | null {
  switch (value) {
    case 'source_baseline_not_ready': case 'source_read_unavailable':
    case 'web_baseline_not_ready': case 'web_probe_unavailable':
    case 'web_probe_overflow': case 'assessment_cap_exhausted':
    case 'assessment_failed': case 'refresh_state_persist_failed':
      return value;
    default: return null;
  }
}

function closedAssessmentVerdict(value: unknown): TopicWebMaterialityAssessment['verdict'] | null {
  switch (value) {
    case 'material': case 'immaterial': case 'uncertain': return value;
    default: return null;
  }
}

function closedAssessmentReason(value: unknown): TopicWebMaterialityAssessment['reasonCode'] | null {
  switch (value) {
    case 'new_development': case 'changed_fact': case 'time_sensitive_update':
    case 'restatement': case 'ranking_or_source_churn': case 'insufficient_evidence':
      return value;
    default: return null;
  }
}

type LegacyTopologyAudit = {
  readonly provenance?: { readonly derivation_id: string; readonly output_revision_id: string };
  readonly actions: readonly Record<string, unknown>[];
  readonly adjudication: readonly Record<string, unknown>[];
  readonly validation_issue_codes: readonly string[];
  readonly post_topology_hash: string | null;
  readonly reconcile_key: string | null;
  readonly warnings: readonly string[];
  readonly compatibility: { readonly themed_created: number; readonly themed_retired: number };
};

type ProjectedPlanningAttempt = {
  phase: string;
  attempt: number;
  plan: { reviewed_page_ids: string[]; actions: Array<Record<string, unknown>> };
  issues: Array<Record<string, unknown>>;
};

type TruncationState = { truncated: boolean };

function serializeTopologyJson(
  legacy: LegacyTopologyAudit,
  planningAttempts: readonly PlanningAttemptTopologyAudit[] | undefined,
): string {
  if (planningAttempts === undefined || planningAttempts.length === 0) return JSON.stringify(legacy);

  const legacyWithTruncationFlag = JSON.stringify({ ...legacy, planning_attempts_truncated: true });
  if (utf8Bytes(legacyWithTruncationFlag) > MAX_TOPOLOGY_JSON_BYTES) {
    return legacyWithTruncationFlag;
  }

  const state: TruncationState = { truncated: false };
  const attempts = projectPlanningAttempts(planningAttempts, state);
  let serialized = serializeWithAttempts(legacy, attempts, state.truncated);
  if (utf8Bytes(serialized) <= MAX_TOPOLOGY_JSON_BYTES) return serialized;

  state.truncated = true;
  serialized = serializeWithAttempts(legacy, attempts, true);
  let serializedBytes = utf8Bytes(serialized);
  for (const items of [
    (attempt: ProjectedPlanningAttempt) => attempt.issues,
    (attempt: ProjectedPlanningAttempt) => attempt.plan.actions,
    (attempt: ProjectedPlanningAttempt) => attempt.plan.reviewed_page_ids,
  ]) {
    while (serializedBytes > MAX_TOPOLOGY_JSON_BYTES) {
      const removedBytes = popTailItemBytes(attempts, items);
      if (removedBytes === null) break;
      serializedBytes -= removedBytes;
    }
  }
  serialized = serializeWithAttempts(legacy, attempts, true);
  while (utf8Bytes(serialized) > MAX_TOPOLOGY_JSON_BYTES && removeOldestRepairAttempt(attempts)) {
    serialized = serializeWithAttempts(legacy, attempts, true);
  }
  if (utf8Bytes(serialized) <= MAX_TOPOLOGY_JSON_BYTES) return serialized;

  return legacyWithTruncationFlag;
}

function projectPlanningAttempts(
  attempts: readonly PlanningAttemptTopologyAudit[],
  state: TruncationState,
): ProjectedPlanningAttempt[] {
  let selected = attempts;
  if (attempts.length > MAX_PLANNING_ATTEMPTS) {
    selected = [...attempts.slice(0, MAX_PLANNING_ATTEMPTS - 1), attempts.at(-1)!];
    state.truncated = true;
  }
  return selected.map(attempt => ({
    phase: truncateAuditString(attempt.phase, state),
    attempt: attempt.attempt,
    plan: {
      reviewed_page_ids: capArray(attempt.plan.reviewed_page_ids, state)
        .map(id => truncateAuditString(id, state)),
      actions: capArray(attempt.plan.actions, state)
        .map(action => projectPlanningAction(action, state)),
    },
    issues: capArray(attempt.issues, state).map(issue => ({
      code: truncateAuditString(issue.code, state),
      ...(issue.action_index === undefined ? {} : { action_index: issue.action_index }),
      ...(issue.node_id === undefined ? {} : { node_id: truncateAuditString(issue.node_id, state) }),
      ...(issue.plan_key === undefined ? {} : { plan_key: truncateAuditString(issue.plan_key, state) }),
    })),
  }));
}

function projectPlanningAction(action: PlanningActionAudit, state: TruncationState): Record<string, unknown> {
  const op = truncateAuditString(action.op, state);
  const scope = projectAuditScope(action.scope, state);
  // Only a brief's length is kept, so long briefs can be counted (#633).
  const briefChars = typeof action.synthesis_brief_chars === 'number' ? { synthesis_brief_chars: action.synthesis_brief_chars } : {};
  switch (action.op) {
    case 'keep':
    case 'refresh':
    case 'reactivate':
    case 'retire':
      return { op, node_id: truncateAuditString(action.node_id, state), scope, ...briefChars };
    case 'create':
      return {
        op,
        plan_key: truncateAuditString(action.plan_key, state),
        title: truncateAuditString(action.title, state),
        kind: truncateAuditString(action.kind, state),
        scope,
        ...briefChars,
      };
    case 'merge':
      return {
        op,
        target: 'node_id' in action.target
          ? { node_id: truncateAuditString(action.target.node_id, state) }
          : { plan_key: truncateAuditString(action.target.plan_key, state) },
        sources: capArray(action.sources, state).map(id => truncateAuditString(id, state)),
        scope,
        ...briefChars,
      };
  }
}

function projectAuditScope(scope: WikiScopeV1, state: TruncationState): Record<string, unknown> {
  return {
    v: 1,
    subject: truncateAuditString(scope.subject, state),
    facet: truncateAuditString(scope.facet, state),
    ...(scope.timeframe === undefined ? {} : { timeframe: truncateAuditString(scope.timeframe, state) }),
    ...(scope.geography === undefined ? {} : { geography: truncateAuditString(scope.geography, state) }),
    ...(scope.entities === undefined ? {} : {
      entities: capArray(scope.entities, state).map(value => truncateAuditString(value, state)),
    }),
    ...(scope.exclusions === undefined ? {} : {
      exclusions: capArray(scope.exclusions, state).map(value => truncateAuditString(value, state)),
    }),
  };
}

function capArray<T>(items: readonly T[], state: TruncationState): readonly T[] {
  if (items.length <= MAX_AUDIT_ITEMS) return items;
  state.truncated = true;
  return items.slice(0, MAX_AUDIT_ITEMS);
}

function truncateAuditString(value: string, state: TruncationState): string {
  if (utf8Bytes(value) <= MAX_AUDIT_STRING_BYTES) return value;
  state.truncated = true;
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8Bytes(codePoint);
    if (bytes + codePointBytes > MAX_AUDIT_STRING_BYTES) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

function popTailItemBytes(
  attempts: ProjectedPlanningAttempt[],
  select: (attempt: ProjectedPlanningAttempt) => unknown[],
): number | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const items = select(attempts[index]!);
    if (items.length > 0) {
      const encoded = JSON.stringify(items.at(-1));
      items.pop();
      return encoded === undefined ? 0 : utf8Bytes(encoded) + (items.length > 0 ? 1 : 0);
    }
  }
  return null;
}

function removeOldestRepairAttempt(attempts: ProjectedPlanningAttempt[]): boolean {
  if (attempts.length <= 2) return false;
  attempts.splice(1, 1);
  return true;
}

function serializeWithAttempts(
  legacy: LegacyTopologyAudit,
  attempts: readonly ProjectedPlanningAttempt[],
  truncated: boolean,
): string {
  return JSON.stringify({
    ...legacy,
    planning_attempts: attempts,
    ...(truncated ? { planning_attempts_truncated: true } : {}),
  });
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function projectTopology(item: TopologyResult): Record<string, unknown> {
  const projected: Record<string, unknown> = { action: item.action };
  if ('node_id' in item && item.node_id !== undefined) projected['node_id'] = item.node_id;
  if ('title' in item && item.title !== undefined) projected['title'] = item.title.slice(0, 300);
  if ('scope' in item) projected['scope'] = item.scope;
  if ('target_node_id' in item) projected['target_node_id'] = item.target_node_id;
  if ('target_title' in item) projected['target_title'] = item.target_title.slice(0, 300);
  if ('source_node_ids' in item) projected['source_node_ids'] = item.source_node_ids.slice(0, 100);
  if (item.action === 'dormant' || item.action === 'retired') projected['state'] = item.action;
  return projected;
}

/** Insert one run row. Caller wraps best-effort — recording never fails curation. */
export function recordRun(db: Database.Database, row: RunRowInsert): void {
  db.prepare(`
    INSERT INTO runs (
      ts, project, "trigger", dry_run, outcome, evidence_hash, wiki_curated_at,
      home_written, spine_written, spine_total, themed_created, themed_retired,
      input_tokens, output_tokens, cache_read, cache_write, cost_usd, duration_ms, error, topology_json,
      refresh_trigger, refresh_evidence_json, output_policy_hash
    ) VALUES (
      @ts, @project, @trigger, @dry_run, @outcome, @evidence_hash, @wiki_curated_at,
      @home_written, @spine_written, @spine_total, @themed_created, @themed_retired,
      @input_tokens, @output_tokens, @cache_read, @cache_write, @cost_usd, @duration_ms, @error, @topology_json,
      @refresh_trigger, @refresh_evidence_json, @output_policy_hash
    )
  `).run({ output_policy_hash: null, ...row });
}

export function recentRuns(db: Database.Database, limit: number): RunRow[] {
  return db.prepare('SELECT * FROM runs ORDER BY ts DESC, id DESC LIMIT ?').all(limit) as RunRow[];
}

export type ProjectRunSummary = Pick<RunRow, 'id' | 'ts' | 'outcome' | 'error' | 'cost_usd' | 'input_tokens' | 'output_tokens' | 'duration_ms'>;

/** A wiki's latest real run and its last written build, without the large columns. */
export function latestProjectRuns(db: Database.Database, project: string): { latest: ProjectRunSummary | null; written: ProjectRunSummary | null } {
  const columns = 'id, ts, outcome, error, cost_usd, input_tokens, output_tokens, duration_ms';
  const latest = db.prepare(`SELECT ${columns} FROM runs WHERE project = ? AND dry_run = 0 ORDER BY id DESC LIMIT 1`).get(project) as ProjectRunSummary | undefined;
  const written = db.prepare(`SELECT ${columns} FROM runs WHERE project = ? AND dry_run = 0 AND outcome = 'written' ORDER BY id DESC LIMIT 1`).get(project) as ProjectRunSummary | undefined;
  return { latest: latest ?? null, written: written ?? null };
}

/** One run's stored topology, for a caller that asks for it by id. */
export function runTopology(db: Database.Database, id: number): Pick<RunRow, 'id' | 'project' | 'ts' | 'topology_json'> | undefined {
  return db.prepare('SELECT id, project, ts, topology_json FROM runs WHERE id = ?').get(id) as
    Pick<RunRow, 'id' | 'project' | 'ts' | 'topology_json'> | undefined;
}

/** The latest row per project (newest id wins), newest-first. */
export function perProjectLatest(db: Database.Database): RunRow[] {
  return db.prepare(`
    SELECT r.* FROM runs r
    JOIN (SELECT project, MAX(id) AS max_id FROM runs GROUP BY project) m
      ON r.id = m.max_id
    ORDER BY r.ts DESC, r.id DESC
  `).all() as RunRow[];
}

export interface UsageAggregate {
  run_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  // Non-null by construction: aggregateUsage wraps SUM(cost_usd) in COALESCE(..., 0),
  // so an all-null/empty window yields 0 rather than null.
  cost_usd: number;
  /** Runs that used tokens but have no cost, so `cost_usd` leaves them out. */
  unpriced_runs: number;
}

export function aggregateUsage(db: Database.Database, sinceTs: string): UsageAggregate {
  return db.prepare(`
    SELECT
      COUNT(*)                       AS run_count,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read), 0)    AS cache_read,
      COALESCE(SUM(cache_write), 0)   AS cache_write,
      COALESCE(SUM(cost_usd), 0)      AS cost_usd,
      COALESCE(SUM(cost_usd IS NULL AND input_tokens + output_tokens > 0), 0) AS unpriced_runs
    FROM runs WHERE ts >= ?
  `).get(sinceTs) as UsageAggregate;
}

/**
 * Evidence hash of a wiki's latest real run when that run failed after paid model
 * usage at or after `sinceTs`; null otherwise. Only written/error wiki rows count, so
 * hold skips and requested-page rows never extend or clear a hold. A topic whose
 * current web evidence differs from the failed run's is not held: its evidence changed. Nor is a
 * wiki whose output policy differs from the failed run's.
 */
export function paidFailureHash(db: Database.Database, project: string, sinceTs: string,
  currentWebHash: string | null = null, currentPolicyHash: string | null = null): string | null {
  const row = db.prepare(`
    SELECT outcome, evidence_hash, input_tokens, output_tokens, ts, refresh_evidence_json, error, output_policy_hash FROM runs
    WHERE project = ? AND dry_run = 0 AND outcome IN ('written', 'error')
    ORDER BY id DESC LIMIT 1
  `).get(project) as { outcome: string; evidence_hash: string | null; input_tokens: number; output_tokens: number; ts: string;
    refresh_evidence_json: string | null; error: string | null; output_policy_hash: string | null } | undefined;
  if (!row || row.outcome !== 'error' || !row.evidence_hash || row.ts < sinceTs) return null;
  if (row.error !== null && TRANSPORT_FAILURE.test(row.error)) return null;
  if (failedWebHash(row.refresh_evidence_json) !== closedSha256(currentWebHash)) return null;
  // A changed model, token cap, reasoning effort or reasoning budget gets one retry: if it fails too, that run's
  // row holds the new policy (#358). With no policy to compare, the hold stands.
  if (row.output_policy_hash !== null && currentPolicyHash !== null && row.output_policy_hash !== currentPolicyHash) return null;
  return row.input_tokens + row.output_tokens > 0 ? row.evidence_hash : null;
}

/** A run that failed only because the connection to the provider failed. The hold is for output
 *  the model keeps getting wrong; a dropped connection is not that, so the next night retries
 *  (#323). Model-call failures end their error with the closed reason code. */
const TRANSPORT_FAILURE = /\(reason=provider_transport_failed\)$/;

function failedWebHash(json: string | null): string | null {
  if (json === null) return null;
  try {
    return closedSha256((JSON.parse(json) as { current_web_hash?: unknown }).current_web_hash);
  } catch {
    return null;
  }
}

/** Most recent real (non-dry-run) curation time. Source for startup catch-up. */
export function lastSweepAt(db: Database.Database): Date | null {
  const row = db.prepare('SELECT MAX(ts) AS max_ts FROM runs WHERE dry_run = 0').get() as { max_ts: string | null };
  if (!row.max_ts) return null;
  const t = Date.parse(row.max_ts);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Map one requested-page fulfillment into a run row. Spine columns are zero by
 * construction; a successful fulfillment counts as one themed write so the
 * aggregate windows keep reflecting real synthesis spend.
 */
export function requestedPageRunRow(res: RequestedPageOutcome, ctx: RunContext): RunRowInsert {
  const usage = res.invocationUsage ?? res.usage ?? ZERO_USAGE;
  const ok = res.outcome === 'written';
  return {
    ts: ctx.ts,
    project: res.project,
    trigger: ctx.trigger,
    dry_run: res.dryRun ? 1 : 0,
    outcome: ok ? 'requested_page' : 'requested_page_error',
    evidence_hash: null,
    wiki_curated_at: null,
    home_written: 0,
    spine_written: 0,
    spine_total: 0,
    themed_created: ok ? 1 : 0,
    themed_retired: 0,
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    cost_usd: res.invocationUsage === undefined ? (res.costUsd ?? null) : (res.invocationCostUsd ?? null),
    duration_ms: ctx.durationMs,
    error: ok ? null : (res.detail ?? res.outcome),
    topology_json: null,
    refresh_trigger: null,
    refresh_evidence_json: null,
  };
}

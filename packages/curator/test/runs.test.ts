import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import {
  curateResultToRunRow, recordRun, recentRuns, perProjectLatest,
  aggregateUsage, lastSweepAt, paidFailureHash, requestedPageRunRow, type RunRowInsert,
} from '../src/db/runs.js';
import type { CurateResult } from '../src/types.js';

const CTX = { trigger: 'scheduled' as const, durationMs: 1500, ts: '2026-06-07T05:00:00.000Z' };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('curateResultToRunRow', () => {
  it('retains only opaque provenance receipt references in the bounded run projection', () => {
    const result = { project: 'Project', outcome: 'written', dryRun: false, topologyAudit: {
      provenanceReceipt: { derivation_id: 'derivation', output_revision_id: 'output', request_digest: 'PRIVATE', replay_result: 'PRIVATE' },
    } } as unknown as CurateResult;
    const row = curateResultToRunRow(result, CTX);
    expect(JSON.parse(row.topology_json!).provenance).toEqual({ derivation_id: 'derivation', output_revision_id: 'output' });
    expect(row.topology_json).not.toContain('PRIVATE');
  });
  it('serializes valid committed and current web hashes only from private run context', () => {
    const committedWebHash = 'a'.repeat(64);
    const currentWebHash = 'b'.repeat(64);
    const result: CurateResult = {
      project: 'Topic', outcome: 'skipped_cadence_not_due', dryRun: false,
      refreshTrigger: 'not_due', changedSourceNodeIds: [], refreshWarnings: [],
    };

    const row = curateResultToRunRow(result, {
      ...CTX,
      refreshEvidence: { committedWebHash, currentWebHash },
    });

    expect(JSON.parse(row.refresh_evidence_json ?? '{}')).toMatchObject({
      committed_web_hash: committedWebHash,
      current_web_hash: currentWebHash,
    });
    expect(result).not.toHaveProperty('committedWebHash');
    expect(result).not.toHaveProperty('currentWebHash');
  });

  it('projects closed topic refresh evidence without durable source or provider content', () => {
    const secret = 'SECRET_SOURCE_BODY_WEB_SNIPPET_SNAPSHOT_RAW_OUTPUT_STACK';
    const result = {
      project: 'Topic', outcome: 'written', detail: secret, dryRun: false,
      refreshTrigger: 'web_material_change',
      changedSourceNodeIds: ['source-b', 'source-a'],
      webAssessment: {
        verdict: 'material', reasonCode: 'new_development',
        changedUrls: ['https://example.com/b', 'https://example.com/a'],
      },
      refreshWarnings: ['source_read_unavailable', 'web_probe_unavailable'],
      sourceBody: secret, webSnippet: secret, snapshotJson: secret, rawOutput: secret,
      stack: secret,
    } as CurateResult & Record<string, unknown>;

    const row = curateResultToRunRow(result, CTX);

    expect(row.refresh_trigger).toBe('web_material_change');
    expect(JSON.parse(row.refresh_evidence_json ?? '{}')).toEqual({
      changed_source_node_ids: ['source-b', 'source-a'],
      warnings: ['source_read_unavailable', 'web_probe_unavailable'],
      web_assessment: {
        verdict: 'material', reason_code: 'new_development',
        changed_urls: ['https://example.com/b', 'https://example.com/a'],
      },
    });
    expect(row.refresh_evidence_json).not.toContain(secret);
  });

  it('caps refresh arrays and removes whole tail values before setting truncated', () => {
    const result = {
      project: 'Topic', outcome: 'skipped_cadence_not_due', dryRun: false,
      refreshTrigger: 'not_due',
      changedSourceNodeIds: Array.from({ length: 80 }, (_, index) => `source-${index}-${'x'.repeat(1_000)}`),
      refreshWarnings: Array.from({ length: 20 }, () => 'source_read_unavailable'),
      webAssessment: {
        verdict: 'immaterial', reasonCode: 'restatement',
        changedUrls: Array.from({ length: 30 }, (_, index) => `https://example.com/${index}/${'y'.repeat(1_000)}`),
      },
    } as CurateResult;

    const serialized = curateResultToRunRow(result, CTX).refresh_evidence_json ?? '';
    const evidence = JSON.parse(serialized) as {
      changed_source_node_ids: string[];
      warnings: string[];
      web_assessment: { changed_urls: string[] };
      truncated?: boolean;
    };

    expect(serialized.length).toBeLessThanOrEqual(32_000);
    expect(evidence.changed_source_node_ids.length).toBeLessThanOrEqual(70);
    expect(evidence.warnings.length).toBeLessThanOrEqual(8);
    expect(evidence.web_assessment.changed_urls.length).toBeLessThanOrEqual(20);
    expect(evidence.truncated).toBe(true);
    expect(JSON.stringify(evidence)).toBe(serialized);
  });

  it('drops runtime values outside the closed refresh unions', () => {
    const result = {
      project: 'Topic', outcome: 'written', dryRun: false,
      refreshTrigger: 'secret_trigger',
      refreshWarnings: ['source_baseline_not_ready', 'secret_warning'],
      webAssessment: { verdict: 'secret', reasonCode: 'secret', changedUrls: ['https://example.com'] },
    } as unknown as CurateResult;

    const row = curateResultToRunRow(result, CTX);

    expect(row.refresh_trigger).toBeNull();
    expect(row.refresh_evidence_json).toBe(JSON.stringify({ warnings: ['source_baseline_not_ready'] }));
  });

  it('keeps legacy non-topic results on null refresh columns', () => {
    const row = curateResultToRunRow(writtenProjectResult(), CTX);
    expect(row.refresh_trigger).toBeNull();
    expect(row.refresh_evidence_json).toBeNull();
  });

  it('maps a full written result', () => {
    const result: CurateResult = {
      project: 'Demo', outcome: 'written', detail: 'home created', dryRun: false,
      evidenceHash: 'abc', wikiCuratedAt: '2026-06-07T05:00:00.000Z',
      themed: [
        { kind: 'workstream', title: 'Demo — Auth', action: 'created', state: 'active' },
        { kind: 'freeform', title: 'Demo — Old', action: 'retired', state: 'retired' },
      ],
      usage: { input: 100, output: 50, cacheWrite: 5, cacheRead: 10 },
      costUsd: 0.0123,
      topologyHash: 'post-hash',
      topology: [
        { action: 'created', node_id: 'n1', title: 'Demo — Auth', scope: { v: 1, subject: 'Demo', facet: 'Auth' }, kind: 'workstream' },
        { action: 'merged-source', node_id: 'n2', title: 'Demo — Old', scope: { v: 1, subject: 'Demo', facet: 'Auth' }, target_node_id: 'n1', target_title: 'Demo — Auth' },
      ],
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [{ candidate_plan_key: 'auth', compared_to: { node_id: 'n2' }, relation: 'same-scope', confidence: 0.91, evidence_ids: [], reason: 'same' }],
        validationIssueCodes: [], reconcileKey: 'key-1', warnings: ['bounded warning'],
      },
    };
    const row = curateResultToRunRow(result, CTX);
    expect(row).toMatchObject({
      project: 'Demo', trigger: 'scheduled', dry_run: 0, outcome: 'written',
      evidence_hash: 'abc', wiki_curated_at: '2026-06-07T05:00:00.000Z',
      home_written: 1, spine_written: 0, spine_total: 0,
      themed_created: 1, themed_retired: 1,
      input_tokens: 100, output_tokens: 50, cache_read: 10, cache_write: 5,
      cost_usd: 0.0123, duration_ms: 1500, error: null,
      topology_json: expect.any(String),
    });
    expect(JSON.parse(row.topology_json ?? '{}')).toMatchObject({
      post_topology_hash: 'post-hash', reconcile_key: 'key-1', warnings: ['bounded warning'],
      compatibility: { themed_created: 1, themed_retired: 1 },
      actions: [{ action: 'created', node_id: 'n1' }, { action: 'merged-source', target_node_id: 'n1' }],
      adjudication: [{ relation: 'same-scope', confidence: 0.91 }],
    });
    expect(JSON.parse(row.topology_json ?? '{}')).not.toHaveProperty('planning_attempts');
    expect(JSON.parse(row.topology_json ?? '{}')).not.toHaveProperty('planning_attempts_truncated');
  });

  it('projects only bounded failed-plan diagnostics without evidence or synthesized prose', () => {
    const long = `${'a'.repeat(299)}🙂`;
    const evidenceMarker = 'TEST_EVIDENCE_MARKER';
    const pageBodyMarker = 'TEST_PAGE_BODY_MARKER';
    const planningAttempts = [{
      phase: long,
      attempt: 0,
      plan: {
        reviewed_page_ids: [long, ...Array.from({ length: 100 }, (_, index) => `reviewed-${index}`)],
        actions: [
          {
            op: 'merge', target: { plan_key: long },
            sources: Array.from({ length: 101 }, (_, index) => `source-${index}`),
            scope: {
              v: 1, subject: long, facet: long, timeframe: long, geography: long,
              entities: Array.from({ length: 101 }, (_, index) => `entity-${index}`),
              exclusions: Array.from({ length: 101 }, (_, index) => `exclusion-${index}`),
            },
            reason: evidenceMarker,
            synthesis_brief: pageBodyMarker,
            raw_response: evidenceMarker,
          },
          { op: 'create', plan_key: long, title: long, kind: 'workstream', scope: { v: 1, subject: long, facet: long }, synthesis_brief: pageBodyMarker },
        ],
      },
      issues: Array.from({ length: 101 }, (_, index) => ({
        code: index === 0 ? long : `CODE_${index}`,
        message: `${evidenceMarker}-${index}`,
        action_index: index,
        node_id: index === 0 ? long : `node-${index}`,
        plan_key: index === 0 ? long : `key-${index}`,
      })),
      evidence: evidenceMarker,
    }];
    const result: CurateResult = {
      project: 'Demo', outcome: 'error', detail: 'validation exhausted', dryRun: false,
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [], validationIssueCodes: [], warnings: [],
        planningAttempts: planningAttempts as never,
      },
    };

    const row = curateResultToRunRow(result, CTX);
    const serialized = row.topology_json ?? '';
    const topology = JSON.parse(serialized) as {
      planning_attempts: Array<{
        phase: string;
        plan: { reviewed_page_ids: string[]; actions: Array<Record<string, unknown>> };
        issues: Array<Record<string, unknown>>;
      }>;
      planning_attempts_truncated?: boolean;
    };
    const attempt = topology.planning_attempts[0]!;
    const merge = attempt.plan.actions[0] as {
      target: { plan_key: string };
      sources: string[];
      scope: { subject: string; entities: string[]; exclusions: string[] };
    };

    expect(topology.planning_attempts_truncated).toBe(true);
    expect(attempt.plan.reviewed_page_ids).toHaveLength(100);
    expect(attempt.plan.actions).toHaveLength(2);
    expect(attempt.issues).toHaveLength(100);
    expect(merge.sources).toHaveLength(100);
    expect(merge.scope.entities).toHaveLength(100);
    expect(merge.scope.exclusions).toHaveLength(100);
    expect(attempt.phase).toBe('a'.repeat(299));
    expect(merge.target.plan_key).toBe('a'.repeat(299));
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(65_536);
    for (const value of stringsIn(topology.planning_attempts)) {
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(300);
    }
    expect(serialized).not.toContain(evidenceMarker);
    expect(serialized).not.toContain(pageBodyMarker);
    expect(serialized).not.toContain('synthesis_brief');
    expect(serialized).not.toContain('reason');
    expect(serialized).not.toContain('message');
    expect(serialized).not.toContain('raw_response');
  });

  it('serializes successful planning attempts without changing legacy run fields', () => {
    const result: CurateResult = {
      project: 'Demo', outcome: 'written', dryRun: false, topologyHash: 'post-hash',
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [], validationIssueCodes: [], reconcileKey: 'key-1', warnings: ['warning'],
        planningAttempts: [{
          phase: 'validation', attempt: 0,
          plan: {
            reviewed_page_ids: ['page'],
            actions: [{ op: 'keep', node_id: 'page', scope: { v: 1, subject: 'Demo', facet: 'Auth' } }],
          },
          issues: [],
        }],
      },
    };

    const topology = JSON.parse(curateResultToRunRow(result, CTX).topology_json ?? '{}');

    expect(topology).toMatchObject({
      actions: [], adjudication: [], validation_issue_codes: [], post_topology_hash: 'post-hash',
      reconcile_key: 'key-1', warnings: ['warning'],
      compatibility: { themed_created: 0, themed_retired: 0 },
      planning_attempts: [{
        phase: 'validation', attempt: 0,
        plan: { reviewed_page_ids: ['page'], actions: [{ op: 'keep', node_id: 'page' }] },
        issues: [],
      }],
    });
    expect(topology).not.toHaveProperty('planning_attempts_truncated');
  });

  it('caps attempts and total UTF-8 bytes while preserving the first and final attempts', () => {
    const long = '界'.repeat(200);
    const planningAttempts = Array.from({ length: 7 }, (_, attempt) => ({
      phase: `phase-${attempt}-${long}`,
      attempt,
      plan: {
        reviewed_page_ids: Array.from({ length: 100 }, (_, index) => `${attempt}-reviewed-${index}-${long}`),
        actions: Array.from({ length: 100 }, (_, index) => ({
          op: 'create', plan_key: `${attempt}-key-${index}-${long}`, title: `${attempt}-title-${index}-${long}`,
          kind: 'workstream', scope: { v: 1, subject: long, facet: long }, synthesis_brief: long,
        })),
      },
      issues: Array.from({ length: 100 }, (_, index) => ({
        code: `${attempt}-code-${index}-${long}`, action_index: index, node_id: `${attempt}-node-${index}-${long}`,
      })),
    }));
    const result: CurateResult = {
      project: 'Demo', outcome: 'error', detail: 'validation exhausted', dryRun: false,
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [], validationIssueCodes: [], warnings: [],
        planningAttempts: planningAttempts as never,
      },
    };

    const serialized = curateResultToRunRow(result, CTX).topology_json ?? '';
    const topology = JSON.parse(serialized) as {
      planning_attempts: Array<{ phase: string; attempt: number }>;
      planning_attempts_truncated?: boolean;
    };

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(65_536);
    expect(topology.planning_attempts).toHaveLength(6);
    expect(topology.planning_attempts[0]?.attempt).toBe(0);
    expect(topology.planning_attempts.at(-1)?.attempt).toBe(6);
    expect(topology.planning_attempts_truncated).toBe(true);
  });

  it.each([
    { paddingBytes: 65_191, expectedBytes: 65_536, exception: false },
    { paddingBytes: 65_192, expectedBytes: 65_537, exception: true },
  ])('uses legacy plus the mandatory flag as the $expectedBytes-byte compatibility boundary', ({
    paddingBytes, expectedBytes, exception,
  }) => {
    const sourceNodeId = 'x'.repeat(paddingBytes);
    const result: CurateResult = {
      project: 'Demo', outcome: 'written', dryRun: false,
      topology: [{
        action: 'merged-target', node_id: 'target', title: 'Target',
        scope: { v: 1, subject: 'Demo', facet: 'Auth' }, source_node_ids: [sourceNodeId],
      }],
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [], validationIssueCodes: [], warnings: [],
        planningAttempts: [{
          phase: 'validation', attempt: 0,
          plan: { reviewed_page_ids: [], actions: [] }, issues: [],
        }],
      },
    };

    const serialized = curateResultToRunRow(result, CTX).topology_json ?? '';
    const topology = JSON.parse(serialized) as Record<string, unknown>;
    const actions = topology['actions'] as Array<{ source_node_ids: string[] }>;

    expect(Buffer.byteLength(serialized, 'utf8')).toBe(expectedBytes);
    expect(Buffer.byteLength(serialized, 'utf8') > 65_536).toBe(exception);
    expect(actions[0]?.source_node_ids).toEqual([sourceNodeId]);
    expect(topology).not.toHaveProperty('planning_attempts');
    expect(topology['planning_attempts_truncated']).toBe(true);
  });

  it('preserves oversized legacy topology fields and omits attempts', () => {
    const sourceNodeIds = Array.from({ length: 100 }, (_, index) => `${index}-${'x'.repeat(1_000)}`);
    const result: CurateResult = {
      project: 'Demo', outcome: 'written', dryRun: false,
      topology: [{
        action: 'merged-target', node_id: 'target', title: 'Target',
        scope: { v: 1, subject: 'Demo', facet: 'Auth' }, source_node_ids: sourceNodeIds,
      }],
      topologyAudit: {
        catalog: { valid: true, missing_scope_node_ids: [] }, proposedActions: [], finalActions: [],
        adjudicationVerdicts: [], validationIssueCodes: [], warnings: [],
        planningAttempts: [{
          phase: 'validation', attempt: 0,
          plan: { reviewed_page_ids: [], actions: [] }, issues: [],
        }],
      },
    };

    const serialized = curateResultToRunRow(result, CTX).topology_json ?? '';
    const topology = JSON.parse(serialized) as Record<string, unknown>;
    const actions = topology['actions'] as Array<{ source_node_ids: string[] }>;

    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(65_536);
    expect(actions[0]?.source_node_ids).toEqual(sourceNodeIds);
    expect(topology).not.toHaveProperty('planning_attempts');
    expect(topology['planning_attempts_truncated']).toBe(true);
  });

  it('records skipped as skipped_unchanged with zero counts and no error', () => {
    const result: CurateResult = {
      project: 'Demo', outcome: 'skipped', detail: 'evidence unchanged', dryRun: false,
      evidenceHash: 'h', wikiCuratedAt: '2026-06-01T00:00:00.000Z',
    };
    const row = curateResultToRunRow(result, CTX);
    expect(row.outcome).toBe('skipped_unchanged');
    expect(row.home_written).toBe(0);
    expect(row.spine_total).toBe(0);
    expect(row.input_tokens).toBe(0);
    expect(row.cost_usd).toBeNull();
    expect(row.error).toBeNull();
    expect(row.topology_json).toBeNull();
  });

  it('captures the error detail only on the error path', () => {
    const result: CurateResult = { project: 'Demo', outcome: 'error', detail: 'kaboom', dryRun: false };
    const row = curateResultToRunRow(result, CTX);
    expect(row.outcome).toBe('error');
    expect(row.error).toBe('kaboom');
    expect(row.evidence_hash).toBeNull();
  });

  it('flags dry-run results', () => {
    const result: CurateResult = { project: 'Demo', outcome: 'written', dryRun: true, evidenceHash: 'h' };
    expect(curateResultToRunRow(result, CTX).dry_run).toBe(1);
  });
});

function writtenProjectResult(): CurateResult {
  return { project: 'Project', outcome: 'written', detail: 'home updated', dryRun: false };
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

describe('runs persistence + reads', () => {
  const base: RunRowInsert = {
    ts: '', project: '', trigger: 'scheduled', dry_run: 0, outcome: 'written',
    evidence_hash: 'h', wiki_curated_at: null, home_written: 1,
    spine_written: 1, spine_total: 1, themed_created: 0, themed_retired: 0,
    input_tokens: 10, output_tokens: 5, cache_read: 1, cache_write: 1,
    cost_usd: 0.01, duration_ms: 100, error: null,
    topology_json: null,
    refresh_trigger: null, refresh_evidence_json: null,
  };

  it('recordRun + recentRuns returns newest first, honoring limit', () => {
    const db = freshDb();
    recordRun(db, { ...base, ts: '2026-06-07T01:00:00.000Z', project: 'A' });
    recordRun(db, { ...base, ts: '2026-06-07T02:00:00.000Z', project: 'B' });
    recordRun(db, { ...base, ts: '2026-06-07T03:00:00.000Z', project: 'C' });
    const rows = recentRuns(db, 2);
    expect(rows.map((r) => r.project)).toEqual(['C', 'B']);
    expect(rows[0]!.id).toBeTypeOf('number');
    db.close();
  });

  it('recordRun + recentRuns round-trips refresh observability columns', () => {
    const db = freshDb();
    const refreshEvidence = JSON.stringify({ changed_source_node_ids: ['source-a'] });
    recordRun(db, {
      ...base, ts: '2026-06-07T01:00:00.000Z', project: 'Topic',
      refresh_trigger: 'vault_source_changed', refresh_evidence_json: refreshEvidence,
    });

    expect(recentRuns(db, 1)[0]).toMatchObject({
      refresh_trigger: 'vault_source_changed', refresh_evidence_json: refreshEvidence,
    });
    db.close();
  });

  it('perProjectLatest returns the newest row per project', () => {
    const db = freshDb();
    recordRun(db, { ...base, ts: '2026-06-07T01:00:00.000Z', project: 'A', outcome: 'written' });
    recordRun(db, { ...base, ts: '2026-06-07T02:00:00.000Z', project: 'A', outcome: 'skipped_unchanged' });
    recordRun(db, { ...base, ts: '2026-06-07T03:00:00.000Z', project: 'B' });
    const rows = perProjectLatest(db);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.project === 'A')!;
    expect(a.outcome).toBe('skipped_unchanged');
    db.close();
  });

  it('aggregateUsage sums within the window only', () => {
    const db = freshDb();
    recordRun(db, { ...base, ts: '2026-06-01T00:00:00.000Z', project: 'old', input_tokens: 1000 });
    recordRun(db, { ...base, ts: '2026-06-07T00:00:00.000Z', project: 'new', input_tokens: 7 });
    const agg = aggregateUsage(db, '2026-06-05T00:00:00.000Z');
    expect(agg.run_count).toBe(1);
    expect(agg.input_tokens).toBe(7);
    db.close();
  });

  it('aggregateUsage counts runs that used tokens but have no cost (#356)', () => {
    const db = freshDb();
    const ts = '2026-06-07T00:00:00.000Z';
    recordRun(db, { ...base, ts, project: 'priced', cost_usd: 0.5 });
    recordRun(db, { ...base, ts, project: 'unpriced', cost_usd: null });
    recordRun(db, { ...base, ts, project: 'no-call', cost_usd: null, input_tokens: 0, output_tokens: 0 });
    const agg = aggregateUsage(db, '2026-06-05T00:00:00.000Z');
    expect(agg.cost_usd).toBe(0.5);
    expect(agg.unpriced_runs).toBe(1);
    db.close();
  });

  it('lastSweepAt ignores dry-run rows and returns null when empty', () => {
    const db = freshDb();
    expect(lastSweepAt(db)).toBeNull();
    recordRun(db, { ...base, ts: '2026-06-07T05:00:00.000Z', project: 'dry', dry_run: 1 });
    expect(lastSweepAt(db)).toBeNull();
    recordRun(db, { ...base, ts: '2026-06-07T04:00:00.000Z', project: 'real', dry_run: 0 });
    expect(lastSweepAt(db)!.toISOString()).toBe('2026-06-07T04:00:00.000Z');
    db.close();
  });
});

describe('paidFailureHash', () => {
  const run = (db: Database.Database, ts: string, result: Partial<CurateResult>, dryRun = false): void => recordRun(db,
    curateResultToRunRow({ project: 'P', outcome: 'error', dryRun, evidenceHash: 'h1',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, ...result } as CurateResult, { ...CTX, ts }));
  const SINCE = '2026-06-01T00:00:00.000Z';

  it('holds the evidence of a recent paid failure, and only that', () => {
    const db = freshDb();
    expect(paidFailureHash(db, 'P', SINCE)).toBeNull();
    run(db, '2026-06-02T05:00:00.000Z', {});
    expect(paidFailureHash(db, 'P', SINCE)).toBe('h1');
    expect(paidFailureHash(db, 'Other', SINCE)).toBeNull();
    expect(paidFailureHash(db, 'P', '2026-06-03T00:00:00.000Z')).toBeNull();
  });

  it('holds nothing after a failure that was only a dropped provider connection (#323)', () => {
    const db = freshDb();
    run(db, '2026-06-02T05:00:00.000Z', { detail: 'page synthesis: Page synthesis failed for p1: structured call failed (reason=provider_transport_failed)' });
    expect(paidFailureHash(db, 'P', SINCE)).toBeNull();
    run(db, '2026-06-03T05:00:00.000Z', { detail: 'home synthesis: structured call failed (reason=provider_transport_failed)' });
    expect(paidFailureHash(db, 'P', SINCE)).toBeNull();
    run(db, '2026-06-04T05:00:00.000Z', { detail: 'validation: MISSING_NODE_ROLE' });
    expect(paidFailureHash(db, 'P', SINCE)).toBe('h1');
    run(db, '2026-06-05T05:00:00.000Z', { detail: 'home synthesis: structured call failed (reason=truncated)' });
    expect(paidFailureHash(db, 'P', SINCE)).toBe('h1');
  });

  it('lifts the hold once when the output policy changed (#358)', () => {
    const db = freshDb();
    run(db, '2026-06-02T05:00:00.000Z', { outputPolicyHash: 'policy-a' });
    expect(paidFailureHash(db, 'P', SINCE, null, 'policy-a')).toBe('h1');
    expect(paidFailureHash(db, 'P', SINCE, null, 'policy-b')).toBeNull();
    // The retry on the new policy fails too, so that policy is now the one held.
    run(db, '2026-06-03T05:00:00.000Z', { outputPolicyHash: 'policy-b' });
    expect(paidFailureHash(db, 'P', SINCE, null, 'policy-b')).toBe('h1');
    db.close();
  });

  it('keeps the hold when either policy is unknown', () => {
    const db = freshDb();
    run(db, '2026-06-02T05:00:00.000Z', {});
    expect(paidFailureHash(db, 'P', SINCE, null, 'policy-a')).toBe('h1');
    run(db, '2026-06-03T05:00:00.000Z', { outputPolicyHash: 'policy-a' });
    expect(paidFailureHash(db, 'P', SINCE, null, null)).toBe('h1');
    db.close();
  });

  it('holds a topic failure only while its web evidence is unchanged', () => {
    const db = freshDb();
    const failedWeb = 'a'.repeat(64);
    recordRun(db, curateResultToRunRow({ project: 'P', outcome: 'error', dryRun: false, evidenceHash: 'h1',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } as CurateResult,
    { ...CTX, ts: '2026-06-02T05:00:00.000Z', refreshEvidence: { currentWebHash: failedWeb } }));
    expect(paidFailureHash(db, 'P', SINCE, failedWeb)).toBe('h1');
    expect(paidFailureHash(db, 'P', SINCE, 'b'.repeat(64))).toBeNull();
    expect(paidFailureHash(db, 'P', SINCE)).toBeNull();
  });

  it('ignores failures without model usage, and clears after a written run', () => {
    const db = freshDb();
    run(db, '2026-06-02T05:00:00.000Z', { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(paidFailureHash(db, 'P', SINCE)).toBeNull();
    run(db, '2026-06-03T05:00:00.000Z', {});
    run(db, '2026-06-04T05:00:00.000Z', { outcome: 'written', evidenceHash: 'h2' });
    expect(paidFailureHash(db, 'P', SINCE)).toBeNull();
  });

  it('is not extended or cleared by hold skips, dry runs or requested-page rows', () => {
    const db = freshDb();
    run(db, '2026-06-02T05:00:00.000Z', {});
    run(db, '2026-06-03T05:00:00.000Z', { outcome: 'skipped_failure_hold', usage: undefined });
    run(db, '2026-06-03T06:00:00.000Z', { outcome: 'written', evidenceHash: 'h3' }, true);
    recordRun(db, requestedPageRunRow({ project: 'P', title: 'Page', outcome: 'written', dryRun: false } as never,
      { ...CTX, ts: '2026-06-03T07:00:00.000Z' }));
    expect(paidFailureHash(db, 'P', SINCE)).toBe('h1');
  });
});

describe('requestedPageRunRow', () => {
  const ctx = { trigger: 'on-demand' as const, durationMs: 1200, ts: '2026-06-11T00:00:00Z' };

  it('maps a successful fulfillment', () => {
    const row = requestedPageRunRow({
      project: 'Demo', requestedTitle: 'X', qualifiedTitle: 'Demo — X',
      outcome: 'written', nodeId: 'n1', dryRun: false,
      usage: { input: 10, output: 5, cacheWrite: 1, cacheRead: 2 }, costUsd: 0.01,
    }, ctx);
    expect(row).toMatchObject({
      project: 'Demo', trigger: 'on-demand', outcome: 'requested_page',
      themed_created: 1, home_written: 0, spine_total: 0,
      input_tokens: 10, output_tokens: 5, cost_usd: 0.01, duration_ms: 1200, error: null,
    });
  });

  it('maps a failure with the detail as error', () => {
    const row = requestedPageRunRow({
      project: 'Demo', requestedTitle: 'X', qualifiedTitle: 'Demo — X',
      outcome: 'error', detail: 'boom', dryRun: false,
    }, ctx);
    expect(row.outcome).toBe('requested_page_error');
    expect(row.themed_created).toBe(0);
    expect(row.error).toBe('boom');
  });
});

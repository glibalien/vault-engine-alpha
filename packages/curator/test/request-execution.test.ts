import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { insertPageRequest } from '../src/db/requests.js';
import {
  clearRequestExecution, readRequestExecution, writeRequestExecution,
  type ActivePageRequestExecution, type PageRequestExecution,
} from '../src/db/request-execution.js';

let db: Database.Database;
let id: number;
const now = () => Date.now();
function active(over: Partial<ActivePageRequestExecution> = {}): ActivePageRequestExecution {
  const started = now();
  const generatedAt = new Date(started).toISOString();
  return {
    version: 1, generation: randomUUID(), projectId: 'project-1', runRef: randomUUID(), generatedAt,
    expiresAt: new Date(started + 60_000).toISOString(), phase: 'prepared',
    request: { title: 'Decisions', brief: 'Record decisions.' },
    snapshot: {
      config: {
        model: 'test-model', homeMaxTokens: 1000, bodyCharCap: 1000,
        semanticGapFillLimit: 2, curatorRequestedPagePrompt: 'Requested prompt',
        curatorProjectHomePrompt: 'Home prompt', curatorTopologyPrompt: 'Topology prompt',
        curatorCreateAdjudicationPrompt: 'Adjudication prompt', curatorPagePrompt: 'Page prompt',
        provenanceLimits: { requestBytes: 1_048_576, componentBytes: 262_144,
          outputBytes: 262_144, totalBytes: 2_097_152, itemCount: 512, leaseMs: 60_000 },
      },
      evidenceHash: 'hash-1', evidenceText: 'Evidence text', evidenceNodes: [],
      existingWiki: { home_id: null, home: null, topology_hash: 'topology', catalog_valid: true, subpages: [] },
      contextNodes: {},
    },
    calls: [], captures: [], ...over,
  };
}

describe('page request execution storage', () => {
  const diagnostics = { version: 1 as const, adapterAttempts: 1, sdkAttempts: 1,
    responses: [{ attempt: 0, contentKind: 'string' as const, usageKnown: true, requestId: 'x'.repeat(200) }] };
  it.each([false, true])('round-trips diagnostics, omitting only when the output cap requires it (%s)', tight => {
    const state = active();
    const result = { output: { body: 'saved' }, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    if (tight) state.snapshot.config.provenanceLimits.outputBytes = Buffer.byteLength(JSON.stringify(result));
    state.calls = [{ key: 'page', requestDigest: 'digest', state: 'result', result: { ...result, diagnostics } }];
    writeRequestExecution(db, id, null, state);
    const saved = readRequestExecution(db, id) as ActivePageRequestExecution;
    expect(saved.calls[0]!.result).toEqual(tight ? result : { ...result, diagnostics });
  });
  it('still reads a request saved while node facts froze them in the snapshot (#352)', () => {
    const state = active();
    writeRequestExecution(db, id, null, state);
    // A checkpoint written by the retired facts path (#383) carried snapshot.facts.
    const raw = JSON.parse((db.prepare('SELECT execution_json FROM page_requests WHERE id = ?').get(id) as { execution_json: string }).execution_json);
    raw.snapshot.facts = { facts: [{ id: 1, node_id: 'n1', content: 'x' }], hashes: { n1: 'h' } };
    db.prepare('UPDATE page_requests SET execution_json = ? WHERE id = ?').run(JSON.stringify(raw), id);
    const saved = readRequestExecution(db, id) as ActivePageRequestExecution;
    expect(saved.generation).toBe(state.generation);
    expect(() => clearRequestExecution(db, id, saved.generation)).not.toThrow();
  });
  it('round-trips the conflict pairs, rule lookups, people and second-draft capture a requested page saves (#631)', () => {
    const state = active();
    const memory = { id: 9, source: 'curator', scope: 'vault' as const, node_id: null, content: 'Never name the pilot customer.',
      category: 'fact', created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z',
      valid_at: '2026-09-01T12:00:00Z', source_label: '2026-09-01, from a note' };
    Object.assign(state.snapshot, { memories: [memory], conflicts: [[7, 8]], ruleLookups: [{ ids: [9], memories: [memory] }, { ids: [10], memories: null }],
      contacts: { people: [{ id: 'person-1', title: 'Dana Reyes', companies: ['Acme'], direct: true, meeting_count: 2 }],
        companies: [{ id: 'company-1', title: 'Acme' }], unlinked: [{ name: 'Lee Park', direct: false, meeting_count: 1 }] } });
    const target = { plan_key: 'page' };
    state.captures = [{ flow: 'project-subpage-v1', target, attemptKey: randomUUID() },
      { flow: 'project-subpage-v1', target, attemptKey: randomUUID(), draft: 2 }];
    writeRequestExecution(db, id, null, state);
    expect(readRequestExecution(db, id)).toEqual(state);
  });
  it.each([
    ['a second record for one draft', (state: ActivePageRequestExecution) => {
      state.captures = [{ flow: 'project-subpage-v1', target: { plan_key: 'page' }, attemptKey: randomUUID(), draft: 2 },
        { flow: 'project-subpage-v1', target: { plan_key: 'page' }, attemptKey: randomUUID(), draft: 2 }];
    }],
    ['a second draft of the home', (state: ActivePageRequestExecution) => {
      state.captures = [{ flow: 'project-home-v1', attemptKey: randomUUID(), draft: 2 }];
    }],
    ['a third draft', (state: ActivePageRequestExecution) => {
      state.captures = [{ flow: 'project-subpage-v1', target: { plan_key: 'page' }, attemptKey: randomUUID(), draft: 3 as never }];
    }],
    ['a conflict pair that is not two memory ids', (state: ActivePageRequestExecution) => {
      Object.assign(state.snapshot, { conflicts: [[7]] });
    }],
    ['an empty rule lookup', (state: ActivePageRequestExecution) => {
      Object.assign(state.snapshot, { ruleLookups: [{ ids: [], memories: [] }] });
    }],
    ['a saved person with more than the people blocks read', (state: ActivePageRequestExecution) => {
      Object.assign(state.snapshot, { contacts: { people: [{ id: 'person-1', title: 'Dana Reyes', companies: [], direct: false,
        meeting_count: 0, last_seen: 1 }], companies: [] } });
    }],
  ])('rejects %s (#631)', (_name, change) => {
    const state = active();
    change(state);
    expect(() => writeRequestExecution(db, id, null, state)).toThrow('REQUEST_EXECUTION_INVALID');
  });
  it('rejects malformed diagnostic fields rather than tolerating an invalid checkpoint', () => {
    const state = active();
    state.calls = [{ key: 'page', requestDigest: 'digest', state: 'result', result: {
      output: {}, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      diagnostics: { ...diagnostics, rawText: 'secret' } as never,
    } }];
    expect(() => writeRequestExecution(db, id, null, state)).toThrow('REQUEST_EXECUTION_INVALID');
  });
  it('discards diagnostics before exceeding the total checkpoint cap', () => {
    const state = active();
    const result = { output: {}, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    state.calls = [{ key: 'page', requestDigest: 'digest', state: 'result', result }];
    Object.assign(state.snapshot.config.provenanceLimits, { totalBytes: 1800, requestBytes: 1000, componentBytes: 1000, outputBytes: 1000 });
    state.snapshot.evidenceText = 'x'.repeat(500);
    // Set the exact boundary after JSON number width stabilizes.
    for (let i = 0; i < 3; i++) state.snapshot.config.provenanceLimits.totalBytes = Buffer.byteLength(JSON.stringify(state));
    state.calls[0]!.result = { ...result, diagnostics };
    writeRequestExecution(db, id, null, state);
    expect((readRequestExecution(db, id) as ActivePageRequestExecution).calls[0]!.result).toEqual(result);
  });
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    id = insertPageRequest(db, {
      project_node_id: 'project-1', project_title: 'Project', title: 'Decisions',
      page_title: 'Project — Decisions', brief: 'Record decisions.', requested_by: null,
      created_at: new Date(now()).toISOString(),
    });
  });
  afterEach(() => { vi.useRealTimers(); db.close(); });

  it('round-trips a complete stage policy and rejects a mismatched model', () => {
    const state = active();
    const stage = { maxTokens: 32000, configuration: { provider: 'openrouter', reasoningEffort: 'low' } };
    Object.assign(state.snapshot.config, { wikiOutputPolicy: { version: 1, model: 'test-model', planning: stage, page: stage, home: stage } });
    writeRequestExecution(db, id, null, state);
    expect(readRequestExecution(db, id)).toEqual(state);
    Object.assign(state.snapshot.config, { wikiOutputPolicy: { version: 1, model: 'different', planning: stage, page: stage, home: stage } });
    expect(() => writeRequestExecution(db, id, state.generation, state)).toThrow('REQUEST_EXECUTION_INVALID');
  });

  it.each([
    { provider: 'openrouter', reasoningEffort: 'low' },
    { provider: 'fireworks', reasoningEffort: null },
    { provider: 'openrouter', reasoningEffort: null, reasoningBudget: 6000 },
  ] as const)('round-trips frozen non-secret configuration %j', llmConfiguration => {
    const state = active(); state.snapshot.config.llmConfiguration = llmConfiguration;
    writeRequestExecution(db, id, null, state);
    expect(readRequestExecution(db, id)).toEqual(state);
  });

  it.each([
    { provider: 'openrouter', reasoningEffort: null, apiKey: 'secret' },
    { provider: 'unknown', reasoningEffort: null },
    { provider: 'openrouter' },
    { provider: 'openrouter', reasoningEffort: null, reasoningBudget: 0 },
    { provider: 'openrouter', reasoningEffort: null, reasoningBudget: '6000' },
  ])('rejects secret or incomplete frozen configuration %j', llmConfiguration => {
    const state = active();
    Object.assign(state.snapshot.config, { llmConfiguration });
    expect(() => writeRequestExecution(db, id, null, state)).toThrow('REQUEST_EXECUTION_INVALID');
    expect(readRequestExecution(db, id)).toBeNull();
  });

  it('writes a checkpoint and rejects a stale generation on write and clear', () => {
    const first = active();
    writeRequestExecution(db, id, null, first);
    expect(readRequestExecution(db, id)).toEqual(first);
    const second = active();
    writeRequestExecution(db, id, first.generation, second);
    expect(() => clearRequestExecution(db, id, first.generation)).toThrow('REQUEST_EXECUTION_CONFLICT');
    expect(() => writeRequestExecution(db, id, first.generation, first)).toThrow('REQUEST_EXECUTION_CONFLICT');
    expect(readRequestExecution(db, id)).toEqual(second);
    clearRequestExecution(db, id, second.generation);
    expect(readRequestExecution(db, id)).toBeNull();
  });

  it('preserves a sent-without-result call across close and reopen without resetting it to ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-execution-'));
    const path = join(dir, 'curator.db');
    try {
      const durable = new Database(path);
      runMigrations(durable);
      const durableId = insertPageRequest(durable, {
        project_node_id: 'project-1', project_title: 'Project', title: 'Decisions',
        page_title: 'Project — Decisions', brief: null, requested_by: null,
        created_at: new Date(now()).toISOString(),
      });
      writeRequestExecution(durable, durableId, null, active({
        phase: 'sent', calls: [{ key: 'planner:validation:1', requestDigest: 'sha256:abc', state: 'sent' }],
      }));
      durable.close();
      const reopened = new Database(path);
      const recovered = readRequestExecution(reopened, durableId);
      expect(recovered?.phase).toBe('sent');
      if (recovered?.phase !== 'sent') throw new Error('sent checkpoint lost');
      expect(recovered.calls).toEqual([{ key: 'planner:validation:1', requestDigest: 'sha256:abc', state: 'sent' }]);
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects corrupt and expired checkpoints instead of treating them as fresh', () => {
    db.prepare('UPDATE page_requests SET execution_json=? WHERE id=?').run('{bad json', id);
    expect(() => readRequestExecution(db, id)).toThrow('REQUEST_EXECUTION_INVALID');
    db.prepare('UPDATE page_requests SET execution_json=NULL WHERE id=?').run(id);
    const expired = active({ expiresAt: new Date(now() - 1000).toISOString() });
    expect(() => writeRequestExecution(db, id, null, expired)).toThrow('REQUEST_EXECUTION_EXPIRED');
    db.prepare('UPDATE page_requests SET execution_json=? WHERE id=?').run(JSON.stringify(expired), id);
    expect(() => readRequestExecution(db, id)).toThrow('REQUEST_EXECUTION_EXPIRED');
  });

  it('exposes only generation on expired reads and allows generation-checked redaction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const first = active();
    writeRequestExecution(db, id, null, first);
    vi.setSystemTime(new Date('2026-09-25T12:02:00.000Z'));
    let expired: unknown;
    try { readRequestExecution(db, id); } catch (error) { expired = error; }
    expect(expired).toBeInstanceOf(Error);
    expect((expired as Error).name).toBe('RequestExecutionExpiredError');
    expect((expired as Error & { generation: string }).generation).toBe(first.generation);
    expect(Object.keys(expired as object)).toEqual(['generation']);
    expect(() => writeRequestExecution(db, id, first.generation, active())).toThrow('REQUEST_EXECUTION_EXPIRED');
    expect(() => clearRequestExecution(db, id, randomUUID())).toThrow('REQUEST_EXECUTION_CONFLICT');

    writeRequestExecution(db, id, first.generation, {
      version: 1, generation: first.generation, projectId: first.projectId, runRef: first.runRef,
      generatedAt: first.generatedAt, phase: 'failed', errorCode: 'CAPTURE_EXPIRED',
    });
    expect(readRequestExecution(db, id)?.phase).toBe('failed');
    const raw = db.prepare('SELECT execution_json FROM page_requests WHERE id=?').get(id) as { execution_json: string };
    expect(raw.execution_json).not.toContain('Evidence text');
    clearRequestExecution(db, id, first.generation);
    expect(readRequestExecution(db, id)).toBeNull();
  });

  it('clears an expired active checkpoint directly with its generation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    const first = active();
    writeRequestExecution(db, id, null, first);
    vi.setSystemTime(new Date('2026-09-25T12:02:00.000Z'));
    clearRequestExecution(db, id, first.generation);
    expect(readRequestExecution(db, id)).toBeNull();
  });

  it('fails closed when persisted material exceeds its effective component budget', () => {
    const execution = active();
    execution.snapshot.config.provenanceLimits.componentBytes = 128;
    execution.snapshot.evidenceText = 'x'.repeat(129);
    db.prepare('UPDATE page_requests SET execution_json=? WHERE id=?').run(JSON.stringify(execution), id);
    expect(() => readRequestExecution(db, id)).toThrow('REQUEST_EXECUTION_BUDGET');
  });

  it('accepts the Engine maximum configured lease of 168 hours', () => {
    const base = active();
    const leaseMs = 168 * 60 * 60 * 1000;
    const execution = active({ ...base, expiresAt: new Date(Date.parse(base.generatedAt) + leaseMs).toISOString(),
      snapshot: { ...base.snapshot, config: { ...base.snapshot.config,
        provenanceLimits: { ...base.snapshot.config.provenanceLimits, leaseMs } } } });
    writeRequestExecution(db, id, null, execution);
    expect(readRequestExecution(db, id)).toEqual(execution);
  });

  it('rejects an unallowlisted config field and duplicate call keys', () => {
    const base = active();
    const badConfig = { ...base, snapshot: { ...base.snapshot,
      config: { ...base.snapshot.config, apiKey: 'secret' } } } as PageRequestExecution;
    expect(() => writeRequestExecution(db, id, null, badConfig)).toThrow('REQUEST_EXECUTION_INVALID');
    const duplicate = active({ calls: [
      { key: 'planner:validation:1', requestDigest: 'a', state: 'ready' },
      { key: 'planner:validation:1', requestDigest: 'b', state: 'ready' },
    ] });
    expect(() => writeRequestExecution(db, id, null, duplicate)).toThrow('REQUEST_EXECUTION_INVALID');
  });

  it('enforces component, output, request, and total budgets before a write', () => {
    const base = active();
    const limits = { ...base.snapshot.config.provenanceLimits, componentBytes: 128,
      outputBytes: 128, requestBytes: 256, totalBytes: 4096 };
    const config = { ...base.snapshot.config, provenanceLimits: limits };
    const cases: ActivePageRequestExecution[] = [
      active({ snapshot: { ...base.snapshot, config, evidenceText: 'x'.repeat(129) } }),
      active({ snapshot: { ...base.snapshot, config }, calls: [{ key: 'planner:0', requestDigest: 'a',
        state: 'result', result: { output: 'x'.repeat(129), usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } } }] }),
      active({ snapshot: { ...base.snapshot, config }, reconcile: {
        project: 'x'.repeat(257), reconcile_key: 'key', pages: [],
        home: { sections: [], evidence_hash: 'hash', curated_at: base.generatedAt, refresh_live: true },
      } }),
      active({ snapshot: { ...base.snapshot, config: { ...config, provenanceLimits: { ...limits, totalBytes: 600 } } } }),
    ];
    for (const execution of cases) {
      expect(() => writeRequestExecution(db, id, null, execution)).toThrow('REQUEST_EXECUTION_BUDGET');
      expect(db.prepare('SELECT execution_json FROM page_requests WHERE id=?').get(id)).toEqual({ execution_json: null });
    }
  });

  it('bounds reconciliation results by the Engine replay limit and effective total budget', () => {
    const execution = active();
    execution.snapshot.config.provenanceLimits.outputBytes = 128;
    execution.result = {
      operation_id: 'op', reconcile_key: 'key', dry_run: false, plan_digest: 'digest', reused: false,
      created: [], updated: [], mappings: [], topology_hash: 'hash', warnings: [],
      preview: { total: 0, items: [], truncated: false },
      home: { node_id: 'home', title: 'Home', file_path: 'Home.md', version: 1, created: false },
    };
    const initialBytes = Buffer.byteLength(JSON.stringify(execution.result));
    execution.result = { ...execution.result, topology_hash: 'hash' + 'x'.repeat(65_536 - initialBytes) };
    expect(Buffer.byteLength(JSON.stringify(execution.result))).toBe(65_536);
    writeRequestExecution(db, id, null, execution);
    expect(readRequestExecution(db, id)).toEqual(execution);
    execution.result = { ...execution.result, reused: true,
      current_output: 'matches', current_outputs: { 'output-1': 'matches', 'output-2': 'changed' } };
    expect(Buffer.byteLength(JSON.stringify(execution.result))).toBeGreaterThan(65_536);
    writeRequestExecution(db, id, execution.generation, execution);
    expect(readRequestExecution(db, id)).toEqual(execution);
    execution.result = { ...execution.result, topology_hash: execution.result.topology_hash + 'x' };
    expect(() => writeRequestExecution(db, id, execution.generation, execution)).toThrow('REQUEST_EXECUTION_BUDGET');
    execution.result = { ...execution.result, topology_hash: 'hash' };
    execution.snapshot.config.provenanceLimits = {
      ...execution.snapshot.config.provenanceLimits, componentBytes: 512,
      requestBytes: 1024, totalBytes: 1024,
    };
    expect(() => writeRequestExecution(db, id, execution.generation, execution)).toThrow('REQUEST_EXECUTION_BUDGET');
  });

  it('uses the earliest capture lease and keeps only receipt references in terminal records', () => {
    const base = active();
    const shortLease = new Date(now() + 20_000).toISOString();
    const capture = { flow: 'project-subpage-v1' as const, attemptKey: randomUUID(),
      receipt: { derivation_id: 'd1', bundle_digest: 'digest', state: 'prepared' as const,
        availability: 'retained' as const, lease_expires_at: shortLease } };
    expect(() => writeRequestExecution(db, id, null, active({ ...base, captures: [capture] }))).toThrow('REQUEST_EXECUTION_EXPIRY');
    const terminal: PageRequestExecution = {
      version: 1, generation: base.generation, projectId: base.projectId, runRef: base.runRef,
      generatedAt: base.generatedAt, phase: 'committed', receipts: [{
        derivation_id: 'd1', output_revision_id: 'o1', output_node_id: 'n1',
        committed_node_version: 1, committed_at: base.generatedAt,
        operation_id: 'op1', reconcile_key: 'r1', request_digest: 'digest',
      }], mappings: [],
    };
    writeRequestExecution(db, id, null, terminal);
    const raw = db.prepare('SELECT execution_json FROM page_requests WHERE id=?').get(id) as { execution_json: string };
    expect(raw.execution_json).not.toContain('Evidence text');
    expect(readRequestExecution(db, id)).toEqual(terminal);
    expect(() => writeRequestExecution(db, id, base.generation,
      { ...terminal, snapshot: base.snapshot } as PageRequestExecution)).toThrow('REQUEST_EXECUTION_INVALID');
  });

  it('refuses to retain a stage request after Engine confirms result staging', () => {
    const prepared = active();
    const capture = {
      flow: 'project-subpage-v1' as const, attemptKey: randomUUID(),
      receipt: { derivation_id: 'd1', bundle_digest: 'digest', state: 'result_staged' as const,
        availability: 'retained' as const, lease_expires_at: prepared.expiresAt },
      stageRequest: { derivation_id: 'd1', bundle_digest: 'digest', validated_sections: { Summary: 'Body' },
        contribution: [{ name: 'Summary', mode: 'replace' as const, content: 'Body' }],
        generated_at: prepared.generatedAt, log_stamp: 'stamp' },
    };
    expect(() => writeRequestExecution(db, id, null, active({ ...prepared, captures: [capture] })))
      .toThrow('REQUEST_EXECUTION_INVALID');
  });

  it('does not revive a terminal execution or trust a checkpoint for another project', () => {
    const base = active();
    writeRequestExecution(db, id, null, {
      version: 1, generation: base.generation, projectId: base.projectId, runRef: base.runRef,
      generatedAt: base.generatedAt, phase: 'failed', errorCode: 'CAPTURE_EXPIRED',
    });
    expect(() => writeRequestExecution(db, id, base.generation, active())).toThrow('REQUEST_EXECUTION_CONFLICT');
    db.prepare('UPDATE page_requests SET execution_json=? WHERE id=?').run(
      JSON.stringify({ ...base, projectId: 'other-project' }), id,
    );
    expect(() => readRequestExecution(db, id)).toThrow('REQUEST_EXECUTION_CONFLICT');
  });

  it('bounds terminal receipt references by the effective item maximum', () => {
    const base = active();
    const receipt = {
      derivation_id: 'd1', output_revision_id: 'o1', output_node_id: 'n1',
      committed_node_version: 1, committed_at: base.generatedAt, operation_id: 'op1',
      reconcile_key: 'r1', request_digest: 'digest',
    };
    expect(() => writeRequestExecution(db, id, null, {
      version: 1, generation: base.generation, projectId: base.projectId, runRef: base.runRef,
      generatedAt: base.generatedAt, phase: 'committed', receipts: Array(513).fill(receipt),
    })).toThrow('REQUEST_EXECUTION_INVALID');
  });

  it('inherits reduced item and total budgets when terminalizing an active checkpoint', () => {
    const base = active();
    const limits = { ...base.snapshot.config.provenanceLimits,
      componentBytes: 512, requestBytes: 1024, outputBytes: 512,
      itemCount: 1, totalBytes: 2048 };
    const first = active({ ...base, snapshot: { ...base.snapshot,
      config: { ...base.snapshot.config, provenanceLimits: limits } } });
    writeRequestExecution(db, id, null, first);
    const receipt = {
      derivation_id: 'd1', output_revision_id: 'o1', output_node_id: 'n1',
      committed_node_version: 1, committed_at: first.generatedAt,
      operation_id: 'op1', reconcile_key: 'r1', request_digest: 'digest',
    };
    const terminal = { version: 1 as const, generation: first.generation, projectId: first.projectId,
      runRef: first.runRef, generatedAt: first.generatedAt, phase: 'committed' as const };
    expect(() => writeRequestExecution(db, id, first.generation,
      { ...terminal, generation: randomUUID(), receipts: [receipt] }))
      .toThrow('REQUEST_EXECUTION_CONFLICT');
    expect(() => writeRequestExecution(db, id, first.generation,
      { ...terminal, receipts: [receipt, receipt] })).toThrow('REQUEST_EXECUTION_BUDGET');
    expect(() => writeRequestExecution(db, id, first.generation,
      { ...terminal, mappings: [{ source_node_id: 'n1', target_node_id: 'n2',
        target_title: 'x'.repeat(2048) }] })).toThrow('REQUEST_EXECUTION_BUDGET');
    writeRequestExecution(db, id, first.generation, { ...terminal, receipts: [receipt] });
    expect(() => writeRequestExecution(db, id, first.generation,
      { ...terminal, receipts: [receipt, receipt] })).toThrow('REQUEST_EXECUTION_CONFLICT');
  });

  it('caps combined references on a direct terminal insert', () => {
    const base = active();
    const receipt = {
      derivation_id: 'd1', output_revision_id: 'o1', output_node_id: 'n1',
      committed_node_version: 1, committed_at: base.generatedAt, operation_id: 'op1',
      reconcile_key: 'r1', request_digest: 'digest',
    };
    expect(() => writeRequestExecution(db, id, null, {
      version: 1, generation: base.generation, projectId: base.projectId, runRef: base.runRef,
      generatedAt: base.generatedAt, phase: 'committed', receipts: Array(512).fill(receipt),
      mappings: [{ source_node_id: 'n1', target_node_id: 'n2', target_title: 'Next' }],
    })).toThrow('REQUEST_EXECUTION_BUDGET');
  });

  it('does not dispatch after a durable checkpoint write fails', () => {
    let dispatched = false;
    const execution = active();
    db.exec(`CREATE TRIGGER reject_execution BEFORE UPDATE OF execution_json ON page_requests
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;`);
    const invoke = () => { writeRequestExecution(db, id, null, execution); dispatched = true; };
    expect(invoke).toThrow('simulated storage failure');
    expect(dispatched).toBe(false);
  });
});

it('rejects unbounded or unknown frozen attribution fields and erases attribution at completion', () => {
  const base = active();
  const item = { key: 'request', observation: null, role: 'generated_context' as const, upstream_derivation_id: null,
    selection: 'request:v1', spans: [{ field: 'evidence', start: 0, end: 1 }], original_bytes: null, retained_bytes: 1,
    input_digest: `sha256:json-v1:${'a'.repeat(64)}`, truncated: false, origin: 'opaque' as const };
  const snapshot = { ...base.snapshot, homeAttribution: { items: [item], omissions: [] } };
  const local = new Database(':memory:'); runMigrations(local);
  const request = insertPageRequest(local, { project_node_id: 'project-1', project_title: 'Project', title: 'Page',
    page_title: 'Project — Page', brief: null, requested_by: null, created_at: base.generatedAt });
  try {
    expect(() => writeRequestExecution(local, request, null, { ...base, snapshot: { ...snapshot,
      homeAttribution: { items: [{ ...item, credentials: 'should never persist' }], omissions: [] } } } as unknown as ActivePageRequestExecution))
      .toThrow('REQUEST_EXECUTION_INVALID');
    expect(() => writeRequestExecution(local, request, null, { ...base, snapshot: { ...snapshot,
      homeAttribution: { items: Array(513).fill(item), omissions: [] } } })).toThrow();
    // Frozen memories (#313) keep only the fields their rendered line reads.
    const memory = { id: 7, source: 'curator', scope: 'vault' as const, node_id: null, content: 'A fact.', category: 'fact',
      created_at: base.generatedAt, updated_at: base.generatedAt };
    expect(() => writeRequestExecution(local, request, null, { ...base, snapshot: { ...snapshot,
      memories: [{ ...memory, expired_at: null }] } } as unknown as ActivePageRequestExecution)).toThrow('REQUEST_EXECUTION_INVALID');
    writeRequestExecution(local, request, null, { ...base, snapshot: { ...snapshot, memories: [memory] } });
    expect((readRequestExecution(local, request) as ActivePageRequestExecution).snapshot.memories).toEqual([memory]);
    clearRequestExecution(local, request, base.generation);
    writeRequestExecution(local, request, null, { ...base, snapshot });
    writeRequestExecution(local, request, base.generation, { version: 1, generation: base.generation, projectId: base.projectId,
      runRef: base.runRef, generatedAt: base.generatedAt, phase: 'committed', receipts: [], mappings: [] });
    expect(readRequestExecution(local, request)).not.toHaveProperty('snapshot');
  } finally { local.close(); }
});

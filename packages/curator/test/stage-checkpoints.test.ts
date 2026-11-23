import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrate.js';
import { appendStagePage, readStageCheckpoint, stageCheckpointStore, writeStagePlanning } from '../src/db/stage-checkpoints.js';
import { checkpointStoreFor, parseStageCheckpoint, reusablePages, reusedPlanning, stageFingerprint, type StageCheckpointPage,
  type StageFingerprintInput } from '../src/stage-checkpoints.js';
import type { PlanningResult } from '../src/reconciliation-planning.js';
import type { Engine } from '../src/engine.js';

const plan = { reviewed_page_ids: [], actions: [] };
const planning = { proposedPlan: plan, plan, attempts: [], droppedCreates: [], keptByDefault: [], longBriefs: [], validationIssueCodes: [],
  adjudication: { results: [], warnings: [], verdicts: [] },
  plannerUsage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
  adjudicatorUsage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } } as unknown as PlanningResult;
const page = (planKey: string, extra: Partial<StageCheckpointPage> = {}): StageCheckpointPage => ({
  result: { target: { plan_key: planKey }, body: `Body ${planKey}`, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }, ...extra,
});
const t0 = new Date('2026-10-25T12:00:00Z');
const hoursLater = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);

function db() { const d = new Database(':memory:'); runMigrations(d); return d; }

describe('stage checkpoint storage', () => {
  it('returns the checkpoint for the same fingerprint and keeps pages in order', () => {
    const d = db();
    writeStagePlanning(d, 'Project', 'fp', planning, t0);
    expect(appendStagePage(d, 'Project', 'fp', page('a'))).toBe(true);
    expect(appendStagePage(d, 'Project', 'fp', page('b'))).toBe(true);
    const checkpoint = readStageCheckpoint(d, 'Project', 'fp', hoursLater(1));
    expect(checkpoint?.planning.plannerUsage).toEqual(planning.plannerUsage);
    expect(checkpoint?.pages.map(p => p.result.body)).toEqual(['Body a', 'Body b']);
  });

  it('drops a checkpoint written for other inputs, an expired one, or an unreadable one', () => {
    const d = db();
    writeStagePlanning(d, 'Project', 'fp', planning, t0);
    expect(readStageCheckpoint(d, 'Project', 'other', t0)).toBeNull();
    expect(readStageCheckpoint(d, 'Project', 'fp', t0)).toBeNull();

    writeStagePlanning(d, 'Project', 'fp', planning, t0);
    expect(readStageCheckpoint(d, 'Project', 'fp', hoursLater(24))).toBeNull();
    expect(d.prepare('SELECT COUNT(*) AS c FROM wiki_stage_checkpoints').get()).toEqual({ c: 0 });

    writeStagePlanning(d, 'Project', 'fp', planning, t0);
    d.prepare("UPDATE wiki_stage_checkpoints SET planning_json = '{\"plan\":{}}'").run();
    expect(readStageCheckpoint(d, 'Project', 'fp', t0)).toBeNull();
    expect(d.prepare('SELECT COUNT(*) AS c FROM wiki_stage_checkpoints').get()).toEqual({ c: 0 });
  });

  it('adds pages only to a checkpoint for the same inputs, and a new planning stage starts over', () => {
    const d = db();
    expect(appendStagePage(d, 'Project', 'fp', page('a'))).toBe(false);
    writeStagePlanning(d, 'Project', 'fp', planning, t0);
    expect(appendStagePage(d, 'Project', 'other', page('a'))).toBe(false);
    appendStagePage(d, 'Project', 'fp', page('a'));
    writeStagePlanning(d, 'Project', 'fp2', planning, t0);
    expect(readStageCheckpoint(d, 'Project', 'fp2', t0)?.pages).toEqual([]);
  });

  it('keeps each wiki root separate', () => {
    const d = db();
    writeStagePlanning(d, 'A', 'fp', planning, t0);
    writeStagePlanning(d, 'B', 'fp', planning, t0);
    expect(readStageCheckpoint(d, 'A', 'other', t0)).toBeNull();
    expect(readStageCheckpoint(d, 'B', 'fp', t0)).not.toBeNull();
  });

  it('turns storage failures into warnings so the run continues without reuse', () => {
    const d = db();
    const warn = vi.fn();
    const store = stageCheckpointStore(d, 'Project', warn);
    d.close();
    expect(store.load('fp')).toBeNull();
    expect(store.savePlanning('fp', planning)).toBe(false);
    expect(store.savePage('fp', page('a'))).toBe(false);
    expect(() => store.clear()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe('stage fingerprint and reuse', () => {
  const inputs: StageFingerprintInput = {
    wikiRootId: 'p', rootTitle: 'Project', evidenceHash: 'h', evidenceText: 'Evidence', evidenceNodes: [{ id: 'n', title: 'N' }],
    existingWiki: { home_id: null, subpages: [] }, planningPolicy: { model: 'm', maxTokens: 1 }, pagePolicy: { model: 'm', maxTokens: 2 },
    prompts: { topology: undefined, page: 'p' }, pageLimits: { maxActivePages: Number.POSITIVE_INFINITY }, bodyCharCap: null, provenance: true,
  };

  it('is stable across key order and changes with any input', () => {
    const reordered = { ...inputs, evidenceNodes: [{ title: 'N', id: 'n' }], planningPolicy: { maxTokens: 1, model: 'm' } };
    expect(stageFingerprint(reordered)).toBe(stageFingerprint(inputs));
    expect(stageFingerprint({ ...inputs, evidenceText: 'Other' })).not.toBe(stageFingerprint(inputs));
    expect(stageFingerprint({ ...inputs, pagePolicy: { model: 'm2', maxTokens: 2 } })).not.toBe(stageFingerprint(inputs));
    expect(stageFingerprint({ ...inputs, provenance: false })).not.toBe(stageFingerprint(inputs));
  });

  it('ignores observation read times but not the observed content', () => {
    const observed = (observedAt: string, digest: string) => ({ ...inputs, evidenceNodes: [{ id: 'n',
      provenance_observation: { observed_at: observedAt, observation_digest: digest } }] });
    expect(stageFingerprint(observed('2026-10-25T12:00:00Z', 'd1'))).toBe(stageFingerprint(observed('2026-10-25T12:05:00Z', 'd1')));
    expect(stageFingerprint(observed('2026-10-25T12:00:00Z', 'd1'))).not.toBe(stageFingerprint(observed('2026-10-25T12:00:00Z', 'd2')));
  });

  it('checkpoints real project runs only', () => {
    const store = stageCheckpointStore(db(), 'Project', () => {});
    expect(checkpointStoreFor(store, { dryRun: false, topic: false })).toBe(store);
    expect(checkpointStoreFor(store, { dryRun: true, topic: false })).toBeUndefined();
    expect(checkpointStoreFor(store, { dryRun: false, topic: true })).toBeUndefined();
  });

  it('zeroes the usage of reused planning', () => {
    expect(reusedPlanning(planning)).toMatchObject({ plannerUsage: { input: 0, output: 0 }, adjudicatorUsage: { input: 0, output: 0 } });
  });

  it('reads a checkpoint saved before keptByDefault existed as having none (#323)', () => {
    const { keptByDefault: _dropped, ...older } = planning as PlanningResult & { keptByDefault: unknown };
    expect(parseStageCheckpoint(JSON.stringify(older), '[]', t0.toISOString())?.planning.keptByDefault).toEqual([]);
  });

  it('reads a checkpoint saved before longBriefs existed as having none (#633)', () => {
    const { longBriefs: _dropped, ...older } = planning as PlanningResult & { longBriefs: unknown };
    expect(parseStageCheckpoint(JSON.stringify(older), '[]', t0.toISOString())?.planning.longBriefs).toEqual([]);
  });

  it('rejects stored pages without the expected shape', () => {
    expect(parseStageCheckpoint(JSON.stringify(planning), '[{"result":{"body":1}}]', t0.toISOString())).toBeNull();
    expect(parseStageCheckpoint('not json', '[]', t0.toISOString())).toBeNull();
  });

  it('reuses captured pages only while their staged derivation is bindable', async () => {
    const binding = { derivation_id: 'd1', bundle_digest: 'digest', contribution_digest: 'c' };
    const attempt = (overrides: Record<string, unknown> = {}) => ({ select: 'attempt', attempt: { derivation_id: 'd1', bundle_digest: 'digest',
      state: 'result_staged', availability: 'retained', lease_expires_at: hoursLater(1).toISOString(), output: null, ...overrides } });
    const engine = (response: unknown) => ({ inspectProvenance: vi.fn().mockImplementation(async () => {
      if (response instanceof Error) throw response;
      return response;
    }) }) as unknown as Pick<Engine, 'inspectProvenance'>;
    const captured = page('a', { attemptKey: 'k1', result: { ...page('a').result, provenance: binding } });
    expect((await reusablePages(engine(attempt()), [captured], true, t0)).get('plan:a')?.usage).toMatchObject({ input: 0, output: 0 });
    for (const response of [attempt({ state: 'failed' }), attempt({ availability: 'expired' }), attempt({ derivation_id: 'd2' }),
      attempt({ lease_expires_at: new Date(t0.getTime() + 60_000).toISOString() }), { select: 'attempt', attempt: null }, new Error('down')]) {
      expect((await reusablePages(engine(response), [captured], true, t0)).size).toBe(0);
    }
    expect((await reusablePages(engine(attempt()), [page('a')], true, t0)).size).toBe(0);
    expect((await reusablePages(engine(attempt()), [captured], false, t0)).size).toBe(0);
    expect((await reusablePages(engine(attempt()), [page('a')], false, t0)).has('plan:a')).toBe(true);
  });
});
